-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "postgis";

-- CreateEnum
CREATE TYPE "EntityType" AS ENUM ('user', 'restaurant', 'deliveryBoy', 'admin');

-- CreateEnum
CREATE TYPE "OwnerType" AS ENUM ('USER', 'RESTAURANT', 'DELIVERY_PARTNER');

-- CreateEnum
CREATE TYPE "ActorRole" AS ENUM ('USER', 'RESTAURANT', 'DELIVERY_PARTNER', 'ADMIN', 'SYSTEM');

-- CreateEnum
CREATE TYPE "ChatRole" AS ENUM ('USER', 'RESTAURANT', 'DELIVERY_PARTNER', 'ADMIN');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('pending', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "AddressLabel" AS ENUM ('Home', 'Office', 'Other');

-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('male', 'female', 'other', 'prefer-not-to-say', '');

-- CreateEnum
CREATE TYPE "TxnType" AS ENUM ('credit', 'debit');

-- CreateEnum
CREATE TYPE "TxnStatus" AS ENUM ('completed', 'pending', 'failed', 'reversed');

-- CreateEnum
CREATE TYPE "TxnCategory" AS ENUM ('order_payment', 'order_refund', 'wallet_topup', 'wallet_debit', 'commission', 'delivery_earning', 'platform_fee', 'settlement_payout', 'referral_reward', 'adjustment', 'other');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('cash', 'razorpay', 'razorpay_qr', 'wallet', 'upi', 'card', 'netbanking');

-- CreateEnum
CREATE TYPE "PaymentGateway" AS ENUM ('razorpay', 'stripe', 'paypal', 'none');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('created', 'pending', 'success', 'failed', 'refunded');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('pending', 'processed', 'failed');

-- CreateEnum
CREATE TYPE "RefundTo" AS ENUM ('gateway', 'wallet');

-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('pending', 'processing', 'processed', 'failed');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('pending_payment', 'created', 'confirmed', 'preparing', 'ready_for_pickup', 'reached_pickup', 'picked_up', 'reached_drop', 'delivered', 'cancelled_by_user', 'cancelled_by_restaurant', 'cancelled_by_admin');

-- CreateEnum
CREATE TYPE "OrderPaymentMethod" AS ENUM ('cash', 'razorpay', 'razorpay_qr', 'wallet');

-- CreateEnum
CREATE TYPE "OrderPaymentStatus" AS ENUM ('cod_pending', 'created', 'authorized', 'paid', 'failed', 'refunded', 'pending_qr');

-- CreateEnum
CREATE TYPE "OrderRefundStatus" AS ENUM ('none', 'pending', 'processed', 'failed');

-- CreateEnum
CREATE TYPE "DispatchStatus" AS ENUM ('unassigned', 'assigned', 'accepted', 'rejected', 'cancelled');

-- CreateEnum
CREATE TYPE "DispatchOfferAction" AS ENUM ('offered', 'rejected', 'timeout', 'deassigned');

-- CreateEnum
CREATE TYPE "DeliveryPhase" AS ENUM ('en_route_to_pickup', 'at_pickup', 'en_route_to_delivery', 'at_drop', 'delivered', 'completed');

-- CreateEnum
CREATE TYPE "DeliveryMode" AS ENUM ('basic', 'quick');

-- CreateEnum
CREATE TYPE "PartnerStatus" AS ENUM ('pending', 'approved', 'rejected', 'deactivated');

-- CreateEnum
CREATE TYPE "AvailabilityStatus" AS ENUM ('online', 'offline');

-- CreateEnum
CREATE TYPE "AdminType" AS ENUM ('super_admin', 'sub_admin');

-- CreateEnum
CREATE TYPE "ServiceAccess" AS ENUM ('food', 'quickCommerce', 'taxi');

-- CreateEnum
CREATE TYPE "FoodType" AS ENUM ('Veg', 'Non-Veg');

-- CreateEnum
CREATE TYPE "AddonFoodType" AS ENUM ('veg', 'non-veg');

-- CreateEnum
CREATE TYPE "FoodTypeScope" AS ENUM ('Veg', 'Non-Veg', 'Both');

-- CreateEnum
CREATE TYPE "StockOffMode" AS ENUM ('manual', 'specific-time', 'next-business-day', 'custom-date-time');

-- CreateEnum
CREATE TYPE "DiscountType" AS ENUM ('percentage', 'flat-price');

-- CreateEnum
CREATE TYPE "CustomerScope" AS ENUM ('all', 'first-time');

-- CreateEnum
CREATE TYPE "RestaurantScope" AS ENUM ('all', 'selected');

-- CreateEnum
CREATE TYPE "OfferStatus" AS ENUM ('active', 'paused', 'inactive');

-- CreateEnum
CREATE TYPE "CreatorRole" AS ENUM ('ADMIN', 'RESTAURANT');

-- CreateEnum
CREATE TYPE "CashbackType" AS ENUM ('percentage', 'flat');

-- CreateEnum
CREATE TYPE "CommissionValueType" AS ENUM ('percentage', 'amount');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('open', 'in-progress', 'resolved');

-- CreateEnum
CREATE TYPE "DeliveryTicketStatus" AS ENUM ('open', 'in_progress', 'resolved', 'closed');

-- CreateEnum
CREATE TYPE "TicketPriority" AS ENUM ('low', 'medium', 'high');

-- CreateEnum
CREATE TYPE "DeliveryTicketPriority" AS ENUM ('low', 'medium', 'high', 'urgent');

-- CreateEnum
CREATE TYPE "UserTicketType" AS ENUM ('order', 'restaurant', 'other');

-- CreateEnum
CREATE TYPE "RestaurantTicketCategory" AS ENUM ('orders', 'payments', 'menu', 'restaurant', 'technical', 'other');

-- CreateEnum
CREATE TYPE "DeliveryTicketCategory" AS ENUM ('payment', 'account', 'technical', 'order', 'other');

-- CreateEnum
CREATE TYPE "EmergencyRequestStatus" AS ENUM ('open', 'in_progress', 'processing', 'resolved', 'closed');

-- CreateEnum
CREATE TYPE "SafetyReportStatus" AS ENUM ('unread', 'read', 'urgent', 'resolved');

-- CreateEnum
CREATE TYPE "SafetyReportPriority" AS ENUM ('low', 'medium', 'high', 'critical');

-- CreateEnum
CREATE TYPE "ChatThreadStatus" AS ENUM ('open', 'in_progress', 'closed');

-- CreateEnum
CREATE TYPE "ReferralRole" AS ENUM ('USER', 'DELIVERY_PARTNER');

-- CreateEnum
CREATE TYPE "ReferralStatus" AS ENUM ('pending', 'credited', 'rejected');

-- CreateEnum
CREATE TYPE "WithdrawalStatus" AS ENUM ('pending', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "CashDepositStatus" AS ENUM ('Pending', 'Completed', 'Failed');

-- CreateEnum
CREATE TYPE "CashDepositMethod" AS ENUM ('cash', 'razorpay', 'upi', 'bank_transfer');

-- CreateEnum
CREATE TYPE "SubscriptionInvoiceStatus" AS ENUM ('pending', 'partially_settled', 'settled', 'waived');

-- CreateEnum
CREATE TYPE "SubscriptionPlan" AS ENUM ('starter', 'growth', 'premium', 'legacy');

-- CreateEnum
CREATE TYPE "SubscriptionTxnType" AS ENUM ('invoice_generated', 'wallet_deduction', 'manual_payment', 'waiver', 'adjustment', 'legacy_carryforward');

-- CreateEnum
CREATE TYPE "SubscriptionDueStatus" AS ENUM ('due', 'paid');

-- CreateEnum
CREATE TYPE "SubscriptionHistoryEvent" AS ENUM ('subscription_renewal_due_added', 'subscription_payment', 'subscription_auto_deduct');

-- CreateEnum
CREATE TYPE "BillingRunStatus" AS ENUM ('pending', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "InvoiceGeneratedBy" AS ENUM ('system', 'admin', 'migration');

-- CreateEnum
CREATE TYPE "ProcessorRole" AS ENUM ('SYSTEM', 'ADMIN');

-- CreateEnum
CREATE TYPE "LocationUpdateStatus" AS ENUM ('none', 'pending', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "NotificationSource" AS ENUM ('ADMIN_BROADCAST', 'FSSAI_EXPIRY', 'SUPPORT_RESPONSE');

-- CreateEnum
CREATE TYPE "BroadcastTargetType" AS ENUM ('ALL', 'USER', 'RESTAURANT', 'DELIVERY', 'CUSTOM');

-- CreateEnum
CREATE TYPE "PageKey" AS ENUM ('terms', 'privacy', 'refund', 'shipping', 'cancellation', 'about', 'support');

-- CreateEnum
CREATE TYPE "PageModule" AS ENUM ('USER', 'DELIVERY', 'RESTAURANT', 'ALL');

-- CreateEnum
CREATE TYPE "FeedbackModule" AS ENUM ('user', 'restaurant', 'delivery');

-- CreateEnum
CREATE TYPE "FeedbackUserModel" AS ENUM ('FoodUser', 'FoodRestaurant', 'FoodDeliveryPartner');

-- CreateEnum
CREATE TYPE "ExploreLinkType" AS ENUM ('offers', 'gourmet', 'top-10', 'collections', 'custom');

-- CreateEnum
CREATE TYPE "ZoneUnit" AS ENUM ('kilometer', 'miles');

-- CreateEnum
CREATE TYPE "RegistrationFieldType" AS ENUM ('text', 'number', 'email', 'phone', 'date', 'select', 'document');

-- CreateEnum
CREATE TYPE "EarningAddonStatus" AS ENUM ('active', 'inactive');

-- CreateEnum
CREATE TYPE "EarningAddonHistoryStatus" AS ENUM ('pending', 'credited', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "FavoriteEntity" AS ENUM ('restaurant', 'food');

-- CreateTable
CREATE TABLE "food_users" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "phone" VARCHAR(20) NOT NULL,
    "countryCode" VARCHAR(8) NOT NULL DEFAULT '+91',
    "name" TEXT,
    "email" TEXT,
    "profileImage" TEXT NOT NULL DEFAULT '',
    "fcmTokens" TEXT[],
    "fcmTokenMobile" TEXT[],
    "dateOfBirth" TIMESTAMP(3),
    "anniversary" TIMESTAMP(3),
    "gender" "Gender" NOT NULL DEFAULT '',
    "referralCode" TEXT,
    "referredById" VARCHAR(24),
    "referralCount" INTEGER NOT NULL DEFAULT 0,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "role" TEXT NOT NULL DEFAULT 'USER',
    "rating" DECIMAL(2,1) NOT NULL DEFAULT 0,
    "totalRatings" INTEGER NOT NULL DEFAULT 0,
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_user_addresses" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "userId" VARCHAR(24) NOT NULL,
    "label" "AddressLabel" NOT NULL DEFAULT 'Home',
    "street" TEXT NOT NULL,
    "additionalDetails" TEXT NOT NULL DEFAULT '',
    "city" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "zipCode" TEXT NOT NULL DEFAULT '',
    "phone" TEXT NOT NULL DEFAULT '',
    "location" geography(Point, 4326),
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_user_addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_restaurants" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "restaurantName" TEXT NOT NULL,
    "ownerName" TEXT NOT NULL,
    "ownerEmail" TEXT,
    "ownerPhone" VARCHAR(20),
    "restaurantNameNormalized" TEXT,
    "ownerPhoneDigits" VARCHAR(15),
    "ownerPhoneLast10" VARCHAR(10),
    "primaryContactNumber" VARCHAR(20),
    "pureVegRestaurant" BOOLEAN NOT NULL DEFAULT false,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "area" TEXT,
    "city" TEXT,
    "state" TEXT,
    "pincode" TEXT,
    "landmark" TEXT,
    "cuisines" TEXT[],
    "openingTime" TEXT,
    "closingTime" TEXT,
    "openDays" TEXT[],
    "isAcceptingOrders" BOOLEAN NOT NULL DEFAULT true,
    "outsideHoursOverride" BOOLEAN NOT NULL DEFAULT false,
    "panNumber" TEXT,
    "nameOnPan" TEXT,
    "gstRegistered" BOOLEAN NOT NULL DEFAULT false,
    "gstNumber" TEXT,
    "gstLegalName" TEXT,
    "gstAddress" TEXT,
    "fssaiNumber" TEXT,
    "fssaiExpiry" TIMESTAMP(3),
    "accountNumber" TEXT,
    "ifscCode" TEXT,
    "accountHolderName" TEXT,
    "accountType" TEXT,
    "upiId" TEXT,
    "upiQrImage" TEXT,
    "menuImages" TEXT[],
    "coverImages" TEXT[],
    "coverImage" TEXT NOT NULL DEFAULT '',
    "galleryImages" TEXT[],
    "profileImage" TEXT,
    "fcmTokens" TEXT[],
    "fcmTokenMobile" TEXT[],
    "location" geography(Point, 4326),
    "pendingLocation" geography(Point, 4326),
    "pendingZoneId" VARCHAR(24),
    "locationUpdateStatus" "LocationUpdateStatus" NOT NULL DEFAULT 'none',
    "locationUpdateRequestedAt" TIMESTAMP(3),
    "locationUpdateReviewedAt" TIMESTAMP(3),
    "locationRejectionReason" TEXT NOT NULL DEFAULT '',
    "zoneId" VARCHAR(24),
    "businessModel" TEXT,
    "panImage" TEXT,
    "gstImage" TEXT,
    "fssaiImage" TEXT,
    "estimatedDeliveryTime" TEXT,
    "estimatedDeliveryTimeMinutes" INTEGER,
    "featuredDish" TEXT,
    "featuredPrice" DECIMAL(14,2),
    "offer" TEXT,
    "rating" DECIMAL(2,1) NOT NULL DEFAULT 0,
    "totalRatings" INTEGER NOT NULL DEFAULT 0,
    "diningEnabled" BOOLEAN NOT NULL DEFAULT false,
    "diningMaxGuests" INTEGER NOT NULL DEFAULT 6,
    "diningType" TEXT NOT NULL DEFAULT 'family-dining',
    "menuSections" JSONB NOT NULL DEFAULT '[]',
    "status" "ApprovalStatus" NOT NULL DEFAULT 'pending',
    "approvedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "onboardingFeePaid" BOOLEAN NOT NULL DEFAULT false,
    "onboardingFeeAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "onboardingFeePaidAt" TIMESTAMP(3),
    "onboardingFeePaymentMethod" TEXT,
    "onboardingFeePaymentOrderId" TEXT,
    "onboardingFeePaymentId" TEXT,
    "onboardingFeePaymentSignature" TEXT,
    "subscriptionPlan" TEXT,
    "subscriptionAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "subscriptionPaidAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "subscriptionAutoDeductedAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "subscriptionDueAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "subscriptionStatus" "SubscriptionDueStatus" NOT NULL DEFAULT 'due',
    "subscriptionValidTill" TIMESTAMP(3),
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_restaurants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_delivery_partners" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "name" TEXT NOT NULL,
    "phone" VARCHAR(20) NOT NULL,
    "email" TEXT,
    "countryCode" VARCHAR(8) NOT NULL DEFAULT '+91',
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "vehicleType" TEXT,
    "vehicleName" TEXT,
    "vehicleNumber" TEXT,
    "panNumber" TEXT,
    "aadharNumber" TEXT,
    "drivingLicenseNumber" TEXT,
    "profilePhoto" TEXT,
    "aadharPhoto" TEXT,
    "panPhoto" TEXT,
    "drivingLicensePhoto" TEXT,
    "fcmTokens" TEXT[],
    "fcmTokenMobile" TEXT[],
    "status" "PartnerStatus" NOT NULL DEFAULT 'pending',
    "rejectionReason" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "bankAccountHolderName" TEXT,
    "bankAccountNumber" TEXT,
    "bankIfscCode" TEXT,
    "bankName" TEXT,
    "upiId" TEXT,
    "upiQrCode" TEXT,
    "availabilityStatus" "AvailabilityStatus" NOT NULL DEFAULT 'offline',
    "lastLocation" geography(Point, 4326),
    "lastLat" DOUBLE PRECISION,
    "lastLng" DOUBLE PRECISION,
    "lastLocationAt" TIMESTAMP(3),
    "referralCode" TEXT,
    "referredById" VARCHAR(24),
    "referralCount" INTEGER NOT NULL DEFAULT 0,
    "customFields" JSONB NOT NULL DEFAULT '{}',
    "customDocuments" JSONB NOT NULL DEFAULT '{}',
    "rating" DECIMAL(2,1) NOT NULL DEFAULT 0,
    "totalRatings" INTEGER NOT NULL DEFAULT 0,
    "totalDeliveries" INTEGER NOT NULL DEFAULT 0,
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_delivery_partners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_admins" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "phone" TEXT NOT NULL DEFAULT '',
    "profileImage" TEXT NOT NULL DEFAULT '',
    "fcmTokens" TEXT[],
    "fcmTokenMobile" TEXT[],
    "role" TEXT NOT NULL DEFAULT 'ADMIN',
    "adminType" "AdminType" NOT NULL DEFAULT 'super_admin',
    "permissions" JSONB NOT NULL DEFAULT '{}',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdById" VARCHAR(24),
    "updatedById" VARCHAR(24),
    "servicesAccess" "ServiceAccess"[] DEFAULT ARRAY['food']::"ServiceAccess"[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_admins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_otps" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "phone" VARCHAR(20) NOT NULL,
    "otp" VARCHAR(10) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "requestCount" INTEGER NOT NULL DEFAULT 1,
    "lastRequestAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "windowStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "purgeAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_otps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_admin_reset_otps" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "email" VARCHAR(255) NOT NULL,
    "otp" VARCHAR(10) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_admin_reset_otps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_refresh_tokens" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "userId" VARCHAR(24) NOT NULL,
    "token" TEXT NOT NULL,
    "device" TEXT,
    "ipAddress" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallets" (
    "entityType" "EntityType" NOT NULL,
    "entityId" VARCHAR(24) NOT NULL,
    "balance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "lockedAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "totalEarnings" DECIMAL(14,2),
    "totalSettled" DECIMAL(14,2),
    "cashInHand" DECIMAL(14,2),
    "totalBonus" DECIMAL(14,2),
    "totalDeliveries" INTEGER,
    "referralEarnings" DECIMAL(14,2),
    "totalRevenue" DECIMAL(14,2),
    "totalPayouts" DECIMAL(14,2),
    "totalRefunds" DECIMAL(14,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("entityType","entityId")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "paymentId" VARCHAR(24),
    "orderId" VARCHAR(24),
    "entityType" "EntityType" NOT NULL,
    "entityId" VARCHAR(24) NOT NULL,
    "type" "TxnType" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "balanceAfter" DECIMAL(14,2) NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'INR',
    "status" "TxnStatus" NOT NULL DEFAULT 'completed',
    "description" TEXT NOT NULL DEFAULT '',
    "category" "TxnCategory" NOT NULL DEFAULT 'other',
    "module" TEXT NOT NULL DEFAULT 'food',
    "metadata" JSONB,
    "idempotencyKey" TEXT,
    "settlementId" VARCHAR(24),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "orderId" VARCHAR(24) NOT NULL,
    "userId" VARCHAR(24) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'INR',
    "method" "PaymentMethod" NOT NULL,
    "gateway" "PaymentGateway" NOT NULL DEFAULT 'none',
    "gatewayOrderId" VARCHAR(128),
    "gatewayPaymentId" VARCHAR(128),
    "status" "PaymentStatus" NOT NULL DEFAULT 'created',
    "module" TEXT NOT NULL DEFAULT 'food',
    "rawResponse" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refunds" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "paymentId" VARCHAR(24) NOT NULL,
    "orderId" VARCHAR(24) NOT NULL,
    "userId" VARCHAR(24) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'INR',
    "reason" TEXT NOT NULL DEFAULT '',
    "status" "RefundStatus" NOT NULL DEFAULT 'pending',
    "refundTo" "RefundTo" NOT NULL DEFAULT 'wallet',
    "gatewayRefundId" VARCHAR(128),
    "processedAt" TIMESTAMP(3),
    "processedBy" VARCHAR(24),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlements" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "entityType" "EntityType" NOT NULL,
    "entityId" VARCHAR(24) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'INR',
    "status" "SettlementStatus" NOT NULL DEFAULT 'pending',
    "payoutRef" TEXT NOT NULL DEFAULT '',
    "processedAt" TIMESTAMP(3),
    "processedBy" VARCHAR(24),
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "notes" TEXT NOT NULL DEFAULT '',
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_orders" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "order_id" VARCHAR(32),
    "orderId" VARCHAR(32),
    "userId" VARCHAR(24) NOT NULL,
    "restaurantId" VARCHAR(24) NOT NULL,
    "zoneId" VARCHAR(24),
    "transactionId" VARCHAR(24),
    "customerName" TEXT NOT NULL DEFAULT '',
    "customerPhone" TEXT NOT NULL DEFAULT '',
    "addrLabel" "AddressLabel" NOT NULL DEFAULT 'Home',
    "addrName" TEXT NOT NULL DEFAULT '',
    "addrFullName" TEXT NOT NULL DEFAULT '',
    "addrStreet" TEXT NOT NULL,
    "addrAdditionalDetails" TEXT NOT NULL DEFAULT '',
    "addrCity" TEXT NOT NULL,
    "addrState" TEXT NOT NULL,
    "addrZipCode" TEXT NOT NULL DEFAULT '',
    "addrPhone" TEXT NOT NULL DEFAULT '',
    "addrLocation" geography(Point, 4326),
    "subtotal" DECIMAL(14,2) NOT NULL,
    "tax" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "packagingFee" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "deliveryFee" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "deliveryFeeGst" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "platformFee" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "quickDeliveryFee" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "deliveryMode" "DeliveryMode" NOT NULL DEFAULT 'basic',
    "restaurantCommission" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "discount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "couponCode" VARCHAR(64),
    "total" DECIMAL(14,2) NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'INR',
    "distanceKm" DECIMAL(8,2),
    "roadDistanceKm" DECIMAL(8,2),
    "roadDurationMins" INTEGER,
    "paymentMethod" "OrderPaymentMethod" NOT NULL,
    "paymentStatus" "OrderPaymentStatus" NOT NULL DEFAULT 'cod_pending',
    "paymentAmountDue" DECIMAL(14,2),
    "razorpayOrderId" TEXT,
    "razorpayPaymentId" TEXT,
    "razorpaySignature" TEXT,
    "qr" JSONB,
    "refundStatus" "OrderRefundStatus" NOT NULL DEFAULT 'none',
    "refundAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "refundId" TEXT NOT NULL DEFAULT '',
    "refundProcessedAt" TIMESTAMP(3),
    "orderStatus" "OrderStatus" NOT NULL DEFAULT 'created',
    "dispatchStatus" "DispatchStatus" NOT NULL DEFAULT 'unassigned',
    "dispatchDeliveryPartnerId" VARCHAR(24),
    "dispatchAssignedAt" TIMESTAMP(3),
    "dispatchAcceptedAt" TIMESTAMP(3),
    "dispatchingAt" TIMESTAMP(3),
    "deliveryPhase" "DeliveryPhase" NOT NULL DEFAULT 'en_route_to_pickup',
    "deliveryStatus" TEXT NOT NULL DEFAULT '',
    "reachedPickupAt" TIMESTAMP(3),
    "reachedDropAt" TIMESTAMP(3),
    "pickedUpAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "restaurantRating" INTEGER,
    "restaurantRatingComment" TEXT NOT NULL DEFAULT '',
    "restaurantRatedAt" TIMESTAMP(3),
    "partnerRating" INTEGER,
    "partnerRatingComment" TEXT NOT NULL DEFAULT '',
    "partnerRatedAt" TIMESTAMP(3),
    "customerRating" INTEGER,
    "customerRatingComment" TEXT NOT NULL DEFAULT '',
    "customerRatedAt" TIMESTAMP(3),
    "note" TEXT NOT NULL DEFAULT '',
    "deliveryInstructions" TEXT NOT NULL DEFAULT '',
    "acceptanceWindowSeconds" INTEGER NOT NULL DEFAULT 240,
    "acceptanceDeadlineAt" TIMESTAMP(3),
    "restaurantNotifiedAt" TIMESTAMP(3),
    "sendCutlery" BOOLEAN NOT NULL DEFAULT true,
    "deliveryFleet" TEXT NOT NULL DEFAULT 'standard',
    "scheduledAt" TIMESTAMP(3),
    "riderEarning" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "platformProfit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "tripDistanceKm" DECIMAL(8,2),
    "tripDurationMins" INTEGER,
    "deliveryOtp" VARCHAR(8) NOT NULL DEFAULT '',
    "dropOtpRequired" BOOLEAN NOT NULL DEFAULT false,
    "dropOtpVerified" BOOLEAN NOT NULL DEFAULT false,
    "lastRiderLocation" geography(Point, 4326),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_order_items" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "orderId" VARCHAR(24) NOT NULL,
    "itemId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "variantId" TEXT NOT NULL DEFAULT '',
    "variantName" TEXT NOT NULL DEFAULT '',
    "variantPrice" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "price" DECIMAL(14,2) NOT NULL,
    "otherPrice" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "quantity" INTEGER NOT NULL,
    "isVeg" BOOLEAN NOT NULL DEFAULT true,
    "image" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "addons" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "food_order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_order_item_ratings" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "orderId" VARCHAR(24) NOT NULL,
    "itemId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "rating" INTEGER NOT NULL,
    "comment" TEXT NOT NULL DEFAULT '',
    "ratedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "food_order_item_ratings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_order_status_history" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "orderId" VARCHAR(24) NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "byRole" "ActorRole",
    "byId" VARCHAR(24),
    "from" TEXT,
    "to" TEXT,
    "note" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "food_order_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_order_dispatch_offers" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "orderId" VARCHAR(24) NOT NULL,
    "partnerId" VARCHAR(24) NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "action" "DispatchOfferAction" NOT NULL DEFAULT 'offered',

    CONSTRAINT "food_order_dispatch_offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_transactions" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "orderId" VARCHAR(24) NOT NULL,
    "userId" VARCHAR(24) NOT NULL,
    "restaurantId" VARCHAR(24) NOT NULL,
    "deliveryPartnerId" VARCHAR(24),
    "paymentMethod" "OrderPaymentMethod" NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'pending',
    "currency" VARCHAR(3) NOT NULL DEFAULT 'INR',
    "subtotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "tax" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "packagingFee" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "deliveryFee" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "deliveryFeeGst" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "platformFee" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "restaurantCommission" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "discount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "couponCode" VARCHAR(64),
    "total" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "paymentStatusLabel" TEXT NOT NULL DEFAULT 'cod_pending',
    "amountDue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "gateway" JSONB,
    "totalCustomerPaid" DECIMAL(14,2) NOT NULL,
    "restaurantShare" DECIMAL(14,2) NOT NULL,
    "commissionAmount" DECIMAL(14,2) NOT NULL,
    "riderShare" DECIMAL(14,2) NOT NULL,
    "platformNetProfit" DECIMAL(14,2) NOT NULL,
    "taxAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "adminDiscountShare" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "restaurantDiscountShare" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "discountAdminBearPercentage" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "discountRestaurantBearPercentage" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "isRestaurantSettled" BOOLEAN NOT NULL DEFAULT false,
    "restaurantSettledAt" TIMESTAMP(3),
    "isRiderSettled" BOOLEAN NOT NULL DEFAULT false,
    "riderSettledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_transaction_history" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "transactionId" VARCHAR(24) NOT NULL,
    "kind" TEXT NOT NULL,
    "amount" DECIMAL(14,2),
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT NOT NULL DEFAULT '',
    "recordedByRole" "ActorRole",
    "recordedById" VARCHAR(24),

    CONSTRAINT "food_transaction_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_settings" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "key" TEXT NOT NULL,
    "dispatchMode" TEXT NOT NULL DEFAULT 'auto',
    "updatedByRole" TEXT,
    "updatedByAdminId" VARCHAR(24),
    "updatedAtBy" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_items" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "restaurantId" VARCHAR(24) NOT NULL,
    "categoryId" VARCHAR(24),
    "categoryName" TEXT NOT NULL DEFAULT '',
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "price" DECIMAL(14,2) NOT NULL,
    "otherPrice" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "variants" JSONB NOT NULL DEFAULT '[]',
    "image" TEXT NOT NULL DEFAULT '',
    "images" TEXT[],
    "foodType" "FoodType" NOT NULL DEFAULT 'Non-Veg',
    "isAvailable" BOOLEAN NOT NULL DEFAULT true,
    "rating" DECIMAL(2,1) NOT NULL DEFAULT 0,
    "totalRatings" INTEGER NOT NULL DEFAULT 0,
    "stockResumeAt" TIMESTAMP(3),
    "stockOffMode" "StockOffMode",
    "isRecommended" BOOLEAN NOT NULL DEFAULT false,
    "preparationTime" TEXT NOT NULL DEFAULT '',
    "approvalStatus" "ApprovalStatus" NOT NULL DEFAULT 'approved',
    "rejectionReason" TEXT NOT NULL DEFAULT '',
    "requestedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_categories" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "name" TEXT NOT NULL,
    "image" TEXT NOT NULL DEFAULT '',
    "type" TEXT NOT NULL DEFAULT '',
    "foodTypeScope" "FoodTypeScope" NOT NULL DEFAULT 'Both',
    "restaurantId" VARCHAR(24),
    "createdByRestaurantId" VARCHAR(24),
    "approvalStatus" "ApprovalStatus" NOT NULL DEFAULT 'approved',
    "isApproved" BOOLEAN NOT NULL DEFAULT true,
    "rejectionReason" TEXT NOT NULL DEFAULT '',
    "requestedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "globalizedAt" TIMESTAMP(3),
    "zoneId" VARCHAR(24),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_addons" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "restaurantId" VARCHAR(24) NOT NULL,
    "foodIds" TEXT[],
    "groupName" TEXT NOT NULL DEFAULT '',
    "groupMinSelect" INTEGER NOT NULL DEFAULT 0,
    "groupMaxSelect" INTEGER NOT NULL DEFAULT 1,
    "groupSortOrder" INTEGER NOT NULL DEFAULT 0,
    "draft" JSONB NOT NULL,
    "published" JSONB,
    "approvalStatus" "ApprovalStatus" NOT NULL DEFAULT 'pending',
    "rejectionReason" TEXT NOT NULL DEFAULT '',
    "requestedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "isAvailable" BOOLEAN NOT NULL DEFAULT true,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_addons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_restaurant_menus" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "restaurantId" VARCHAR(24) NOT NULL,
    "sections" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_restaurant_menus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_restaurant_outlet_timings" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "restaurantId" VARCHAR(24) NOT NULL,
    "timings" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_restaurant_outlet_timings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_user_carts" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "userId" VARCHAR(24) NOT NULL,
    "restaurantId" VARCHAR(24) NOT NULL DEFAULT '',
    "restaurantName" TEXT NOT NULL DEFAULT '',
    "items" JSONB NOT NULL DEFAULT '[]',
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "subtotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "pricing" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_user_carts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_user_favorites" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "userId" VARCHAR(24) NOT NULL,
    "entityType" "FavoriteEntity" NOT NULL,
    "entityId" VARCHAR(24) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_user_favorites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_zones" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "name" TEXT NOT NULL,
    "zoneName" TEXT,
    "country" TEXT NOT NULL DEFAULT 'India',
    "serviceLocation" TEXT,
    "unit" "ZoneUnit" NOT NULL DEFAULT 'kilometer',
    "coordinates" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_zones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_offers" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "couponCode" VARCHAR(64) NOT NULL,
    "discountType" "DiscountType" NOT NULL DEFAULT 'percentage',
    "discountValue" DECIMAL(14,2) NOT NULL,
    "customerScope" "CustomerScope" NOT NULL DEFAULT 'all',
    "restaurantScope" "RestaurantScope" NOT NULL DEFAULT 'all',
    "restaurantId" VARCHAR(24),
    "restaurantIds" TEXT[],
    "minOrderValue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "maxDiscount" DECIMAL(14,2),
    "usageLimit" INTEGER,
    "perUserLimit" INTEGER,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "isFirstOrderOnly" BOOLEAN NOT NULL DEFAULT false,
    "status" "OfferStatus" NOT NULL DEFAULT 'active',
    "showInCart" BOOLEAN NOT NULL DEFAULT true,
    "createdByRole" "CreatorRole" NOT NULL DEFAULT 'ADMIN',
    "adminBearPercentage" DECIMAL(5,2) NOT NULL DEFAULT 100,
    "restaurantBearPercentage" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_offer_usages" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "offerId" VARCHAR(24) NOT NULL,
    "userId" VARCHAR(24) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_offer_usages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_cashback_settings" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "cashbackType" "CashbackType" NOT NULL DEFAULT 'percentage',
    "cashbackValue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "minOrderValue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "maxCashback" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "firstOrderOnly" BOOLEAN NOT NULL DEFAULT false,
    "perUserLimit" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_cashback_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_referral_settings" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "referralRewardUser" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "referralRewardDelivery" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "referralLimitUser" INTEGER NOT NULL DEFAULT 0,
    "referralLimitDelivery" INTEGER NOT NULL DEFAULT 0,
    "referralLinkUser" TEXT NOT NULL DEFAULT '',
    "referralLinkDelivery" TEXT NOT NULL DEFAULT '',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_referral_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_referral_logs" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "referrerId" VARCHAR(24) NOT NULL,
    "refereeId" VARCHAR(24) NOT NULL,
    "role" "ReferralRole" NOT NULL,
    "rewardAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "status" "ReferralStatus" NOT NULL DEFAULT 'pending',
    "reason" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_referral_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_fee_settings" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "deliveryFee" DECIMAL(14,2),
    "deliveryFeeRanges" JSONB NOT NULL DEFAULT '[]',
    "platformFee" DECIMAL(14,2),
    "quickDeliveryFee" DECIMAL(14,2),
    "gstRate" DECIMAL(5,2),
    "deliveryFeeGstRate" DECIMAL(5,2),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_fee_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_business_settings" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "companyName" TEXT NOT NULL DEFAULT 'Switcheats',
    "email" TEXT NOT NULL DEFAULT 'admin@switcheats.com',
    "phoneCountryCode" VARCHAR(8) NOT NULL DEFAULT '+91',
    "phoneNumber" VARCHAR(20) NOT NULL DEFAULT '',
    "address" TEXT NOT NULL DEFAULT '',
    "state" TEXT NOT NULL DEFAULT '',
    "pincode" TEXT NOT NULL DEFAULT '',
    "region" TEXT NOT NULL DEFAULT 'India',
    "logoUrl" TEXT NOT NULL DEFAULT '',
    "logoPublicId" TEXT NOT NULL DEFAULT '',
    "faviconUrl" TEXT NOT NULL DEFAULT '',
    "faviconPublicId" TEXT NOT NULL DEFAULT '',
    "restaurantLogoUrl" TEXT NOT NULL DEFAULT '',
    "restaurantLogoPublicId" TEXT NOT NULL DEFAULT '',
    "restaurantFaviconUrl" TEXT NOT NULL DEFAULT '',
    "restaurantFaviconPublicId" TEXT NOT NULL DEFAULT '',
    "deliveryLogoUrl" TEXT NOT NULL DEFAULT '',
    "deliveryLogoPublicId" TEXT NOT NULL DEFAULT '',
    "deliveryFaviconUrl" TEXT NOT NULL DEFAULT '',
    "deliveryFaviconPublicId" TEXT NOT NULL DEFAULT '',
    "userThemeColor" TEXT NOT NULL DEFAULT '#FA0272',
    "userFontFamily" TEXT NOT NULL DEFAULT 'Poppins',
    "restaurantThemeColor" TEXT NOT NULL DEFAULT '#2563EB',
    "restaurantFontFamily" TEXT NOT NULL DEFAULT 'Poppins',
    "deliveryThemeColor" TEXT NOT NULL DEFAULT '#00B761',
    "deliveryFontFamily" TEXT NOT NULL DEFAULT 'Poppins',
    "orderAcceptanceTimeMinutes" INTEGER NOT NULL DEFAULT 4,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_business_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_feature_settings" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_feature_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_page_contents" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "key" "PageKey" NOT NULL,
    "module" "PageModule" NOT NULL DEFAULT 'ALL',
    "legal" JSONB,
    "about" JSONB,
    "updatedBy" VARCHAR(24),
    "updatedByRole" TEXT NOT NULL DEFAULT 'ADMIN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_page_contents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_restaurant_commissions" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "restaurantId" VARCHAR(24) NOT NULL,
    "commissionType" "CommissionValueType" NOT NULL DEFAULT 'percentage',
    "commissionValue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "notes" TEXT NOT NULL DEFAULT '',
    "status" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_restaurant_commissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_delivery_commission_rules" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "name" TEXT NOT NULL DEFAULT '',
    "minDistance" DECIMAL(8,2) NOT NULL,
    "maxDistance" DECIMAL(8,2),
    "commissionPerKm" DECIMAL(14,2) NOT NULL,
    "basePayout" DECIMAL(14,2) NOT NULL,
    "status" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_delivery_commission_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_delivery_cash_limits" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "deliveryCashLimit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "deliveryWithdrawalLimit" DECIMAL(14,2) NOT NULL DEFAULT 100,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_delivery_cash_limits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_delivery_emergency_help" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "medicalEmergency" TEXT NOT NULL DEFAULT '',
    "accidentHelpline" TEXT NOT NULL DEFAULT '',
    "contactPolice" TEXT NOT NULL DEFAULT '',
    "insurance" TEXT NOT NULL DEFAULT '',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_delivery_emergency_help_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_restaurant_subscription_settings" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "starterPrice" DECIMAL(14,2) NOT NULL DEFAULT 999,
    "growthPrice" DECIMAL(14,2) NOT NULL DEFAULT 1999,
    "premiumPrice" DECIMAL(14,2) NOT NULL DEFAULT 2999,
    "starterMinGmv" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "starterMaxGmv" DECIMAL(14,2) NOT NULL DEFAULT 30000,
    "growthMinGmv" DECIMAL(14,2) NOT NULL DEFAULT 30000.01,
    "growthMaxGmv" DECIMAL(14,2) NOT NULL DEFAULT 60000,
    "premiumMinGmv" DECIMAL(14,2) NOT NULL DEFAULT 60000.01,
    "onboardingFee" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_restaurant_subscription_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_driver_registration_fields" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "type" "RegistrationFieldType" NOT NULL DEFAULT 'text',
    "required" BOOLEAN NOT NULL DEFAULT false,
    "page" INTEGER NOT NULL DEFAULT 1,
    "order" INTEGER NOT NULL DEFAULT 0,
    "options" TEXT[],
    "placeholder" TEXT NOT NULL DEFAULT '',
    "helpText" TEXT NOT NULL DEFAULT '',
    "regex" TEXT NOT NULL DEFAULT '',
    "minLength" INTEGER,
    "maxLength" INTEGER,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_driver_registration_fields_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_subscription_invoices" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "restaurantId" VARCHAR(24) NOT NULL,
    "billingMonth" VARCHAR(16) NOT NULL,
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "gmv" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "orderCount" INTEGER NOT NULL DEFAULT 0,
    "planName" "SubscriptionPlan" NOT NULL,
    "planAmount" DECIMAL(14,2) NOT NULL,
    "gstAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "totalAmount" DECIMAL(14,2) NOT NULL,
    "paidAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "waivedAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "adjustmentAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "outstandingAmount" DECIMAL(14,2) NOT NULL,
    "status" "SubscriptionInvoiceStatus" NOT NULL DEFAULT 'pending',
    "isLegacyCarryForward" BOOLEAN NOT NULL DEFAULT false,
    "settingsSnapshot" JSONB NOT NULL DEFAULT '{}',
    "generatedBy" "InvoiceGeneratedBy" NOT NULL DEFAULT 'system',
    "notes" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_subscription_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_subscription_transactions" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "restaurantId" VARCHAR(24) NOT NULL,
    "invoiceId" VARCHAR(24) NOT NULL,
    "billingMonth" VARCHAR(16) NOT NULL,
    "type" "SubscriptionTxnType" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "outstandingAfter" DECIMAL(14,2) NOT NULL,
    "invoiceStatusAfter" TEXT NOT NULL,
    "processedByRole" "ProcessorRole" NOT NULL DEFAULT 'SYSTEM',
    "processedById" VARCHAR(24),
    "processedByName" TEXT NOT NULL DEFAULT '',
    "remarks" TEXT NOT NULL DEFAULT '',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_subscription_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_restaurant_subscription_history" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "restaurantId" VARCHAR(24) NOT NULL,
    "eventType" "SubscriptionHistoryEvent" NOT NULL,
    "plan" TEXT NOT NULL DEFAULT '',
    "paymentType" TEXT NOT NULL DEFAULT '',
    "amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "dueBefore" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "dueAfter" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "paidBefore" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "paidAfter" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "gmvLast30Days" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "note" TEXT NOT NULL DEFAULT '',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_restaurant_subscription_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_subscription_billing_runs" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "billingMonth" VARCHAR(16) NOT NULL,
    "status" "BillingRunStatus" NOT NULL DEFAULT 'pending',
    "invoicedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedZeroGmvCount" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "errors" TEXT[],
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_subscription_billing_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_restaurant_withdrawals" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "restaurantId" VARCHAR(24) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "status" "WithdrawalStatus" NOT NULL DEFAULT 'pending',
    "paymentMethod" TEXT NOT NULL DEFAULT 'bank_transfer',
    "bankDetails" JSONB,
    "adminNote" TEXT,
    "rejectionReason" TEXT,
    "transactionRef" TEXT,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_restaurant_withdrawals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_delivery_withdrawals" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "deliveryPartnerId" VARCHAR(24) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "status" "WithdrawalStatus" NOT NULL DEFAULT 'pending',
    "paymentMethod" TEXT NOT NULL DEFAULT 'bank_transfer',
    "bankDetails" JSONB,
    "upiId" TEXT,
    "upiQrCode" TEXT,
    "adminNote" TEXT,
    "rejectionReason" TEXT,
    "transactionRef" TEXT,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_delivery_withdrawals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_delivery_cash_deposits" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "deliveryPartnerId" VARCHAR(24) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "paymentMethod" "CashDepositMethod" NOT NULL DEFAULT 'cash',
    "status" "CashDepositStatus" NOT NULL DEFAULT 'Pending',
    "razorpayOrderId" TEXT NOT NULL DEFAULT '',
    "razorpayPaymentId" TEXT,
    "adminId" VARCHAR(24),
    "adminNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_delivery_cash_deposits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_delivery_bonus_transactions" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "deliveryPartnerId" VARCHAR(24) NOT NULL,
    "transactionRef" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "reference" TEXT NOT NULL DEFAULT '',
    "createdByAdminId" VARCHAR(24),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_delivery_bonus_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_earning_addons" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "requiredOrders" INTEGER NOT NULL,
    "earningAmount" DECIMAL(14,2) NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "maxRedemptions" INTEGER,
    "currentRedemptions" INTEGER NOT NULL DEFAULT 0,
    "status" "EarningAddonStatus" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_earning_addons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_earning_addon_history" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "offerId" VARCHAR(24) NOT NULL,
    "deliveryPartnerId" VARCHAR(24) NOT NULL,
    "ordersCompleted" INTEGER NOT NULL DEFAULT 0,
    "ordersRequired" INTEGER NOT NULL DEFAULT 0,
    "earningAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "totalEarning" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "status" "EarningAddonHistoryStatus" NOT NULL DEFAULT 'pending',
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "creditedAt" TIMESTAMP(3),
    "creditedNotes" TEXT NOT NULL DEFAULT '',
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_earning_addon_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_support_tickets" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "userId" VARCHAR(24) NOT NULL,
    "type" "UserTicketType" NOT NULL,
    "orderId" VARCHAR(24),
    "restaurantId" VARCHAR(24),
    "issueType" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" "TicketStatus" NOT NULL DEFAULT 'open',
    "adminResponse" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_support_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_restaurant_support_tickets" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "restaurantId" VARCHAR(24) NOT NULL,
    "category" "RestaurantTicketCategory" NOT NULL,
    "issueType" TEXT NOT NULL,
    "subject" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL DEFAULT '',
    "orderRef" TEXT NOT NULL DEFAULT '',
    "priority" "TicketPriority" NOT NULL DEFAULT 'medium',
    "status" "TicketStatus" NOT NULL DEFAULT 'open',
    "adminResponse" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_restaurant_support_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_delivery_support_tickets" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "deliveryPartnerId" VARCHAR(24) NOT NULL,
    "ticketRef" TEXT,
    "subject" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" "DeliveryTicketCategory" NOT NULL DEFAULT 'other',
    "priority" "DeliveryTicketPriority" NOT NULL DEFAULT 'medium',
    "status" "DeliveryTicketStatus" NOT NULL DEFAULT 'open',
    "adminResponse" TEXT,
    "respondedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_delivery_support_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_delivery_order_emergency_requests" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "orderId" VARCHAR(24) NOT NULL,
    "deliveryPartnerId" VARCHAR(24) NOT NULL,
    "restaurantId" VARCHAR(24) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "EmergencyRequestStatus" NOT NULL DEFAULT 'open',
    "adminResponse" TEXT NOT NULL DEFAULT '',
    "failureReason" TEXT NOT NULL DEFAULT '',
    "activeKey" TEXT,
    "deassignedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" VARCHAR(24),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_delivery_order_emergency_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_safety_emergency_reports" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "userId" VARCHAR(24) NOT NULL,
    "userName" TEXT NOT NULL DEFAULT '',
    "userEmail" TEXT NOT NULL DEFAULT '',
    "userPhone" TEXT NOT NULL DEFAULT '',
    "message" VARCHAR(4000) NOT NULL,
    "status" "SafetyReportStatus" NOT NULL DEFAULT 'unread',
    "priority" "SafetyReportPriority" NOT NULL DEFAULT 'medium',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_safety_emergency_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_chat_conversations" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "conversationId" TEXT NOT NULL,
    "orderId" VARCHAR(24),
    "title" VARCHAR(200) NOT NULL DEFAULT '',
    "status" "ChatThreadStatus" NOT NULL DEFAULT 'open',
    "closedAt" TIMESTAMP(3),
    "peerToken" TEXT NOT NULL,
    "openedByToken" TEXT NOT NULL,
    "participants" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_chat_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_chat_messages" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "conversationId" TEXT NOT NULL,
    "orderId" VARCHAR(24),
    "senderRole" "ChatRole" NOT NULL,
    "senderId" VARCHAR(24) NOT NULL,
    "senderToken" TEXT NOT NULL,
    "recipientRole" "ChatRole" NOT NULL,
    "recipientId" VARCHAR(24),
    "recipientToken" TEXT NOT NULL,
    "participants" TEXT[],
    "text" VARCHAR(2000) NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_notifications" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "ownerType" "OwnerType" NOT NULL,
    "ownerId" VARCHAR(24) NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "link" TEXT NOT NULL DEFAULT '',
    "category" TEXT NOT NULL DEFAULT 'broadcast',
    "source" "NotificationSource" NOT NULL DEFAULT 'ADMIN_BROADCAST',
    "broadcastId" VARCHAR(24),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "readAt" TIMESTAMP(3),
    "dismissedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_notification_broadcasts" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "targetType" "BroadcastTargetType" NOT NULL,
    "targetIds" TEXT[],
    "targets" JSONB NOT NULL DEFAULT '[]',
    "link" TEXT NOT NULL DEFAULT '',
    "createdById" VARCHAR(24) NOT NULL,
    "targetCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "food_notification_broadcasts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_feedback_experiences" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "userId" VARCHAR(24) NOT NULL,
    "userModel" "FeedbackUserModel" NOT NULL DEFAULT 'FoodUser',
    "restaurantId" VARCHAR(24),
    "rating" INTEGER NOT NULL,
    "comment" TEXT NOT NULL DEFAULT '',
    "module" "FeedbackModule" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_feedback_experiences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_dining_categories" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "imageUrl" TEXT NOT NULL DEFAULT '',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "restaurantIds" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_dining_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_dining_restaurants" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "restaurantId" VARCHAR(24) NOT NULL,
    "categoryIds" TEXT[],
    "primaryCategoryId" VARCHAR(24),
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "maxGuests" INTEGER NOT NULL DEFAULT 6,
    "pureVegRestaurant" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_dining_restaurants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_hero_banners" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "imageUrl" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "title" TEXT,
    "ctaText" TEXT,
    "ctaLink" TEXT,
    "linkedRestaurantIds" TEXT[],
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_hero_banners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_under250_banners" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "imageUrl" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "title" TEXT,
    "ctaText" TEXT,
    "ctaLink" TEXT,
    "zoneId" VARCHAR(24),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_under250_banners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_dining_banners" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "imageUrl" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "title" TEXT,
    "ctaText" TEXT,
    "ctaLink" TEXT,
    "diningType" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_dining_banners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_home_promotion_banners" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "imageUrl" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "title" TEXT,
    "ctaLink" TEXT,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "zoneId" VARCHAR(24),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_home_promotion_banners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_restaurant_app_banners" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "imageUrl" TEXT NOT NULL,
    "publicId" TEXT NOT NULL DEFAULT '',
    "title" TEXT NOT NULL DEFAULT '',
    "ctaLink" TEXT NOT NULL DEFAULT '',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_restaurant_app_banners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "top_banners" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "image" TEXT NOT NULL,
    "publicId" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "top_banners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_explore_icons" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "label" TEXT NOT NULL,
    "iconUrl" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "linkType" "ExploreLinkType" NOT NULL DEFAULT 'custom',
    "targetPath" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_explore_icons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_gourmet_restaurants" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "restaurantId" VARCHAR(24) NOT NULL,
    "tags" TEXT[],
    "priority" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_gourmet_restaurants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_landing_settings" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "exploreMoreHeading" TEXT NOT NULL DEFAULT 'Explore more',
    "recommendedRestaurantIds" TEXT[],
    "showHeroBanners" BOOLEAN NOT NULL DEFAULT true,
    "showUnder250" BOOLEAN NOT NULL DEFAULT true,
    "showDining" BOOLEAN NOT NULL DEFAULT true,
    "showExploreIcons" BOOLEAN NOT NULL DEFAULT true,
    "showTop10" BOOLEAN NOT NULL DEFAULT true,
    "showGourmet" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_landing_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_unregistered_restaurants" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "ownerName" TEXT NOT NULL,
    "restaurantName" TEXT NOT NULL,
    "mobileNumber" VARCHAR(20) NOT NULL,
    "emailId" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_unregistered_restaurants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "food_users_phone_key" ON "food_users"("phone");

-- CreateIndex
CREATE INDEX "food_users_referredById_idx" ON "food_users"("referredById");

-- CreateIndex
CREATE INDEX "food_users_isActive_idx" ON "food_users"("isActive");

-- CreateIndex
CREATE INDEX "food_user_addresses_userId_idx" ON "food_user_addresses"("userId");

-- CreateIndex
CREATE INDEX "food_user_addresses_userId_isDefault_idx" ON "food_user_addresses"("userId", "isDefault");

-- CreateIndex
CREATE INDEX "food_restaurants_ownerPhone_idx" ON "food_restaurants"("ownerPhone");

-- CreateIndex
CREATE INDEX "food_restaurants_restaurantName_idx" ON "food_restaurants"("restaurantName");

-- CreateIndex
CREATE INDEX "food_restaurants_restaurantNameNormalized_idx" ON "food_restaurants"("restaurantNameNormalized");

-- CreateIndex
CREATE INDEX "food_restaurants_city_idx" ON "food_restaurants"("city");

-- CreateIndex
CREATE INDEX "food_restaurants_status_createdAt_idx" ON "food_restaurants"("status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "food_restaurants_isAcceptingOrders_idx" ON "food_restaurants"("isAcceptingOrders");

-- CreateIndex
CREATE INDEX "food_restaurants_zoneId_idx" ON "food_restaurants"("zoneId");

-- CreateIndex
CREATE INDEX "food_restaurants_estimatedDeliveryTimeMinutes_idx" ON "food_restaurants"("estimatedDeliveryTimeMinutes");

-- CreateIndex
CREATE INDEX "food_restaurants_rating_idx" ON "food_restaurants"("rating");

-- CreateIndex
CREATE UNIQUE INDEX "food_restaurants_restaurantNameNormalized_ownerPhoneLast10_key" ON "food_restaurants"("restaurantNameNormalized", "ownerPhoneLast10");

-- CreateIndex
CREATE UNIQUE INDEX "food_delivery_partners_phone_key" ON "food_delivery_partners"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "food_delivery_partners_vehicleNumber_key" ON "food_delivery_partners"("vehicleNumber");

-- CreateIndex
CREATE INDEX "food_delivery_partners_referralCode_idx" ON "food_delivery_partners"("referralCode");

-- CreateIndex
CREATE INDEX "food_delivery_partners_referredById_idx" ON "food_delivery_partners"("referredById");

-- CreateIndex
CREATE INDEX "food_delivery_partners_availabilityStatus_status_idx" ON "food_delivery_partners"("availabilityStatus", "status");

-- CreateIndex
CREATE UNIQUE INDEX "food_admins_email_key" ON "food_admins"("email");

-- CreateIndex
CREATE INDEX "food_admins_adminType_isDeleted_isActive_idx" ON "food_admins"("adminType", "isDeleted", "isActive");

-- CreateIndex
CREATE INDEX "food_otps_phone_idx" ON "food_otps"("phone");

-- CreateIndex
CREATE INDEX "food_otps_purgeAt_idx" ON "food_otps"("purgeAt");

-- CreateIndex
CREATE INDEX "food_admin_reset_otps_email_idx" ON "food_admin_reset_otps"("email");

-- CreateIndex
CREATE INDEX "food_admin_reset_otps_expiresAt_idx" ON "food_admin_reset_otps"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "food_refresh_tokens_token_key" ON "food_refresh_tokens"("token");

-- CreateIndex
CREATE INDEX "food_refresh_tokens_userId_idx" ON "food_refresh_tokens"("userId");

-- CreateIndex
CREATE INDEX "food_refresh_tokens_expiresAt_idx" ON "food_refresh_tokens"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_idempotencyKey_key" ON "transactions"("idempotencyKey");

-- CreateIndex
CREATE INDEX "transactions_entityType_entityId_createdAt_idx" ON "transactions"("entityType", "entityId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "transactions_orderId_entityType_idx" ON "transactions"("orderId", "entityType");

-- CreateIndex
CREATE INDEX "transactions_paymentId_type_idx" ON "transactions"("paymentId", "type");

-- CreateIndex
CREATE INDEX "transactions_settlementId_idx" ON "transactions"("settlementId");

-- CreateIndex
CREATE INDEX "payments_orderId_createdAt_idx" ON "payments"("orderId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "payments_userId_status_createdAt_idx" ON "payments"("userId", "status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "payments_module_idx" ON "payments"("module");

-- CreateIndex
CREATE INDEX "payments_gatewayPaymentId_idx" ON "payments"("gatewayPaymentId");

-- CreateIndex
CREATE INDEX "refunds_paymentId_idx" ON "refunds"("paymentId");

-- CreateIndex
CREATE INDEX "refunds_userId_idx" ON "refunds"("userId");

-- CreateIndex
CREATE INDEX "refunds_orderId_status_idx" ON "refunds"("orderId", "status");

-- CreateIndex
CREATE INDEX "settlements_entityType_entityId_status_createdAt_idx" ON "settlements"("entityType", "entityId", "status", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "food_orders_order_id_key" ON "food_orders"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "food_orders_orderId_key" ON "food_orders"("orderId");

-- CreateIndex
CREATE INDEX "food_orders_createdAt_idx" ON "food_orders"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "food_orders_orderStatus_createdAt_idx" ON "food_orders"("orderStatus", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "food_orders_userId_createdAt_idx" ON "food_orders"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "food_orders_restaurantId_orderStatus_createdAt_idx" ON "food_orders"("restaurantId", "orderStatus", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "food_orders_dispatchDeliveryPartnerId_orderStatus_idx" ON "food_orders"("dispatchDeliveryPartnerId", "orderStatus");

-- CreateIndex
CREATE INDEX "food_orders_dispatchStatus_orderStatus_idx" ON "food_orders"("dispatchStatus", "orderStatus");

-- CreateIndex
CREATE INDEX "food_orders_dispatchStatus_orderStatus_updatedAt_idx" ON "food_orders"("dispatchStatus", "orderStatus", "updatedAt" DESC);

-- CreateIndex
CREATE INDEX "food_orders_dispatchDeliveryPartnerId_dispatchStatus_update_idx" ON "food_orders"("dispatchDeliveryPartnerId", "dispatchStatus", "updatedAt" DESC);

-- CreateIndex
CREATE INDEX "food_orders_paymentStatus_createdAt_idx" ON "food_orders"("paymentStatus", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "food_orders_paymentMethod_createdAt_idx" ON "food_orders"("paymentMethod", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "food_orders_zoneId_idx" ON "food_orders"("zoneId");

-- CreateIndex
CREATE INDEX "food_order_items_orderId_idx" ON "food_order_items"("orderId");

-- CreateIndex
CREATE INDEX "food_order_items_itemId_idx" ON "food_order_items"("itemId");

-- CreateIndex
CREATE INDEX "food_order_item_ratings_orderId_idx" ON "food_order_item_ratings"("orderId");

-- CreateIndex
CREATE INDEX "food_order_item_ratings_itemId_idx" ON "food_order_item_ratings"("itemId");

-- CreateIndex
CREATE INDEX "food_order_status_history_orderId_at_idx" ON "food_order_status_history"("orderId", "at" DESC);

-- CreateIndex
CREATE INDEX "food_order_dispatch_offers_orderId_at_idx" ON "food_order_dispatch_offers"("orderId", "at" DESC);

-- CreateIndex
CREATE INDEX "food_order_dispatch_offers_partnerId_idx" ON "food_order_dispatch_offers"("partnerId");

-- CreateIndex
CREATE UNIQUE INDEX "food_transactions_orderId_key" ON "food_transactions"("orderId");

-- CreateIndex
CREATE INDEX "food_transactions_userId_idx" ON "food_transactions"("userId");

-- CreateIndex
CREATE INDEX "food_transactions_restaurantId_idx" ON "food_transactions"("restaurantId");

-- CreateIndex
CREATE INDEX "food_transactions_deliveryPartnerId_idx" ON "food_transactions"("deliveryPartnerId");

-- CreateIndex
CREATE INDEX "food_transactions_createdAt_idx" ON "food_transactions"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "food_transactions_isRestaurantSettled_restaurantId_idx" ON "food_transactions"("isRestaurantSettled", "restaurantId");

-- CreateIndex
CREATE INDEX "food_transactions_status_paymentMethod_idx" ON "food_transactions"("status", "paymentMethod");

-- CreateIndex
CREATE INDEX "food_transaction_history_transactionId_at_idx" ON "food_transaction_history"("transactionId", "at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "food_settings_key_key" ON "food_settings"("key");

-- CreateIndex
CREATE INDEX "food_items_restaurantId_createdAt_idx" ON "food_items"("restaurantId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "food_items_approvalStatus_createdAt_idx" ON "food_items"("approvalStatus", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "food_items_approvalStatus_requestedAt_idx" ON "food_items"("approvalStatus", "requestedAt" DESC);

-- CreateIndex
CREATE INDEX "food_items_restaurantId_approvalStatus_createdAt_idx" ON "food_items"("restaurantId", "approvalStatus", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "food_items_name_idx" ON "food_items"("name");

-- CreateIndex
CREATE INDEX "food_items_isAvailable_idx" ON "food_items"("isAvailable");

-- CreateIndex
CREATE INDEX "food_items_isRecommended_idx" ON "food_items"("isRecommended");

-- CreateIndex
CREATE INDEX "food_items_stockResumeAt_idx" ON "food_items"("stockResumeAt");

-- CreateIndex
CREATE INDEX "food_items_categoryId_idx" ON "food_items"("categoryId");

-- CreateIndex
CREATE INDEX "food_categories_name_idx" ON "food_categories"("name");

-- CreateIndex
CREATE INDEX "food_categories_isApproved_createdAt_idx" ON "food_categories"("isApproved", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "food_categories_restaurantId_isApproved_createdAt_idx" ON "food_categories"("restaurantId", "isApproved", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "food_categories_approvalStatus_createdAt_idx" ON "food_categories"("approvalStatus", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "food_categories_createdByRestaurantId_createdAt_idx" ON "food_categories"("createdByRestaurantId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "food_categories_zoneId_idx" ON "food_categories"("zoneId");

-- CreateIndex
CREATE INDEX "food_categories_isActive_sortOrder_idx" ON "food_categories"("isActive", "sortOrder");

-- CreateIndex
CREATE INDEX "food_addons_restaurantId_isDeleted_createdAt_idx" ON "food_addons"("restaurantId", "isDeleted", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "food_addons_approvalStatus_isDeleted_requestedAt_idx" ON "food_addons"("approvalStatus", "isDeleted", "requestedAt" DESC);

-- CreateIndex
CREATE INDEX "food_addons_restaurantId_approvalStatus_isDeleted_requested_idx" ON "food_addons"("restaurantId", "approvalStatus", "isDeleted", "requestedAt" DESC);

-- CreateIndex
CREATE INDEX "food_addons_restaurantId_approvalStatus_isAvailable_idx" ON "food_addons"("restaurantId", "approvalStatus", "isAvailable");

-- CreateIndex
CREATE UNIQUE INDEX "food_restaurant_menus_restaurantId_key" ON "food_restaurant_menus"("restaurantId");

-- CreateIndex
CREATE UNIQUE INDEX "food_restaurant_outlet_timings_restaurantId_key" ON "food_restaurant_outlet_timings"("restaurantId");

-- CreateIndex
CREATE UNIQUE INDEX "food_user_carts_userId_key" ON "food_user_carts"("userId");

-- CreateIndex
CREATE INDEX "food_user_carts_updatedAt_idx" ON "food_user_carts"("updatedAt" DESC);

-- CreateIndex
CREATE INDEX "food_user_carts_restaurantId_idx" ON "food_user_carts"("restaurantId");

-- CreateIndex
CREATE INDEX "food_user_favorites_userId_entityType_createdAt_idx" ON "food_user_favorites"("userId", "entityType", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "food_user_favorites_userId_entityType_entityId_key" ON "food_user_favorites"("userId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "food_zones_isActive_name_idx" ON "food_zones"("isActive", "name");

-- CreateIndex
CREATE INDEX "food_zones_country_name_idx" ON "food_zones"("country", "name");

-- CreateIndex
CREATE UNIQUE INDEX "food_offers_couponCode_key" ON "food_offers"("couponCode");

-- CreateIndex
CREATE INDEX "food_offers_restaurantId_createdAt_idx" ON "food_offers"("restaurantId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "food_offers_discountType_idx" ON "food_offers"("discountType");

-- CreateIndex
CREATE INDEX "food_offers_customerScope_idx" ON "food_offers"("customerScope");

-- CreateIndex
CREATE INDEX "food_offers_restaurantScope_idx" ON "food_offers"("restaurantScope");

-- CreateIndex
CREATE INDEX "food_offers_status_idx" ON "food_offers"("status");

-- CreateIndex
CREATE INDEX "food_offers_createdByRole_idx" ON "food_offers"("createdByRole");

-- CreateIndex
CREATE INDEX "food_offer_usages_userId_idx" ON "food_offer_usages"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "food_offer_usages_offerId_userId_key" ON "food_offer_usages"("offerId", "userId");

-- CreateIndex
CREATE INDEX "food_cashback_settings_isActive_createdAt_idx" ON "food_cashback_settings"("isActive", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "food_referral_settings_isActive_createdAt_idx" ON "food_referral_settings"("isActive", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "food_referral_logs_referrerId_role_createdAt_idx" ON "food_referral_logs"("referrerId", "role", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "food_referral_logs_status_idx" ON "food_referral_logs"("status");

-- CreateIndex
CREATE UNIQUE INDEX "food_referral_logs_refereeId_role_key" ON "food_referral_logs"("refereeId", "role");

-- CreateIndex
CREATE INDEX "food_fee_settings_isActive_createdAt_idx" ON "food_fee_settings"("isActive", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "food_feature_settings_key_key" ON "food_feature_settings"("key");

-- CreateIndex
CREATE UNIQUE INDEX "food_page_contents_key_module_key" ON "food_page_contents"("key", "module");

-- CreateIndex
CREATE UNIQUE INDEX "food_restaurant_commissions_restaurantId_key" ON "food_restaurant_commissions"("restaurantId");

-- CreateIndex
CREATE INDEX "food_restaurant_commissions_status_idx" ON "food_restaurant_commissions"("status");

-- CreateIndex
CREATE INDEX "food_delivery_commission_rules_status_idx" ON "food_delivery_commission_rules"("status");

-- CreateIndex
CREATE INDEX "food_delivery_commission_rules_createdAt_idx" ON "food_delivery_commission_rules"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "food_delivery_cash_limits_isActive_createdAt_idx" ON "food_delivery_cash_limits"("isActive", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "food_delivery_emergency_help_isActive_createdAt_idx" ON "food_delivery_emergency_help"("isActive", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "food_driver_registration_fields_key_key" ON "food_driver_registration_fields"("key");

-- CreateIndex
CREATE INDEX "food_driver_registration_fields_isActive_page_order_idx" ON "food_driver_registration_fields"("isActive", "page", "order");

-- CreateIndex
CREATE INDEX "food_subscription_invoices_billingMonth_status_idx" ON "food_subscription_invoices"("billingMonth", "status");

-- CreateIndex
CREATE INDEX "food_subscription_invoices_status_outstandingAmount_idx" ON "food_subscription_invoices"("status", "outstandingAmount");

-- CreateIndex
CREATE UNIQUE INDEX "food_subscription_invoices_restaurantId_billingMonth_key" ON "food_subscription_invoices"("restaurantId", "billingMonth");

-- CreateIndex
CREATE INDEX "food_subscription_transactions_restaurantId_createdAt_idx" ON "food_subscription_transactions"("restaurantId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "food_subscription_transactions_invoiceId_createdAt_idx" ON "food_subscription_transactions"("invoiceId", "createdAt");

-- CreateIndex
CREATE INDEX "food_subscription_transactions_billingMonth_idx" ON "food_subscription_transactions"("billingMonth");

-- CreateIndex
CREATE INDEX "food_subscription_transactions_type_idx" ON "food_subscription_transactions"("type");

-- CreateIndex
CREATE INDEX "food_restaurant_subscription_history_restaurantId_createdAt_idx" ON "food_restaurant_subscription_history"("restaurantId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "food_restaurant_subscription_history_eventType_idx" ON "food_restaurant_subscription_history"("eventType");

-- CreateIndex
CREATE UNIQUE INDEX "food_subscription_billing_runs_billingMonth_key" ON "food_subscription_billing_runs"("billingMonth");

-- CreateIndex
CREATE INDEX "food_subscription_billing_runs_status_idx" ON "food_subscription_billing_runs"("status");

-- CreateIndex
CREATE INDEX "food_restaurant_withdrawals_restaurantId_idx" ON "food_restaurant_withdrawals"("restaurantId");

-- CreateIndex
CREATE INDEX "food_restaurant_withdrawals_status_idx" ON "food_restaurant_withdrawals"("status");

-- CreateIndex
CREATE INDEX "food_restaurant_withdrawals_createdAt_idx" ON "food_restaurant_withdrawals"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "food_delivery_withdrawals_deliveryPartnerId_idx" ON "food_delivery_withdrawals"("deliveryPartnerId");

-- CreateIndex
CREATE INDEX "food_delivery_withdrawals_status_idx" ON "food_delivery_withdrawals"("status");

-- CreateIndex
CREATE INDEX "food_delivery_withdrawals_createdAt_idx" ON "food_delivery_withdrawals"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "food_delivery_cash_deposits_deliveryPartnerId_idx" ON "food_delivery_cash_deposits"("deliveryPartnerId");

-- CreateIndex
CREATE INDEX "food_delivery_cash_deposits_status_idx" ON "food_delivery_cash_deposits"("status");

-- CreateIndex
CREATE INDEX "food_delivery_cash_deposits_createdAt_idx" ON "food_delivery_cash_deposits"("createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "food_delivery_bonus_transactions_transactionRef_key" ON "food_delivery_bonus_transactions"("transactionRef");

-- CreateIndex
CREATE INDEX "food_delivery_bonus_transactions_deliveryPartnerId_createdA_idx" ON "food_delivery_bonus_transactions"("deliveryPartnerId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "food_earning_addons_title_idx" ON "food_earning_addons"("title");

-- CreateIndex
CREATE INDEX "food_earning_addons_status_startDate_endDate_idx" ON "food_earning_addons"("status", "startDate", "endDate");

-- CreateIndex
CREATE INDEX "food_earning_addon_history_deliveryPartnerId_completedAt_idx" ON "food_earning_addon_history"("deliveryPartnerId", "completedAt" DESC);

-- CreateIndex
CREATE INDEX "food_earning_addon_history_offerId_deliveryPartnerId_status_idx" ON "food_earning_addon_history"("offerId", "deliveryPartnerId", "status");

-- CreateIndex
CREATE INDEX "food_support_tickets_userId_createdAt_idx" ON "food_support_tickets"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "food_support_tickets_status_idx" ON "food_support_tickets"("status");

-- CreateIndex
CREATE INDEX "food_restaurant_support_tickets_restaurantId_createdAt_idx" ON "food_restaurant_support_tickets"("restaurantId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "food_restaurant_support_tickets_status_createdAt_idx" ON "food_restaurant_support_tickets"("status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "food_restaurant_support_tickets_priority_idx" ON "food_restaurant_support_tickets"("priority");

-- CreateIndex
CREATE UNIQUE INDEX "food_delivery_support_tickets_ticketRef_key" ON "food_delivery_support_tickets"("ticketRef");

-- CreateIndex
CREATE INDEX "food_delivery_support_tickets_deliveryPartnerId_createdAt_idx" ON "food_delivery_support_tickets"("deliveryPartnerId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "food_delivery_support_tickets_status_createdAt_idx" ON "food_delivery_support_tickets"("status", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "food_delivery_order_emergency_requests_activeKey_key" ON "food_delivery_order_emergency_requests"("activeKey");

-- CreateIndex
CREATE INDEX "food_delivery_order_emergency_requests_orderId_idx" ON "food_delivery_order_emergency_requests"("orderId");

-- CreateIndex
CREATE INDEX "food_delivery_order_emergency_requests_deliveryPartnerId_cr_idx" ON "food_delivery_order_emergency_requests"("deliveryPartnerId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "food_delivery_order_emergency_requests_restaurantId_idx" ON "food_delivery_order_emergency_requests"("restaurantId");

-- CreateIndex
CREATE INDEX "food_delivery_order_emergency_requests_status_createdAt_idx" ON "food_delivery_order_emergency_requests"("status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "food_safety_emergency_reports_userId_idx" ON "food_safety_emergency_reports"("userId");

-- CreateIndex
CREATE INDEX "food_safety_emergency_reports_createdAt_idx" ON "food_safety_emergency_reports"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "food_safety_emergency_reports_status_priority_createdAt_idx" ON "food_safety_emergency_reports"("status", "priority", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "food_chat_conversations_conversationId_key" ON "food_chat_conversations"("conversationId");

-- CreateIndex
CREATE INDEX "food_chat_conversations_orderId_createdAt_idx" ON "food_chat_conversations"("orderId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "food_chat_conversations_status_idx" ON "food_chat_conversations"("status");

-- CreateIndex
CREATE INDEX "food_chat_messages_conversationId_createdAt_idx" ON "food_chat_messages"("conversationId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "food_chat_messages_recipientToken_readAt_idx" ON "food_chat_messages"("recipientToken", "readAt");

-- CreateIndex
CREATE INDEX "food_chat_messages_orderId_idx" ON "food_chat_messages"("orderId");

-- CreateIndex
CREATE INDEX "food_notifications_ownerType_ownerId_createdAt_idx" ON "food_notifications"("ownerType", "ownerId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "food_notifications_ownerType_ownerId_isRead_dismissedAt_idx" ON "food_notifications"("ownerType", "ownerId", "isRead", "dismissedAt");

-- CreateIndex
CREATE INDEX "food_notifications_createdAt_idx" ON "food_notifications"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "food_notifications_broadcastId_ownerType_ownerId_key" ON "food_notifications"("broadcastId", "ownerType", "ownerId");

-- CreateIndex
CREATE INDEX "food_notification_broadcasts_targetType_idx" ON "food_notification_broadcasts"("targetType");

-- CreateIndex
CREATE INDEX "food_notification_broadcasts_createdById_idx" ON "food_notification_broadcasts"("createdById");

-- CreateIndex
CREATE INDEX "food_notification_broadcasts_createdAt_idx" ON "food_notification_broadcasts"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "food_feedback_experiences_module_createdAt_idx" ON "food_feedback_experiences"("module", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "food_feedback_experiences_userId_createdAt_idx" ON "food_feedback_experiences"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "food_feedback_experiences_restaurantId_idx" ON "food_feedback_experiences"("restaurantId");

-- CreateIndex
CREATE UNIQUE INDEX "food_dining_categories_slug_key" ON "food_dining_categories"("slug");

-- CreateIndex
CREATE INDEX "food_dining_categories_isActive_sortOrder_createdAt_idx" ON "food_dining_categories"("isActive", "sortOrder", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "food_dining_restaurants_restaurantId_key" ON "food_dining_restaurants"("restaurantId");

-- CreateIndex
CREATE INDEX "food_dining_restaurants_isEnabled_primaryCategoryId_idx" ON "food_dining_restaurants"("isEnabled", "primaryCategoryId");

-- CreateIndex
CREATE INDEX "food_hero_banners_isActive_sortOrder_idx" ON "food_hero_banners"("isActive", "sortOrder");

-- CreateIndex
CREATE INDEX "food_under250_banners_isActive_sortOrder_idx" ON "food_under250_banners"("isActive", "sortOrder");

-- CreateIndex
CREATE INDEX "food_dining_banners_isActive_sortOrder_idx" ON "food_dining_banners"("isActive", "sortOrder");

-- CreateIndex
CREATE INDEX "food_home_promotion_banners_isActive_sortOrder_idx" ON "food_home_promotion_banners"("isActive", "sortOrder");

-- CreateIndex
CREATE INDEX "food_home_promotion_banners_zoneId_idx" ON "food_home_promotion_banners"("zoneId");

-- CreateIndex
CREATE INDEX "food_restaurant_app_banners_isActive_sortOrder_idx" ON "food_restaurant_app_banners"("isActive", "sortOrder");

-- CreateIndex
CREATE INDEX "top_banners_isActive_order_idx" ON "top_banners"("isActive", "order");

-- CreateIndex
CREATE INDEX "food_explore_icons_isActive_sortOrder_idx" ON "food_explore_icons"("isActive", "sortOrder");

-- CreateIndex
CREATE INDEX "food_gourmet_restaurants_restaurantId_idx" ON "food_gourmet_restaurants"("restaurantId");

-- CreateIndex
CREATE INDEX "food_gourmet_restaurants_isActive_priority_idx" ON "food_gourmet_restaurants"("isActive", "priority");

-- CreateIndex
CREATE INDEX "food_unregistered_restaurants_createdAt_idx" ON "food_unregistered_restaurants"("createdAt" DESC);

-- AddForeignKey
ALTER TABLE "food_users" ADD CONSTRAINT "food_users_referredById_fkey" FOREIGN KEY ("referredById") REFERENCES "food_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_user_addresses" ADD CONSTRAINT "food_user_addresses_userId_fkey" FOREIGN KEY ("userId") REFERENCES "food_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_restaurants" ADD CONSTRAINT "food_restaurants_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "food_zones"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_restaurants" ADD CONSTRAINT "food_restaurants_pendingZoneId_fkey" FOREIGN KEY ("pendingZoneId") REFERENCES "food_zones"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_delivery_partners" ADD CONSTRAINT "food_delivery_partners_referredById_fkey" FOREIGN KEY ("referredById") REFERENCES "food_delivery_partners"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_admins" ADD CONSTRAINT "food_admins_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "food_admins"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_admins" ADD CONSTRAINT "food_admins_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "food_admins"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_entityType_entityId_fkey" FOREIGN KEY ("entityType", "entityId") REFERENCES "wallets"("entityType", "entityId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "food_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "settlements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "food_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "food_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "food_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_userId_fkey" FOREIGN KEY ("userId") REFERENCES "food_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_orders" ADD CONSTRAINT "food_orders_userId_fkey" FOREIGN KEY ("userId") REFERENCES "food_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_orders" ADD CONSTRAINT "food_orders_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "food_restaurants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_orders" ADD CONSTRAINT "food_orders_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "food_zones"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_orders" ADD CONSTRAINT "food_orders_dispatchDeliveryPartnerId_fkey" FOREIGN KEY ("dispatchDeliveryPartnerId") REFERENCES "food_delivery_partners"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_order_items" ADD CONSTRAINT "food_order_items_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "food_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_order_item_ratings" ADD CONSTRAINT "food_order_item_ratings_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "food_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_order_status_history" ADD CONSTRAINT "food_order_status_history_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "food_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_order_dispatch_offers" ADD CONSTRAINT "food_order_dispatch_offers_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "food_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_order_dispatch_offers" ADD CONSTRAINT "food_order_dispatch_offers_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "food_delivery_partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_transactions" ADD CONSTRAINT "food_transactions_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "food_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_transactions" ADD CONSTRAINT "food_transactions_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "food_restaurants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_transactions" ADD CONSTRAINT "food_transactions_deliveryPartnerId_fkey" FOREIGN KEY ("deliveryPartnerId") REFERENCES "food_delivery_partners"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_transaction_history" ADD CONSTRAINT "food_transaction_history_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "food_transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_items" ADD CONSTRAINT "food_items_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "food_restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_items" ADD CONSTRAINT "food_items_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "food_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_categories" ADD CONSTRAINT "food_categories_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "food_restaurants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_categories" ADD CONSTRAINT "food_categories_createdByRestaurantId_fkey" FOREIGN KEY ("createdByRestaurantId") REFERENCES "food_restaurants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_categories" ADD CONSTRAINT "food_categories_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "food_zones"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_addons" ADD CONSTRAINT "food_addons_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "food_restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_restaurant_menus" ADD CONSTRAINT "food_restaurant_menus_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "food_restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_restaurant_outlet_timings" ADD CONSTRAINT "food_restaurant_outlet_timings_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "food_restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_user_carts" ADD CONSTRAINT "food_user_carts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "food_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_user_favorites" ADD CONSTRAINT "food_user_favorites_userId_fkey" FOREIGN KEY ("userId") REFERENCES "food_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_offers" ADD CONSTRAINT "food_offers_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "food_restaurants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_offer_usages" ADD CONSTRAINT "food_offer_usages_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "food_offers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_offer_usages" ADD CONSTRAINT "food_offer_usages_userId_fkey" FOREIGN KEY ("userId") REFERENCES "food_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_restaurant_commissions" ADD CONSTRAINT "food_restaurant_commissions_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "food_restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_subscription_invoices" ADD CONSTRAINT "food_subscription_invoices_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "food_restaurants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_subscription_transactions" ADD CONSTRAINT "food_subscription_transactions_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "food_restaurants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_subscription_transactions" ADD CONSTRAINT "food_subscription_transactions_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "food_subscription_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_restaurant_subscription_history" ADD CONSTRAINT "food_restaurant_subscription_history_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "food_restaurants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_restaurant_withdrawals" ADD CONSTRAINT "food_restaurant_withdrawals_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "food_restaurants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_delivery_withdrawals" ADD CONSTRAINT "food_delivery_withdrawals_deliveryPartnerId_fkey" FOREIGN KEY ("deliveryPartnerId") REFERENCES "food_delivery_partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_delivery_cash_deposits" ADD CONSTRAINT "food_delivery_cash_deposits_deliveryPartnerId_fkey" FOREIGN KEY ("deliveryPartnerId") REFERENCES "food_delivery_partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_delivery_bonus_transactions" ADD CONSTRAINT "food_delivery_bonus_transactions_deliveryPartnerId_fkey" FOREIGN KEY ("deliveryPartnerId") REFERENCES "food_delivery_partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_earning_addon_history" ADD CONSTRAINT "food_earning_addon_history_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "food_earning_addons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_earning_addon_history" ADD CONSTRAINT "food_earning_addon_history_deliveryPartnerId_fkey" FOREIGN KEY ("deliveryPartnerId") REFERENCES "food_delivery_partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_support_tickets" ADD CONSTRAINT "food_support_tickets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "food_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_support_tickets" ADD CONSTRAINT "food_support_tickets_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "food_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_support_tickets" ADD CONSTRAINT "food_support_tickets_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "food_restaurants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_restaurant_support_tickets" ADD CONSTRAINT "food_restaurant_support_tickets_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "food_restaurants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_delivery_support_tickets" ADD CONSTRAINT "food_delivery_support_tickets_deliveryPartnerId_fkey" FOREIGN KEY ("deliveryPartnerId") REFERENCES "food_delivery_partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_delivery_order_emergency_requests" ADD CONSTRAINT "food_delivery_order_emergency_requests_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "food_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_delivery_order_emergency_requests" ADD CONSTRAINT "food_delivery_order_emergency_requests_deliveryPartnerId_fkey" FOREIGN KEY ("deliveryPartnerId") REFERENCES "food_delivery_partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_delivery_order_emergency_requests" ADD CONSTRAINT "food_delivery_order_emergency_requests_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "food_restaurants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_delivery_order_emergency_requests" ADD CONSTRAINT "food_delivery_order_emergency_requests_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "food_admins"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_safety_emergency_reports" ADD CONSTRAINT "food_safety_emergency_reports_userId_fkey" FOREIGN KEY ("userId") REFERENCES "food_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_chat_conversations" ADD CONSTRAINT "food_chat_conversations_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "food_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_chat_messages" ADD CONSTRAINT "food_chat_messages_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "food_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_notifications" ADD CONSTRAINT "food_notifications_broadcastId_fkey" FOREIGN KEY ("broadcastId") REFERENCES "food_notification_broadcasts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_notification_broadcasts" ADD CONSTRAINT "food_notification_broadcasts_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "food_admins"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_feedback_experiences" ADD CONSTRAINT "food_feedback_experiences_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "food_restaurants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_dining_restaurants" ADD CONSTRAINT "food_dining_restaurants_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "food_restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_dining_restaurants" ADD CONSTRAINT "food_dining_restaurants_primaryCategoryId_fkey" FOREIGN KEY ("primaryCategoryId") REFERENCES "food_dining_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_home_promotion_banners" ADD CONSTRAINT "food_home_promotion_banners_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "food_zones"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_gourmet_restaurants" ADD CONSTRAINT "food_gourmet_restaurants_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "food_restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

