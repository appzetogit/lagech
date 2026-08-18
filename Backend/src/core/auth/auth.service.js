import crypto from "crypto";
import ms from "ms";
import { createOrUpdateOtp, verifyOtp } from "../otp/otp.service.js";
import { signAccessToken, signRefreshToken } from "./token.util.js";
import { ValidationError, AuthError } from "./errors.js";
import { config } from "../../config/env.js";
import { logger } from "../../utils/logger.js";
import { sendAdminResetOtpEmail } from "../../utils/email.js";
import { prisma } from "../../config/prisma.js";
import { isId } from "../../utils/helpers.js";
import { hashAdminPassword, compareAdminPassword } from "./adminPassword.util.js";
import { creditReferralReward } from "../../modules/food/user/services/userWallet.service.js";
import { ADMIN_FULL_PERMISSIONS, sanitizeAdminPermissions } from '../../constants/permissions.js';
import { isMobilePlatform } from "../../utils/platform.js";
import {
  detachFirebaseDeviceTokenEverywhere,
  replaceFirebaseDeviceToken,
  upsertFirebaseDeviceToken,
} from "../notifications/firebase.service.js";

const ROLES = {
  USER: "USER",
  RESTAURANT: "RESTAURANT",
  DELIVERY_PARTNER: "DELIVERY_PARTNER",
  ADMIN: "ADMIN",
};

/**
 * Roles whose sessions are single-device, and whose push tokens must therefore be
 * single-device too. Mirrors SESSION_SCOPED_MODELS in auth.middleware — admins are
 * excluded there because the panel is used across several tabs and machines, and
 * evicting those would be a regression rather than a safeguard.
 */
const SINGLE_DEVICE_ROLES = new Set([
  ROLES.USER,
  ROLES.RESTAURANT,
  ROLES.DELIVERY_PARTNER,
]);

const saveLoginFcmToken = async ({ ownerType, ownerId, fcmToken, platform, ownerDoc }) => {
  if (!fcmToken || !ownerId) return;
  try {
    // Logging in already invalidated every earlier session for this account. Its
    // push tokens have to go with it, or the signed-out device keeps receiving
    // pushes it can no longer act on.
    const save = SINGLE_DEVICE_ROLES.has(ownerType)
      ? replaceFirebaseDeviceToken
      : upsertFirebaseDeviceToken;

    await save({
      ownerType,
      ownerId: String(ownerId),
      token: fcmToken,
      platform,
    });
    // The Mongoose version re-read the token arrays here and un-marked them as
    // modified, so a later ownerDoc.save() could not clobber what
    // upsertFirebaseDeviceToken had just written. Prisma has no in-memory
    // document to save, so there is nothing left to protect against.
  } catch (err) {
    logger.warn({ err, ownerType, ownerId: String(ownerId) }, "Failed to save FCM token during login");
  }
};

/**
 * Invalidates every existing session for an account and returns the new version.
 *
 * Called on each successful login. The value goes into the JWT, and authMiddleware
 * rejects any token carrying an older one — so signing in on a new phone logs the
 * old one out on its very next request, instead of leaving one account live on two
 * devices.
 *
 * $inc is atomic, so two simultaneous logins get distinct versions and the later
 * one wins rather than both sharing a value.
 *
 * Deliberately NOT applied to admins: the panel is routinely used across several
 * browser tabs and machines, and evicting those would be a regression, not a
 * safeguard.
 */
const bumpTokenVersion = async (delegate, id) => {
  const updated = await delegate.update({
    where: { id: String(id) },
    data: { tokenVersion: { increment: 1 } },
    select: { tokenVersion: true },
  });
  return Number(updated?.tokenVersion) || 0;
};

export const requestUserOtp = async (phone) => {
  if (!phone) {
    throw new ValidationError("Phone is required");
  }

  const otp = await createOrUpdateOtp(phone);
  // TODO: integrate SMS provider here
  const shouldExposeOtp =
    config.nodeEnv !== "production" || config.useDefaultOtp;
  return shouldExposeOtp ? { otp } : {};
};

