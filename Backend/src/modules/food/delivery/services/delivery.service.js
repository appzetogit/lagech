import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { uploadImageBuffer } from '../../../../services/cloudinary.service.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import { getDeliveryCashLimitSettings } from '../../admin/services/admin.service.js';
import { upsertFirebaseDeviceToken } from '../../../../core/notifications/firebase.service.js';
import { logger } from '../../../../utils/logger.js';
import { collectDynamicRegistration } from './driverRegistrationField.service.js';

const num = (v) => Number(v) || 0;

const savePartnerFcmToken = async (partnerId, fcmToken, platform) => {
    if (!fcmToken || !partnerId) return;
    try {
        await upsertFirebaseDeviceToken({
            ownerType: 'DELIVERY_PARTNER',
            ownerId: String(partnerId),
            token: fcmToken,
            platform,
        });
    } catch (err) {
        logger.warn({ err, partnerId: String(partnerId) }, 'Failed to save delivery partner FCM token');
    }
};

const requirePartner = async (userId) => {
    const partner = await prisma.foodDeliveryPartner.findUnique({ where: { id: String(userId) } });
    if (!partner) throw new ValidationError('Delivery partner not found');
    return partner;
};

export const registerDeliveryPartner = async (payload, files, rawBody = {}) => {
    const {
        name, phone, email, countryCode, address, city, state,
        vehicleType, vehicleName, vehicleNumber, drivingLicenseNumber, panNumber, aadharNumber,
        fcmToken, platform,
    } = payload;
    const refRaw = typeof payload?.ref === 'string' ? String(payload.ref).trim() : '';

    const existing = await prisma.foodDeliveryPartner.findUnique({ where: { phone } });
    if (existing) {
        if (existing.status !== 'rejected') {
            throw new ValidationError('Delivery partner with this phone already exists');
        }
        // Rejected: clear the old record so they can start fresh on the same phone.
        await prisma.foodDeliveryPartner.deleteMany({ where: { phone } });
    }

    if (vehicleNumber && String(vehicleNumber).trim()) {
        const vNum = String(vehicleNumber).trim().toUpperCase();

        const activeVehicle = await prisma.foodDeliveryPartner.findFirst({
            where: { vehicleNumber: vNum, status: { not: 'rejected' } },
        });
        if (activeVehicle) {
            throw new ValidationError('Vehicle number already registered with another partner');
        }

        // Clear rejected records holding this vehicle, so the unique constraint allows it.
        await prisma.foodDeliveryPartner.deleteMany({
            where: { vehicleNumber: vNum, status: 'rejected' },
        });
    }

    const uploadTasks = [];
    const photoField = (field, folder) => {
        if (!files?.[field]?.[0]) return;
        uploadTasks.push(
            uploadImageBuffer(files[field][0].buffer, folder).then((url) => [field, url]),
        );
    };
    photoField('profilePhoto', 'food/delivery/profile');
    photoField('aadharPhoto', 'food/delivery/aadhar');
    photoField('panPhoto', 'food/delivery/pan');
    photoField('drivingLicensePhoto', 'food/delivery/license');

    const images = Object.fromEntries(await Promise.all(uploadTasks));

    // ── Admin-defined dynamic fields + documents ──
    const fileKeys = new Set(Object.keys(files || {}));
    const { customFields, documentKeys } = await collectDynamicRegistration(rawBody || {}, fileKeys);

    // Upload admin-defined document files (skipping keys already handled above).
    const KNOWN_DOC_FIELDS = new Set([
        'profilePhoto', 'aadharPhoto', 'panPhoto', 'drivingLicensePhoto', 'upiQrCode',
    ]);
    const customDocuments = {};
    const dynamicDocTasks = [];
    for (const key of documentKeys) {
        if (KNOWN_DOC_FIELDS.has(key)) continue;
        const file = files?.[key]?.[0];
        if (!file) continue;
        dynamicDocTasks.push(uploadImageBuffer(file.buffer, `food/delivery/${key}`).then((url) => [key, url]));
    }
    for (const [k, v] of await Promise.all(dynamicDocTasks)) customDocuments[k] = v;

    let normalizedEmail;
    if (email && String(email).trim()) {
        normalizedEmail = String(email).trim().toLowerCase();
        const emailRegex = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9\-]+(?:\.[a-zA-Z0-9\-]+)*\.[a-zA-Z]{2,10}$/;
        if (!emailRegex.test(normalizedEmail) || normalizedEmail.includes('..')) {
            throw new ValidationError('Invalid email format');
        }
        const domain = normalizedEmail.split('@')[1];
        const segments = domain ? domain.split('.') : [];
        if (segments.length >= 2 && segments[segments.length - 1] === segments[segments.length - 2]) {
            throw new ValidationError('Invalid email domain (repeated segments)');
        }
    }

    // referredBy is resolved before the insert. Mongo created the row and then
    // patched it in a second save; one write is simpler and cannot half-apply.
    let referredById = null;
    if (refRaw && isId(refRaw)) {
        const referrer = await prisma.foodDeliveryPartner.findUnique({
            where: { id: refRaw },
            select: { id: true },
        });
        if (referrer) referredById = referrer.id;
    }

    let partner = await prisma.foodDeliveryPartner.create({
        data: {
            name,
            phone,
            email: normalizedEmail,
            ...(countryCode ? { countryCode } : {}),
            address,
            city,
            state,
            vehicleType,
            vehicleName,
            vehicleNumber: vehicleNumber ? String(vehicleNumber).trim().toUpperCase() : null,
            drivingLicenseNumber,
            panNumber,
            aadharNumber,
            status: 'pending',
            referredById,
            ...images,
            ...(Object.keys(customFields).length ? { customFields } : {}),
            ...(Object.keys(customDocuments).length ? { customDocuments } : {}),
        },
    });

    // The referral code defaults to the partner's own id, which only exists after
    // the insert.
    if (!partner.referralCode) {
        partner = await prisma.foodDeliveryPartner.update({
            where: { id: partner.id },
            data: { referralCode: partner.id },
        });
    }

    // Save FCM through the shared upsert, so this token cannot live on another account.
    if (fcmToken) await savePartnerFcmToken(partner.id, fcmToken, platform);

    try {
        const { notifyAdminsSafely } = await import('../../../../core/notifications/firebase.service.js');
        void notifyAdminsSafely({
            title: 'New Delivery Partner Registration 🚲',
            body: `A new delivery partner "${partner.name}" has signed up and is pending approval.`,
            data: { type: 'new_registration', subType: 'delivery_partner', id: partner.id },
        });
    } catch (e) {
        logger.warn(`Failed to notify admins of new delivery partner registration: ${e?.message || e}`);
    }

    return partner;
};