export const verifyUserOtpAndLogin = async (
  phone,
  otp,
  ref,
  fcmToken,
  platform,
  name,
) => {
  const result = await verifyOtp(phone, otp);

  if (!result.valid) {
    throw new AuthError(result.reason || "OTP verification failed");
  }

  let userDoc = await prisma.foodUser.findUnique({ where: { phone } });

  // Ensure user exists and mark as verified on successful OTP.
  // Check if user is new or hasn't provided a name yet
  const needsNamePrompt = !userDoc || !userDoc.name || String(userDoc.name).trim() === "" || String(userDoc.name).toLowerCase() === "null";
  const isNewUser = needsNamePrompt;
  const trimmedName = typeof name === "string" ? name.trim() : "";

  if (!userDoc) {
    // An upsert, not a create: two OTP verifications for the same phone landing
    // together would both see "no user" and both insert, and one would fail on
    // the unique phone rather than logging in.
    userDoc = await prisma.foodUser.upsert({
      where: { phone },
      create: { phone, isVerified: true, ...(trimmedName ? { name: trimmedName } : {}) },
      update: { isVerified: true },
    });
  } else {
    const patch = {};
    if (!userDoc.isVerified) patch.isVerified = true;
    // Only fills a blank name; it never overwrites one the customer already set.
    if (trimmedName && !userDoc.name) patch.name = trimmedName;
    if (Object.keys(patch).length) {
      userDoc = await prisma.foodUser.update({ where: { id: userDoc.id }, data: patch });
    }
  }

  // Block login for deactivated users
  if (userDoc.isActive === false) {
    throw new AuthError(
      "Your account has been deactivated. Please contact support.",
    );
  }

  // Update FCM token if provided
  if (fcmToken) {
    await saveLoginFcmToken({
      ownerType: ROLES.USER,
      ownerId: userDoc.id,
      fcmToken,
      platform,
      ownerDoc: userDoc,
    });
  }

  // Ensure referralCode exists (used for share links on older accounts).
  if (!userDoc.referralCode) {
    userDoc = await prisma.foodUser.update({
      where: { id: userDoc.id },
      data: { referralCode: userDoc.id },
    });
  }

  // Referral crediting: only for brand new accounts.
  const refRaw = typeof ref === "string" ? String(ref).trim() : "";
  if (isNewUser && refRaw) {
    try {
      if (isId(refRaw)) {
        const referrerId = refRaw;
        if (referrerId !== userDoc.id) {
          const [referrer, settingsDoc] = await Promise.all([
            prisma.foodUser.findUnique({
              where: { id: referrerId },
              select: { id: true, referralCount: true },
            }),
            prisma.foodReferralSettings.findFirst({
              where: { isActive: true },
              orderBy: { createdAt: "desc" },
            }),
          ]);

          if (referrer && settingsDoc) {
            const reward = Math.max(
              0,
              Number(settingsDoc.referralRewardUser) || 0,
            );
            const limit = Math.max(
              0,
              Number(settingsDoc.referralLimitUser) || 0,
            );

            if (
              reward > 0 &&
              limit > 0 &&
              Number(referrer.referralCount || 0) < limit
            ) {
              userDoc = await prisma.foodUser.update({
                where: { id: userDoc.id },
                data: { referredById: referrerId },
              });

              // The log is written FIRST: (refereeId, role) is unique, so it is
              // the lock. A second concurrent signup with the same ref fails here
              // and never pays a duplicate reward.
              const log = await prisma.foodReferralLog.create({
                data: {
                  referrerId,
                  refereeId: userDoc.id,
                  role: "USER",
                  rewardAmount: reward,
                  status: "credited",
                },
              });

              await Promise.all([
                prisma.foodUser.update({
                  where: { id: referrerId },
                  data: { referralCount: { increment: 1 } },
                }),
                creditReferralReward(referrerId, reward, {
                  role: "USER",
                  refereeId: userDoc.id,
                  referralLogId: log.id,
                }),
              ]);
            } else {
              await prisma.foodReferralLog.create({
                data: {
                  referrerId,
                  refereeId: userDoc.id,
                  role: "USER",
                  rewardAmount: reward,
                  status: "rejected",
                  reason:
                    reward <= 0
                      ? "reward_disabled"
                      : limit <= 0
                        ? "limit_disabled"
                        : "limit_reached",
                },
              });
            }
          }
        }
      }
    } catch (e) {
      // Never fail login due to referral errors.
      logger?.warn?.({ err: e }, "Referral crediting failed (user)");
    }
  }

  const user = userDoc;
  const payload = {
    userId: user.id,
    role: user.role || "USER",
    tokenVersion: await bumpTokenVersion(prisma.foodUser, user.id),
  };

  const accessToken = signAccessToken(payload);
  const refreshToken = signRefreshToken(payload);

  const ttlMs = ms(config.jwtRefreshExpiresIn || "7d");
  const expiresAt = new Date(Date.now() + ttlMs);

  await prisma.foodRefreshToken.create({
    data: { userId: user.id, token: refreshToken, expiresAt },
  });

  return { accessToken, refreshToken, user, isNewUser };
};

export const adminLogin = async (email, password) => {
  if (!email || !password) {
    throw new ValidationError("Email and password are required");
  }

  const admin = await prisma.foodAdmin.findUnique({ where: { email } });
  if (!admin) {
    throw new AuthError("Invalid credentials");
  }

  if (admin.isDeleted || admin.isActive === false) {
    throw new AuthError("Admin account is inactive");
  }

  const isMatch = await compareAdminPassword(password, admin.password);
  if (!isMatch) {
    throw new AuthError("Invalid credentials");
  }

  const effectivePermissions = admin.adminType === "super_admin"
    ? ADMIN_FULL_PERMISSIONS
    : sanitizeAdminPermissions(admin.permissions || {});

  const payload = {
    userId: admin.id,
    role: admin.role,
    adminType: admin.adminType || "super_admin",
  };

  const accessToken = signAccessToken(payload);
  const refreshToken = signRefreshToken(payload);

  const ttlMs = ms(config.jwtRefreshExpiresIn || "7d");
  const expiresAt = new Date(Date.now() + ttlMs);

  await prisma.foodRefreshToken.create({
    data: {
    userId: admin.id,
    token: refreshToken,
    expiresAt,
    },
  });

  const userObj = admin.toObject();
  delete userObj.password;
  userObj.effectivePermissions = effectivePermissions;
  return { accessToken, refreshToken, user: userObj };
};

export const requestRestaurantOtp = async (phone) => {
  if (!phone) {
    throw new ValidationError("Phone is required");
  }
  const otp = await createOrUpdateOtp(phone);
  // Only expose OTP in response when in default/dev mode — never in production with real SMS
  const shouldExposeOtp =
    config.nodeEnv !== "production" || config.useDefaultOtp;
  return shouldExposeOtp ? { otp } : {};
};