/** Shared vehicle-number guard for the profile-update paths. */
async function claimVehicleNumber(vNum, selfId) {
    if (!vNum) return;
    const activeVehicle = await prisma.foodDeliveryPartner.findFirst({
        where: { vehicleNumber: vNum, id: { not: String(selfId) }, status: { not: 'rejected' } },
    });
    if (activeVehicle) {
        throw new ValidationError('Vehicle number already registered with another partner');
    }
    // Clear rejected records holding this vehicle, so the unique constraint allows it.
    await prisma.foodDeliveryPartner.deleteMany({ where: { vehicleNumber: vNum, status: 'rejected' } });
}

export const updateDeliveryPartnerProfile = async (userId, payload, files) => {
    const partner = await requirePartner(userId);

    const {
        name, countryCode, address, city, state,
        vehicleType, vehicleName, vehicleNumber, drivingLicenseNumber,
        fcmToken, platform,
    } = payload;

    const data = {};
    if (name) data.name = name;
    if (countryCode !== undefined) data.countryCode = countryCode;
    if (address !== undefined) data.address = address;
    if (city !== undefined) data.city = city;
    if (state !== undefined) data.state = state;
    if (vehicleType !== undefined) data.vehicleType = vehicleType;
    if (vehicleName !== undefined) data.vehicleName = vehicleName;

    if (
        vehicleNumber !== undefined &&
        String(vehicleNumber).trim().toUpperCase() !== String(partner.vehicleNumber || '').trim().toUpperCase()
    ) {
        const vNum = String(vehicleNumber).trim().toUpperCase();
        await claimVehicleNumber(vNum, partner.id);
        data.vehicleNumber = vNum || null;
    }
    if (drivingLicenseNumber !== undefined) data.drivingLicenseNumber = drivingLicenseNumber;

    if (files?.profilePhoto?.[0]) {
        data.profilePhoto = await uploadImageBuffer(files.profilePhoto[0].buffer, 'food/delivery/profile');
    }

    const updated = await prisma.foodDeliveryPartner.update({ where: { id: partner.id }, data });

    if (fcmToken) await savePartnerFcmToken(partner.id, fcmToken, platform);

    return { partner: updated, requiresReapproval: false };
};