export const verifyRestaurantOtpAndLogin = async (phone, otp, fcmToken, platform) => {
  const result = await verifyOtp(phone, otp);
  if (!result.valid) {
    throw new AuthError(result.reason || "OTP verification failed");
  }

  // Restaurants may store ownerPhone with country code or formatting.
  // Match by exact phone, last-10 digits, or suffix match to avoid false "needsRegistration".
  const digits = String(phone || "").replace(/\D/g, "");
  const last10 = digits.slice(-10);
  const phoneCandidates = [phone, digits, last10].filter(Boolean);
  // Matches an exact candidate, or any stored number ending in the same last 10
  // digits — onboarding and OTP login normalise country codes differently.
  const phoneOrFields = (field) => [
    { [field]: { in: phoneCandidates } },
    ...(last10 ? [{ [field]: { endsWith: last10 } }] : []),
  ];

  const restaurant = await prisma.foodRestaurant.findFirst({
    where: {
      OR: [
        ...phoneOrFields("ownerPhone"),
        ...phoneOrFields("primaryContactNumber"),
      ],
    },
  });


  if (!restaurant) {
    // Phone has been successfully verified, but no restaurant exists yet.
    // Frontend will use this to redirect into registration/onboarding.
    return {
      needsRegistration: true,
      phone,
    };
  }

  // Update FCM token if provided
  if (fcmToken) {
    await saveLoginFcmToken({
      ownerType: ROLES.RESTAURANT,
      ownerId: restaurant.id,
      fcmToken,
      platform,
      ownerDoc: restaurant,
    });
  }

  // Allow login for previously-operational restaurants even if they are temporarily
  // moved to "pending" due to profile-change review requests.
  if (restaurant.status && restaurant.status !== "approved") {
    if (restaurant.status === "pending") {
      const hasHistoricalApproval = Boolean(restaurant.approvedAt);
      // exists() has no Prisma equivalent; findFirst selecting only the id is
      // the same single indexed lookup.
      const hasOperationalHistory = await prisma.foodOrder.findFirst({
        where: { restaurantId: restaurant.id },
        select: { id: true },
      });

      // New onboarding requests (no approval + no orders) must stay blocked.
      if (!hasHistoricalApproval && !hasOperationalHistory) {
        throw new AuthError("Your restaurant registration is pending approval.");
      }
    } else {
      throw new AuthError(
        "Your restaurant registration has been rejected. Please contact support.",
      );
    }
  }

  // Postpaid subscription model: no onboarding payment or subscription purchase
  // is required to use the platform — dues are billed at each month end.

  const payload = {
    userId: restaurant.id,
    role: ROLES.RESTAURANT,
    tokenVersion: await bumpTokenVersion(prisma.foodRestaurant, restaurant.id),
  };
  const accessToken = signAccessToken(payload);
  const refreshToken = signRefreshToken(payload);
  const ttlMs = ms(config.jwtRefreshExpiresIn || "7d");
  const expiresAt = new Date(Date.now() + ttlMs);

  await prisma.foodRefreshToken.create({
    data: {
    userId: restaurant.id,
    token: refreshToken,
    expiresAt,
    },
  });

  return {
    accessToken,
    refreshToken,
    user: restaurant,
    needsRegistration: false,
  };
};

export const requestDeliveryOtp = async (phone) => {
  if (!phone) {
    throw new ValidationError("Phone is required");
  }
  const otp = await createOrUpdateOtp(phone);
  // Only expose OTP in response when in default/dev mode — never in production with real SMS
  const shouldExposeOtp =
    config.nodeEnv !== "production" || config.useDefaultOtp;
  return shouldExposeOtp ? { otp } : {};
};

const normalizePhoneForDelivery = (phone) => {
  const digits = String(phone || "").replace(/\D/g, "");
  return digits.slice(-10) || null;
};

export const verifyDeliveryOtpAndLogin = async (phone, otp, fcmToken, platform) => {
  const result = await verifyOtp(phone, otp);
  if (!result.valid) {
    throw new AuthError(result.reason || "OTP verification failed");
  }

  const normalized = normalizePhoneForDelivery(phone);
  if (!normalized) {
    return { needsRegistration: true, phone };
  }

  const deliveryPartner = await prisma.foodDeliveryPartner.findFirst({
    where: {
      OR: [{ phone: normalized }, { phone: { endsWith: normalized } }],
    },
  });

  if (!deliveryPartner) {
    return { needsRegistration: true, phone };
  }

  // Update FCM token if provided - CRITICAL: do this BEFORE returning pendingApproval
  // so we can notify them when approved.
  if (fcmToken) {
    await saveLoginFcmToken({
      ownerType: ROLES.DELIVERY_PARTNER,
      ownerId: deliveryPartner.id,
      fcmToken,
      platform,
      ownerDoc: deliveryPartner,
    });
  }

  if (deliveryPartner.status && deliveryPartner.status !== "approved") {
    const isRejected = deliveryPartner.status === "rejected";
    return {
      pendingApproval: true,
      isRejected,
      rejectionReason: isRejected ? deliveryPartner.rejectionReason : null,
      message:
        isRejected
          ? (deliveryPartner.rejectionReason 
              ? `Your account was rejected: ${deliveryPartner.rejectionReason}`
              : "Your delivery account was not approved. Please contact support.")
          : "Your account is pending admin verification. You will be notified once approved.",
    };
  }

  const payload = {
    userId: deliveryPartner.id,
    role: ROLES.DELIVERY_PARTNER,
    tokenVersion: await bumpTokenVersion(prisma.foodDeliveryPartner, deliveryPartner.id),
  };
  const accessToken = signAccessToken(payload);
  const refreshToken = signRefreshToken(payload);
  const ttlMs = ms(config.jwtRefreshExpiresIn || "7d");
  const expiresAt = new Date(Date.now() + ttlMs);

  await prisma.foodRefreshToken.create({
    data: {
    userId: deliveryPartner.id,
    token: refreshToken,
    expiresAt,
    },
  });

  return {
    accessToken,
    refreshToken,
    user: deliveryPartner,
    needsRegistration: false,
  };
};

export const logout = async (refreshToken, fcmToken, platform) => {
  if (!refreshToken) {
    throw new ValidationError("Refresh token is required");
  }

  // 1. Remove specific FCM token from ALL collections if provided
  if (fcmToken) {
    try {
      await detachFirebaseDeviceTokenEverywhere(fcmToken);
    } catch (err) {
      logger.warn({ err }, "Failed to remove FCM token from all collections during logout");
    }
  }

  // 2. Invalidate the refresh token (standard logout procedure)
  const deleted = await prisma.foodRefreshToken.deleteMany({ where: { token: refreshToken } });
  return { invalidated: deleted.deletedCount > 0 };
};

export const getProfile = async (userId, role) => {
  if (!userId || !role) {
    throw new AuthError("Invalid token payload");
  }
  let profile = null;
  const id = userId;

  switch (role) {
    case ROLES.USER:
      profile = await prisma.foodUser.findUnique({ where: { id } });
      break;
    case ROLES.ADMIN:
      profile = await prisma.foodAdmin.findUnique({
        where: { id },
        // Never hand the password hash back to a caller.
        omit: { password: true },
      });
      if (profile) {
        profile.effectivePermissions = profile.adminType === "super_admin"
          ? ADMIN_FULL_PERMISSIONS
          : sanitizeAdminPermissions(profile.permissions || {});
      }
      break;
    case ROLES.RESTAURANT:
      {
        const doc = await prisma.foodRestaurant.findUnique({ where: { id } });
        if (!doc) break;

        const location =
          doc.addressLine1 ||
          doc.addressLine2 ||
          doc.area ||
          doc.city ||
          doc.state ||
          doc.pincode ||
          doc.landmark
            ? {
                addressLine1: doc.addressLine1 || "",
                addressLine2: doc.addressLine2 || "",
                area: doc.area || "",
                city: doc.city || "",
                state: doc.state || "",
                pincode: doc.pincode || "",
                landmark: doc.landmark || "",
              }
            : null;

        const menuImages = Array.isArray(doc.menuImages)
          ? doc.menuImages
              .map((m) => (m && (typeof m === "string" ? m : m.url)) || null)
              .filter(Boolean)
              .map((url) => ({ url, publicId: null }))
          : [];

        profile = {
          id: doc._id,
          _id: doc._id,
          // Frontend expects "name" and "location" for restaurant screens.
          name: doc.restaurantName || "",
          restaurantName: doc.restaurantName || "",
          cuisines: Array.isArray(doc.cuisines) ? doc.cuisines : [],
          location,
          ownerName: doc.ownerName || "",
          ownerEmail: doc.ownerEmail || "",
          ownerPhone: doc.ownerPhone || "",
          primaryContactNumber: doc.primaryContactNumber || "",
          profileImage: doc.profileImage ? { url: doc.profileImage } : null,
          menuImages,
          coverImages: [],
          openingTime: doc.openingTime || null,
          closingTime: doc.closingTime || null,
          openDays: Array.isArray(doc.openDays) ? doc.openDays : [],
          status: doc.status || null,
          createdAt: doc.createdAt,
          updatedAt: doc.updatedAt,
          // These fields may not exist yet in DB, keep stable defaults for UI.
          rating: typeof doc.rating === "number" ? doc.rating : 0,
          totalRatings:
            typeof doc.totalRatings === "number" ? doc.totalRatings : 0,
        };
      }
      break;
    case ROLES.DELIVERY_PARTNER: {
      const partner = await prisma.foodDeliveryPartner.findUnique({ where: { id } });
      if (!partner) break;
      const deliveryId = partner._id
        ? `DP-${partner._id.toString().slice(-8).toUpperCase()}`
        : null;
      profile = {
        ...partner,
        email: partner.email || null,
        deliveryId,
        status: partner.status === "rejected" ? "blocked" : partner.status,
        profileImage: partner.profilePhoto
          ? { url: partner.profilePhoto }
          : null,
        documents: {
          aadhar:
            partner.aadharPhoto || partner.aadharNumber
              ? {
                  number: partner.aadharNumber || null,
                  document: partner.aadharPhoto || null,
                }
              : null,
          pan:
            partner.panPhoto || partner.panNumber
              ? {
                  number: partner.panNumber || null,
                  document: partner.panPhoto || null,
                }
              : null,
          drivingLicense: partner.drivingLicensePhoto || partner.drivingLicenseNumber
            ? {
                number: partner.drivingLicenseNumber || null,
                document: partner.drivingLicensePhoto || null,
              }
            : null,
          bankDetails:
            partner.bankAccountHolderName ||
            partner.bankAccountNumber ||
            partner.bankIfscCode ||
            partner.bankName ||
            partner.upiId ||
            partner.upiQrCode
              ? {
                  accountHolderName: partner.bankAccountHolderName || null,
                  accountNumber: partner.bankAccountNumber || null,
                  ifscCode: partner.bankIfscCode || null,
                  bankName: partner.bankName || null,
                  upiId: partner.upiId || null,
                  upiQrCode: partner.upiQrCode || null,
                }
              : null,
        },
        location:
          partner.address || partner.city || partner.state
            ? {
                addressLine1: partner.address,
                city: partner.city,
                state: partner.state,
              }
            : null,
        vehicle:
          partner.vehicleType || partner.vehicleName || partner.vehicleNumber
            ? {
                type: partner.vehicleType,
                brand: partner.vehicleName,
                model: partner.vehicleName,
                number: partner.vehicleNumber,
              }
            : null,
      };
      break;
    }
    default:
      throw new AuthError("Unknown role");
  }

  if (!profile) {
    throw new AuthError("Profile not found");
  }
  return { user: profile };
};