export const updateDeliveryPartnerDetails = async (userId, payload) => {
    const partner = await requirePartner(userId);
    const data = {};

    const vehicle = payload?.vehicle;
    if (vehicle && typeof vehicle === 'object') {
        if (
            vehicle.number !== undefined &&
            String(vehicle.number || '').trim().toUpperCase() !== String(partner.vehicleNumber || '').trim().toUpperCase()
        ) {
            const vNum = String(vehicle.number || '').trim().toUpperCase();
            await claimVehicleNumber(vNum, partner.id);
            data.vehicleNumber = vNum || null;
        }
        if (vehicle.type !== undefined) data.vehicleType = String(vehicle.type || '').trim();
        if (vehicle.brand !== undefined) data.vehicleName = String(vehicle.brand || '').trim();
        if (vehicle.model !== undefined) data.vehicleName = String(vehicle.model || '').trim();
    }

    if (payload?.profilePhoto !== undefined) {
        data.profilePhoto = payload.profilePhoto ? String(payload.profilePhoto).trim() : '';
    }

    return prisma.foodDeliveryPartner.update({ where: { id: partner.id }, data });
};

export const updateDeliveryPartnerProfilePhotoBase64 = async (userId, payload) => {
    const partner = await requirePartner(userId);

    const base64 = payload?.base64;
    if (!base64 || typeof base64 !== 'string') throw new ValidationError('base64 is required');

    const buffer = Buffer.from(base64, 'base64');
    if (!buffer || !buffer.length) throw new ValidationError('Invalid base64 image');
    if (buffer.length > 8 * 1024 * 1024) throw new ValidationError('Image too large (max 8MB)');

    const profilePhoto = await uploadImageBuffer(buffer, 'food/delivery/profile');
    return prisma.foodDeliveryPartner.update({ where: { id: partner.id }, data: { profilePhoto } });
};

export const updateDeliveryPartnerBankDetails = async (userId, payload, files) => {
    const partner = await requirePartner(userId);
    const data = {};

    // Handle both nested JSON and flat FormData from multer.
    let bankDetails = payload?.documents?.bankDetails;
    let panDetails = payload?.documents?.pan;

    // Multer flattens FormData keys like 'documents[bankDetails][accountNumber]'.
    if (!bankDetails && payload) {
        const b = {};
        const flat = {
            accountHolderName: 'documents[bankDetails][accountHolderName]',
            accountNumber: 'documents[bankDetails][accountNumber]',
            ifscCode: 'documents[bankDetails][ifscCode]',
            bankName: 'documents[bankDetails][bankName]',
            upiId: 'documents[bankDetails][upiId]',
        };
        for (const [key, formKey] of Object.entries(flat)) {
            if (payload[formKey] !== undefined) b[key] = payload[formKey];
        }
        if (Object.keys(b).length > 0) bankDetails = b;
    }

    if (!panDetails && payload?.['documents[pan][number]'] !== undefined) {
        panDetails = { number: payload['documents[pan][number]'] };
    }

    if (bankDetails) {
        const b = bankDetails;
        const trim = (v) => (v ? String(v).trim() : '');
        if (b.accountHolderName !== undefined) data.bankAccountHolderName = trim(b.accountHolderName);
        if (b.accountNumber !== undefined) data.bankAccountNumber = trim(b.accountNumber);
        if (b.ifscCode !== undefined) data.bankIfscCode = trim(b.ifscCode).toUpperCase();
        if (b.bankName !== undefined) data.bankName = trim(b.bankName);
        if (b.upiId !== undefined) data.upiId = trim(b.upiId);
    }

    if (panDetails?.number !== undefined) {
        data.panNumber = panDetails.number ? String(panDetails.number).trim().toUpperCase() : '';
    }

    if (files?.upiQrCode?.[0]) {
        data.upiQrCode = await uploadImageBuffer(files.upiQrCode[0].buffer, 'food/delivery/upi');
    }

    return prisma.foodDeliveryPartner.update({ where: { id: partner.id }, data });
};

function generateTicketId() {
    const n = Date.now().toString(36).slice(-6).toUpperCase();
    const r = Math.random().toString(36).slice(2, 6).toUpperCase();
    return `TKT-${n}${r}`;
}

export const listSupportTicketsByPartner = async (deliveryPartnerId) =>
    prisma.deliverySupportTicket.findMany({
        where: { deliveryPartnerId: String(deliveryPartnerId) },
        orderBy: { createdAt: 'desc' },
    });

export const createSupportTicket = async (deliveryPartnerId, payload) => {
    const { subject, description, category = 'other', priority = 'medium' } = payload;
    if (!subject || !description || subject.trim().length < 3) {
        throw new ValidationError('Subject is required (min 3 characters)');
    }
    if (description.trim().length < 10) {
        throw new ValidationError('Description must be at least 10 characters');
    }

    const data = {
        deliveryPartnerId: String(deliveryPartnerId),
        subject: subject.trim(),
        description: description.trim(),
        category: ['payment', 'account', 'technical', 'order', 'other'].includes(category) ? category : 'other',
        priority: ['low', 'medium', 'high', 'urgent'].includes(priority) ? priority : 'medium',
        status: 'open',
    };

    // ticketId is unique, so a collision just retries. The old check-then-insert
    // loop raced with itself anyway.
    for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
            return await prisma.deliverySupportTicket.create({
                data: { ...data, ticketId: generateTicketId() },
            });
        } catch (err) {
            if (err?.code === 'P2002') continue;
            throw err;
        }
    }
    throw new ValidationError('Could not allocate a ticket id. Please try again.');
};

export const getSupportTicketByIdAndPartner = async (ticketId, deliveryPartnerId) => {
    if (!isId(ticketId)) return null;
    return prisma.deliverySupportTicket.findFirst({
        where: { id: String(ticketId), deliveryPartnerId: String(deliveryPartnerId) },
    });
};

export const updateDeliveryAvailability = async (userId, payload) => {
    const partner = await requirePartner(userId);

    // Accept both field spellings clients send: status/availabilityStatus,
    // lat/lng or latitude/longitude, and numeric strings.
    const rawStatus = payload?.status ?? payload?.availabilityStatus;
    const lat = Number(payload?.latitude ?? payload?.lat);
    const lng = Number(payload?.longitude ?? payload?.lng);

    let validStatus = 'offline';
    if (rawStatus === 'online' || rawStatus === true || rawStatus === 'true') validStatus = 'online';
    else if (rawStatus === 'offline' || rawStatus === false || rawStatus === 'false') validStatus = 'offline';

    const data = { availabilityStatus: validStatus };
    if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
        // Only the plain coordinates are written; the lastLocation geography column
        // is derived by the partner_location_sync trigger.
        data.lastLat = lat;
        data.lastLng = lng;
        data.lastLocationAt = new Date();
    }

    const updated = await prisma.foodDeliveryPartner.update({ where: { id: partner.id }, data });
    return { availabilityStatus: updated.availabilityStatus };
};