const ADMIN_SERVICES_ALLOWED = ["food", "quickCommerce", "taxi"];

/** Update admin profile (name, email, phone, profileImage). Only for ADMIN role. */
export const updateAdminProfile = async (userId, body) => {
  if (!userId) {
    throw new AuthError("Invalid token payload");
  }
  const admin = await prisma.foodAdmin.findUnique({ where: { id: String(userId) } });
  if (!admin) {
    throw new AuthError("Profile not found");
  }

  const patch = {};
  if (body.name !== undefined) patch.name = String(body.name || "").trim();
  if (body.email !== undefined) {
    const normalizedEmail = String(body.email || "")
      .trim()
      .toLowerCase();
    if (!normalizedEmail) {
      throw new ValidationError("Email is required");
    }

    const emailRegex = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9\-]+(?:\.[a-zA-Z0-9\-]+)*\.[a-zA-Z]{2,10}$/;
    if (!emailRegex.test(normalizedEmail) || normalizedEmail.includes("..")) {
      throw new ValidationError("Invalid email format");
    }

    const domain = normalizedEmail.split("@")[1];
    const segments = domain ? domain.split(".") : [];
    if (segments.length >= 2 && segments[segments.length - 1] === segments[segments.length - 2]) {
      throw new ValidationError("Invalid email domain (repeated segments)");
    }

    if (normalizedEmail !== admin.email) {
      const duplicateAdmin = await prisma.foodAdmin.findFirst({
        where: { id: { not: admin.id }, email: normalizedEmail },
        select: { id: true },
      });
      if (duplicateAdmin) {
        throw new ValidationError("Email is already in use");
      }
    }
    patch.email = normalizedEmail;
  }
  if (body.phone !== undefined) patch.phone = String(body.phone || "").trim();
  if (body.profileImage !== undefined)
    patch.profileImage = String(body.profileImage || "").trim();

  // Normalise servicesAccess so legacy values (e.g. 'zomato') cannot fail the
  // enum on write.
  const services = Array.isArray(admin.servicesAccess)
    ? admin.servicesAccess.filter((v) => ADMIN_SERVICES_ALLOWED.includes(v))
    : [];
  patch.servicesAccess = services.length ? services : ["food"];

  const profile = await prisma.foodAdmin.update({
    where: { id: admin.id },
    data: patch,
    omit: { password: true },
  });
  return { user: profile };
};