// ----- Delivery partner wallet (Pocket / requests page) -----
export const getDeliveryPartnerWallet = async (deliveryPartnerId) => {
    if (!isId(deliveryPartnerId)) throw new ValidationError('Delivery partner not found');
    const partnerId = String(deliveryPartnerId);

    const partner = await prisma.foodDeliveryPartner.findUnique({ where: { id: partnerId } });
    if (!partner) throw new ValidationError('Delivery partner not found');

    const cashLimitSettings = await getDeliveryCashLimitSettings();
    const totalCashLimit = num(cashLimitSettings.deliveryCashLimit);
    const deliveryWithdrawalLimit = num(cashLimitSettings.deliveryWithdrawalLimit) || 100;

    const [earningsAgg, cashAgg, bonusAgg, paymentTxList, bonusTxList] = await Promise.all([
        prisma.foodOrder.aggregate({
            where: { dispatchDeliveryPartnerId: partnerId, orderStatus: 'delivered' },
            _sum: { riderEarning: true },
        }),
        prisma.foodOrder.aggregate({
            where: {
                dispatchDeliveryPartnerId: partnerId,
                orderStatus: 'delivered',
                paymentMethod: 'cash',
                paymentStatus: 'paid',
            },
            _sum: { riderEarning: true },
        }),
        prisma.deliveryBonusTransaction.aggregate({
            where: { deliveryPartnerId: partnerId },
            _sum: { amount: true },
        }),
        prisma.foodOrder.findMany({
            where: { dispatchDeliveryPartnerId: partnerId, orderStatus: 'delivered' },
            orderBy: [{ deliveredAt: 'desc' }, { createdAt: 'desc' }],
            select: {
                id: true, orderId: true, riderEarning: true, paymentMethod: true,
                orderStatus: true, deliveredAt: true, createdAt: true,
            },
            take: 2000,
        }),
        prisma.deliveryBonusTransaction.findMany({
            where: { deliveryPartnerId: partnerId },
            orderBy: { createdAt: 'desc' },
            take: 1000,
        }),
    ]);

    const totalEarned = num(earningsAgg?._sum?.riderEarning);
    const cashInHand = num(cashAgg?._sum?.riderEarning);
    const totalBonus = num(bonusAgg?._sum?.amount);

    const paymentTransactions = (paymentTxList || []).map((o) => {
        const date = o.deliveredAt || o.createdAt || new Date();
        return {
            _id: o.id,
            type: 'payment',
            amount: num(o.riderEarning),
            status: 'Completed',
            date,
            createdAt: date,
            orderId: o.orderId || o.id,
            paymentMethod: o.paymentMethod || '',
            metadata: { orderId: o.orderId || o.id },
            description: o.paymentMethod === 'cash' ? 'COD delivery earning' : 'Online delivery earning',
        };
    });

    // The weekly-earnings screen expects bonus rows typed as `earning_addon`.
    const bonusTransactions = (bonusTxList || []).map((t) => ({
        _id: t.id,
        type: 'earning_addon',
        amount: num(t.amount),
        status: 'Completed',
        date: t.createdAt,
        createdAt: t.createdAt,
        metadata: { reference: t.reference || '' },
        description: t.reference ? `Bonus - ${t.reference}` : 'Bonus',
    }));

    const totalBalance = totalEarned + totalBonus;

    return {
        totalBalance,
        pocketBalance: totalBalance,
        cashInHand,
        totalWithdrawn: 0,
        totalEarned,
        totalCashLimit,
        availableCashLimit: Math.max(0, totalCashLimit - cashInHand),
        deliveryWithdrawalLimit,
        transactions: [...paymentTransactions, ...bonusTransactions].sort(
            (a, b) => new Date(b?.date || 0).getTime() - new Date(a?.date || 0).getTime(),
        ),
        joiningBonusClaimed: false,
        joiningBonusAmount: 0,
    };
};

// ----- Date helpers -----

const toStartOfDay = (d) => {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
};

const toEndOfDay = (d) => {
    const x = new Date(d);
    x.setHours(23, 59, 59, 999);
    return x;
};

const getWeekRange = (anchorDate) => {
    const d = new Date(anchorDate);
    const start = toStartOfDay(d);
    start.setDate(start.getDate() - start.getDay()); // Sunday
    const end = toEndOfDay(start);
    end.setDate(start.getDate() + 6);
    return { start, end };
};

const getMonthRange = (anchorDate) => {
    const d = new Date(anchorDate);
    const start = new Date(d.getFullYear(), d.getMonth(), 1);
    start.setHours(0, 0, 0, 0);
    const end = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    end.setHours(23, 59, 59, 999);
    return { start, end };
};

const computeRange = (period, date) => {
    const p = String(period || 'daily').toLowerCase();
    const anchor = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
    if (p === 'weekly' || p === 'week') return getWeekRange(anchor);
    if (p === 'monthly' || p === 'month') return getMonthRange(anchor);
    return { start: toStartOfDay(anchor), end: toEndOfDay(anchor) };
};

/**
 * A trip counts as inside the window if ANY of its timeline stamps falls in it.
 * `completedAt` was in the Mongo filter but is not a field on the order, so it
 * never matched anything — dropped rather than carried over.
 */
const withinRange = (start, end) => [
    { deliveredAt: { gte: start, lte: end } },
    { updatedAt: { gte: start, lte: end } },
    { createdAt: { gte: start, lte: end } },
];

const TRIP_ORDER_BY = [{ deliveredAt: 'desc' }, { updatedAt: 'desc' }, { createdAt: 'desc' }];

// ----- Earnings summary -----
export const getDeliveryPartnerEarnings = async (deliveryPartnerId, query = {}) => {
    if (!isId(deliveryPartnerId)) throw new ValidationError('Delivery partner not found');
    const partnerId = String(deliveryPartnerId);

    const period = String(query.period || 'week').toLowerCase();
    const date = query.date ? new Date(query.date) : new Date();
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 1000);

    let range = null;
    if (period === 'today') range = { start: toStartOfDay(date), end: toEndOfDay(date) };
    else if (period === 'month') range = getMonthRange(date);
    else if (period === 'all') range = null;
    else range = getWeekRange(date); // week, and anything unrecognised

    const where = {
        dispatchDeliveryPartnerId: partnerId,
        orderStatus: 'delivered',
        ...(range ? { deliveredAt: { gte: range.start, lte: range.end } } : {}),
    };

    const [totalOrders, agg] = await Promise.all([
        prisma.foodOrder.count({ where }),
        prisma.foodOrder.aggregate({ where, _sum: { riderEarning: true } }),
    ]);

    const totalEarnings = num(agg?._sum?.riderEarning);

    return {
        summary: {
            totalEarnings,
            totalOrders,
            totalHours: 0,
            totalMinutes: 0,
            orderEarning: totalEarnings,
            incentive: 0,
            otherEarnings: 0,
        },
        period,
        date: date.toISOString(),
        pagination: { page, limit, total: totalOrders },
    };
};

const normalizeStatusFilter = (status) => {
    const s = String(status || '').trim();
    if (!s || s.toUpperCase() === 'ALL TRIPS') return null;
    return s;
};

const toTripDto = (order) => {
    const createdAt = order?.createdAt || null;
    const deliveredAt = order?.deliveredAt || null;
    const dateForUi = deliveredAt || createdAt || order?.updatedAt || null;

    // Pre-formatted for older app builds that render this string directly.
    //
    // 'en-IN' selects the FORMAT and says nothing about the timezone: with no
    // timeZone option Node uses the system zone, and this server runs UTC, so
    // riders saw every trip 5h30m early. The zone is explicit.
    //
    // Deprecated: clients should format `date` (a real ISO-8601 timestamp) in the
    // device's own timezone.
    const time = dateForUi
        ? new Date(dateForUi).toLocaleTimeString('en-IN', {
              hour: '2-digit',
              minute: '2-digit',
              timeZone: process.env.DISPLAY_TIME_ZONE || 'Asia/Kolkata',
          })
        : '';

    const orderStatus = String(order?.orderStatus || '').toLowerCase();
    const isDelivered =
        orderStatus === 'delivered' || String(order?.deliveryPhase || '').toLowerCase() === 'delivered';
    const isCancelled =
        orderStatus.startsWith('cancelled') ||
        String(order?.deliveryStatus || '').toLowerCase().includes('cancel');

    const status = isDelivered ? 'Completed' : isCancelled ? 'Cancelled' : 'Pending';

    const restaurantName = order?.restaurant?.restaurantName || '';
    const paymentMethod = order?.paymentMethod || '';
    const pricingTotal = num(order?.total);

    const earningAmount = num(order?.riderEarning);
    const codAmount = paymentMethod === 'cash' ? num(order?.paymentAmountDue) : 0;
    const codCollectedAmount = paymentMethod === 'cash' && order?.paymentStatus === 'paid' ? codAmount : 0;

    return {
        id: order?.id,
        _id: order?.id,
        orderId: order?.orderId || order?.id,
        status,
        restaurantName,
        restaurant: restaurantName,
        items: order?.items || [],
        orderItems: order?.items || [],
        paymentMethod,
        totalAmount: pricingTotal,
        orderTotal: pricingTotal,
        codAmount,
        codCollectedAmount,
        deliveryEarning: earningAmount,
        earningAmount,
        amount: earningAmount, // legacy fallback
        createdAt: order?.createdAt,
        deliveredAt,
        completedAt: deliveredAt,
        date: dateForUi,
        time,
    };
};