/** Change admin password. Only for ADMIN role. */
export const changeAdminPassword = async (
  userId,
  currentPassword,
  newPassword,
) => {
  if (!userId) {
    throw new AuthError("Invalid token payload");
  }
  const admin = await prisma.foodAdmin.findUnique({ where: { id: String(userId) } });
  if (!admin) {
    throw new AuthError("Profile not found");
  }
  const isMatch = await compareAdminPassword(currentPassword, admin.password);
  if (!isMatch) {
    throw new AuthError("Current password is incorrect");
  }
  if (!newPassword || String(newPassword).length < 6) {
    throw new ValidationError("New password must be at least 6 characters");
  }
  // Hashed explicitly: the pre('save') hook that used to do this does not exist
  // in Prisma, and a missed call here stores the password in plaintext.
  await prisma.foodAdmin.update({
    where: { id: admin.id },
    data: { password: await hashAdminPassword(newPassword) },
  });

  try {
    const { notifyAdminsSafely } = await import("../../core/notifications/firebase.service.js");
    void notifyAdminsSafely({
      title: "Security Alert: Password Changed 🔐",
      body: `The password for admin account ${admin.email} has been changed. If this was not you, please contact support immediately.`,
      data: {
        type: "security_alert",
        subType: "password_change",
        email: admin.email
      }
    });
  } catch (e) {
    logger.error("Failed to notify admins of password change:", e);
  }

  return { success: true };
};

/** Admin forgot password: request OTP. Only accepts email that is registered as admin. */
export const requestAdminForgotPasswordOtp = async (email) => {
  const normalizedEmail = String(email || "")
    .trim()
    .toLowerCase();
  if (!normalizedEmail) {
    throw new ValidationError("Email is required");
  }

  const admin = await prisma.foodAdmin.findUnique({ where: { email: normalizedEmail } });
  if (!admin) {
    throw new AuthError("This email is not registered as an admin account.");
  }

  const otp = config.useDefaultOtp
    ? "123456"
    : String(crypto.randomInt(100000, 999999));
  const ttlMs = (config.otpExpiryMinutes || 10) * 60 * 1000;
  const expiresAt = new Date(Date.now() + ttlMs);

  // One live reset code per admin email, so requesting a new one replaces the
  // old rather than leaving two valid codes in play.
  await prisma.adminResetOtp.upsert({
    where: { email: normalizedEmail },
    create: { email: normalizedEmail, otp, expiresAt, attempts: 0 },
    update: { otp, expiresAt, attempts: 0 },
  });

  if (config.useDefaultOtp) {
    logger.info(`Admin reset OTP for ${normalizedEmail}: ${otp}`);
  }

  const sent = await sendAdminResetOtpEmail(normalizedEmail, otp);
  if (!sent && !config.useDefaultOtp) {
    logger.warn(
      `Admin OTP not sent by email to ${normalizedEmail}; check SMTP config.`,
    );
  }

  return {
    success: true,
    message: "If this email is registered, you will receive an OTP shortly.",
  };
};