export const getDeliveryPartnerTripHistory = async (deliveryPartnerId, query = {}) => {
    if (!isId(deliveryPartnerId)) throw new ValidationError('Delivery partner not found');
    const partnerId = String(deliveryPartnerId);

    const period = query.period || 'daily';
    const date = query.date ? new Date(query.date) : new Date();
    const statusFilter = normalizeStatusFilter(query.status);
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 1000);

    const { start, end } = computeRange(period, date);

    const where = {
        dispatchDeliveryPartnerId: partnerId,
        OR: withinRange(start, end),
    };

    const sf = String(statusFilter || '').toLowerCase();
    if (sf === 'completed') {
        where.orderStatus = 'delivered';
    } else if (sf === 'cancelled') {
        where.orderStatus = { startsWith: 'cancelled' };
    } else if (sf === 'pending') {
        // Pending = neither delivered nor cancelled.
        where.AND = [
            { orderStatus: { not: 'delivered' } },
            { NOT: { orderStatus: { startsWith: 'cancelled' } } },
        ];
    }

    const orders = await prisma.foodOrder.findMany({
        where,
        include: { items: true, restaurant: { select: { id: true, restaurantName: true } } },
        orderBy: TRIP_ORDER_BY,
        take: limit,
    });

    return {
        period,
        date: (date || new Date()).toISOString(),
        range: { start: start.toISOString(), end: end.toISOString() },
        trips: (orders || []).map(toTripDto),
    };
};

export const getDeliveryPocketDetails = async (deliveryPartnerId, query = {}) => {
    if (!isId(deliveryPartnerId)) throw new ValidationError('Delivery partner not found');
    const partnerId = String(deliveryPartnerId);

    const date = query.date ? new Date(query.date) : new Date();
    const { start, end } = getWeekRange(date);
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 1000, 1), 2000);

    const [orders, bonusTxList] = await Promise.all([
        prisma.foodOrder.findMany({
            where: {
                dispatchDeliveryPartnerId: partnerId,
                orderStatus: 'delivered',
                OR: withinRange(start, end),
            },
            include: { items: true, restaurant: { select: { id: true, restaurantName: true } } },
            orderBy: TRIP_ORDER_BY,
            take: limit,
        }),
        prisma.deliveryBonusTransaction.findMany({
            where: { deliveryPartnerId: partnerId, createdAt: { gte: start, lte: end } },
            orderBy: { createdAt: 'desc' },
            take: limit,
        }),
    ]);

    const trips = (orders || []).map(toTripDto);

    const paymentTransactions = (orders || []).map((o) => ({
        _id: o.id,
        type: 'payment',
        amount: num(o.riderEarning),
        status: 'Completed',
        date: o.deliveredAt || o.createdAt,
        createdAt: o.deliveredAt || o.createdAt,
        orderId: o.orderId || o.id,
        metadata: { orderId: o.orderId || o.id },
        description: o.restaurant?.restaurantName
            ? `Order earning - ${o.restaurant.restaurantName}`
            : 'Order earning',
    }));

    const bonusTransactions = (bonusTxList || []).map((t) => ({
        _id: t.id,
        type: 'bonus',
        amount: num(t.amount),
        status: 'Completed',
        date: t.createdAt,
        createdAt: t.createdAt,
        metadata: { reference: t.reference || '' },
        description: t.reference ? `Bonus - ${t.reference}` : 'Bonus',
    }));

    const totalEarning = paymentTransactions.reduce((sum, t) => sum + num(t.amount), 0);
    const totalBonus = bonusTransactions.reduce((sum, t) => sum + num(t.amount), 0);

    return {
        week: { start: start.toISOString(), end: end.toISOString() },
        summary: { totalEarning, totalBonus, grandTotal: totalEarning + totalBonus },
        trips,
        transactions: { payment: paymentTransactions, bonus: bonusTransactions },
    };
};