/** Admin forgot password: verify OTP and set new password in one call. */
export const resetAdminPasswordWithOtp = async (email, otp, newPassword) => {
  const normalizedEmail = String(email || "")
    .trim()
    .toLowerCase();
  const otpStr = String(otp || "").replace(/\D/g, "");
  if (!normalizedEmail || !otpStr) {
    throw new ValidationError("Email and OTP are required");
  }
  if (!newPassword || String(newPassword).length < 6) {
    throw new ValidationError("New password must be at least 6 characters");
  }

  const record = await prisma.adminResetOtp.findUnique({ where: { email: normalizedEmail } });
  if (!record) {
    throw new AuthError("OTP not found or expired. Please request a new code.");
  }
  if (record.expiresAt < new Date()) {
    await prisma.adminResetOtp.deleteMany({ where: { email: normalizedEmail } });
    throw new AuthError("OTP has expired. Please request a new code.");
  }
  if (record.attempts >= (config.otpMaxAttempts || 5)) {
    throw new AuthError("Too many attempts. Please request a new code.");
  }
  if (record.otp !== otpStr) {
    // Incremented by the database so parallel guesses cannot share one attempt.
    await prisma.adminResetOtp.update({
      where: { id: record.id },
      data: { attempts: { increment: 1 } },
    });
    throw new AuthError("Invalid OTP.");
  }

  const admin = await prisma.foodAdmin.findUnique({ where: { email: normalizedEmail } });
  if (!admin) {
    await prisma.adminResetOtp.deleteMany({ where: { email: normalizedEmail } });
    throw new AuthError("Account not found.");
  }

  await prisma.foodAdmin.update({
    where: { id: admin.id },
    data: { password: await hashAdminPassword(newPassword) },
  });
  // The code is consumed, so it cannot be replayed.
  await prisma.adminResetOtp.deleteMany({ where: { email: normalizedEmail } });

  try {
    const { notifyAdminsSafely } = await import("../../core/notifications/firebase.service.js");
    void notifyAdminsSafely({
      title: "Security Alert: Password Reset Successful 🔐",
      body: `The password for admin account ${admin.email} has been reset via OTP.`,
      data: {
        type: "security_alert",
        subType: "password_reset",
        email: admin.email
      }
    });
  } catch (e) {
    logger.error("Failed to notify admins of password reset:", e);
  }

  return { success: true, message: "Password reset successfully." };
};

export const refreshAccessToken = async (token) => {
  if (!token) {
    throw new ValidationError("Refresh token is required");
  }

  const stored = await prisma.foodRefreshToken.findUnique({ where: { token } });
  if (!stored) {
    throw new AuthError("Invalid refresh token");
  }

  const jwt = await import("jsonwebtoken");
  let payload;
  try {
    payload = jwt.default.verify(token, config.jwtRefreshSecret);
  } catch {
    throw new AuthError("Invalid refresh token");
  }

  // If deactivated user, do not issue fresh access tokens (forces logout on client)
  if (payload?.role === "USER") {
    const u = await prisma.foodUser.findUnique({
      where: { id: String(payload.userId) },
      select: { isActive: true },
    });
    if (!u || u.isActive === false) {
      throw new AuthError("User account is deactivated");
    }
  }

  // Carry the session version forward, and refuse a refresh from a device that has
  // already been replaced. Without this, an evicted device could mint itself a
  // brand-new access token from its still-valid refresh token and stay signed in.
  const sessionDelegate = {
    USER: () => prisma.foodUser,
    RESTAURANT: () => prisma.foodRestaurant,
    DELIVERY_PARTNER: () => prisma.foodDeliveryPartner,
  }[payload?.role];

  let tokenVersion = payload?.tokenVersion;
  if (sessionDelegate) {
    const owner = await sessionDelegate().findUnique({
      where: { id: String(payload.userId) },
      select: { tokenVersion: true },
    });
    const stored = Number(owner?.tokenVersion) || 0;
    if (tokenVersion !== undefined && Number(tokenVersion) !== stored) {
      throw new AuthError(
        'You have been signed out because this account was used on another device',
      );
    }
    tokenVersion = stored;
  }

  const newAccessToken = signAccessToken({
    userId: payload.userId,
    role: payload.role,
    ...(tokenVersion !== undefined ? { tokenVersion } : {}),
    ...(payload.adminType ? { adminType: payload.adminType } : {}),
  });

  return { accessToken: newAccessToken, refreshToken: token };
};