export const getActiveEarningAddonsForPartner = async (deliveryPartnerId) => {
    if (!isId(deliveryPartnerId)) throw new ValidationError('Delivery partner not found');
    const partnerId = String(deliveryPartnerId);
    const now = new Date();

    const addons = await prisma.foodEarningAddon.findMany({
        where: { status: 'active', startDate: { lte: now }, endDate: { gte: now } },
        orderBy: [{ endDate: 'asc' }, { createdAt: 'asc' }],
    });

    const liveAddons = (addons || []).filter((addon) => {
        if (!addon) return false;
        const maxRedemptions = Number(addon.maxRedemptions);
        if (!Number.isFinite(maxRedemptions) || maxRedemptions <= 0) return true;
        return Number(addon.currentRedemptions || 0) < maxRedemptions;
    });

    const offers = await Promise.all(
        liveAddons.map(async (addon) => {
            const startDate = addon.startDate ? new Date(addon.startDate) : null;
            const endDate = addon.endDate ? new Date(addon.endDate) : null;

            const where = {
                dispatchDeliveryPartnerId: partnerId,
                orderStatus: 'delivered',
                ...(startDate && endDate ? { deliveredAt: { gte: startDate, lte: endDate } } : {}),
            };

            const [currentOrders, earningsAgg] = await Promise.all([
                prisma.foodOrder.count({ where }),
                prisma.foodOrder.aggregate({ where, _sum: { riderEarning: true } }),
            ]);

            return {
                id: addon.id,
                title: addon.title || 'Earnings Guarantee',
                description: addon.description || '',
                targetAmount: num(addon.earningAmount),
                targetOrders: num(addon.requiredOrders),
                currentOrders: num(currentOrders),
                currentEarnings: num(earningsAgg?._sum?.riderEarning),
                startDate,
                endDate,
                validTill: endDate ? endDate.toISOString() : null,
                isLive: true,
            };
        }),
    );

    return { activeOffer: offers[0] || null, offers };
};

/**
 * Delete a delivery partner and everything that cannot outlive them.
 *
 * Seven tables reference a partner with ON DELETE RESTRICT, so the delete has to
 * name all of them. Mongo left every one of these orphaned — bonus rows,
 * withdrawals and cash deposits pointing at a partner that no longer existed,
 * which quietly skewed finance reports.
 *
 * The wallet LEDGER is deliberately not touched: `transactions.entityId` is a
 * plain column with no foreign key, so those rows survive. They are the record
 * of money that actually moved, and reconciliation still needs them after the
 * account is gone. Orders and the per-order split keep their history too — those
 * FKs are ON DELETE SET NULL, so a delivered order stays delivered.
 */
export const deleteDeliveryPartnerAccount = async (partnerId) => {
    const id = String(partnerId);
    const partner = await prisma.foodDeliveryPartner.findUnique({ where: { id } });
    if (!partner) throw new ValidationError('Delivery partner not found');

    const byPartner = { where: { deliveryPartnerId: id } };

    await prisma.$transaction([
        prisma.deliveryBonusTransaction.deleteMany(byPartner),
        prisma.foodDeliveryCashDeposit.deleteMany(byPartner),
        prisma.foodDeliveryWithdrawal.deleteMany(byPartner),
        prisma.foodEarningAddonHistory.deleteMany(byPartner),
        prisma.deliveryOrderEmergencyRequest.deleteMany(byPartner),
        prisma.deliverySupportTicket.deleteMany(byPartner),
        prisma.orderDispatchOffer.deleteMany({ where: { partnerId: id } }),
        prisma.wallet.deleteMany({ where: { entityType: 'deliveryBoy', entityId: id } }),
        prisma.foodDeliveryPartner.delete({ where: { id } }),
    ]);

    return { success: true };
};
