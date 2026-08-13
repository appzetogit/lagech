import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import { recordTransaction } from '../../../../core/payments/transaction.service.js';
import { logger } from '../../../../utils/logger.js';

/**
 * Platform settings the rest of the app reads.
 *
 * Extracted from admin.service.js, which is 6,453 lines. Four ported modules
 * (delivery finance, dispatch, restaurant onboarding, referrals) import these,
 * so they were the last Mongoose dependency reaching into otherwise-migrated
 * code. Keeping them here also means a settings accessor is no longer buried in
 * the same file as every admin CRUD screen.
 *
 * admin.service.js re-exports everything below, so existing imports still work.
 */

/** Newest active row of a singleton-ish settings table. */
const newestActive = (delegate) =>
    delegate.findFirst({ where: { isActive: true }, orderBy: { createdAt: 'desc' } });

// ───────────────────────── Delivery cash limits ─────────────────────────

export async function getDeliveryCashLimitSettings() {
    const doc = await newestActive(prisma.foodDeliveryCashLimit);
    return {
        deliveryCashLimit: Number(doc?.deliveryCashLimit) || 0,
        deliveryWithdrawalLimit: Number(doc?.deliveryWithdrawalLimit) || 100,
    };
}

export async function upsertDeliveryCashLimitSettings(body = {}) {
    const existing = await newestActive(prisma.foodDeliveryCashLimit);
    const clamp = (v, fallback) => (v === undefined ? fallback : Math.max(0, Number(v) || 0));

    const data = {
        deliveryCashLimit: clamp(body.deliveryCashLimit, existing?.deliveryCashLimit ?? 0),
        deliveryWithdrawalLimit: clamp(body.deliveryWithdrawalLimit, existing?.deliveryWithdrawalLimit ?? 100),
    };

    const saved = existing
        ? await prisma.foodDeliveryCashLimit.update({ where: { id: existing.id }, data })
        : await prisma.foodDeliveryCashLimit.create({ data: { ...data, isActive: true } });

    return {
        deliveryCashLimit: Number(saved.deliveryCashLimit),
        deliveryWithdrawalLimit: Number(saved.deliveryWithdrawalLimit),
    };
}

// ───────────────────────── Delivery emergency help ─────────────────────────

/** Indian emergency numbers, used when nothing is configured. */
const EMERGENCY_DEFAULTS = {
    medicalEmergency: '102',
    accidentHelpline: '108',
    contactPolice: '100',
    insurance: '',
};

export async function getDeliveryEmergencyHelp() {
    const doc = await newestActive(prisma.foodDeliveryEmergencyHelp);
    const data = doc || EMERGENCY_DEFAULTS;

    return {
        medicalEmergency: String(data.medicalEmergency || EMERGENCY_DEFAULTS.medicalEmergency).trim(),
        accidentHelpline: String(data.accidentHelpline || EMERGENCY_DEFAULTS.accidentHelpline).trim(),
        contactPolice: String(data.contactPolice || EMERGENCY_DEFAULTS.contactPolice).trim(),
        insurance: String(data.insurance || '').trim(),
    };
}

export async function upsertDeliveryEmergencyHelp(body = {}) {
    const existing = await newestActive(prisma.foodDeliveryEmergencyHelp);

    const data = {};
    for (const key of ['medicalEmergency', 'accidentHelpline', 'contactPolice', 'insurance']) {
        if (body[key] !== undefined) data[key] = String(body[key] || '').trim();
    }

    const saved = existing
        ? await prisma.foodDeliveryEmergencyHelp.update({ where: { id: existing.id }, data })
        : await prisma.foodDeliveryEmergencyHelp.create({ data: { ...data, isActive: true } });

    return {
        medicalEmergency: saved.medicalEmergency || '',
        accidentHelpline: saved.accidentHelpline || '',
        contactPolice: saved.contactPolice || '',
        insurance: saved.insurance || '',
    };
}

// ───────────────────────── Restaurant subscription plans ─────────────────────────

export const getRestaurantSubscriptionSettings = async () => {
    const raw = (await prisma.foodRestaurantSubscriptionSettings.findFirst()) || {};

    const num = (value, fallback) => Number(value ?? fallback) || fallback;
    // silverPrice / goldPrice were the old field names; still read so an
    // un-migrated settings row keeps its configured prices.
    const starterPrice = num(raw.starterPrice ?? raw.silverPrice, 999);
    const growthPrice = num(raw.growthPrice ?? raw.goldPrice, 1999);
    const premiumPrice = num(raw.premiumPrice, 2999);
    const starterMinGmv = Number(raw.starterMinGmv ?? 0) || 0;
    const starterMaxGmv = num(raw.starterMaxGmv, 30000);
    const growthMinGmv = num(raw.growthMinGmv, starterMaxGmv + 0.01);
    const growthMaxGmv = num(raw.growthMaxGmv, 60000);
    const premiumMinGmv = num(raw.premiumMinGmv, growthMaxGmv + 0.01);
    const onboardingFee = Math.max(0, Number(raw.onboardingFee ?? 0) || 0);

    const bands = {
        starterPrice, growthPrice, premiumPrice,
        starterMinGmv, starterMaxGmv, growthMinGmv, growthMaxGmv, premiumMinGmv,
    };

    try {
        const { buildPlanCatalog, GST_RATE } = await import(
            '../../restaurant/services/subscriptionPlan.service.js'
        );
        return {
            ...raw,
            ...bands,
            onboardingFee,
            planCatalog: buildPlanCatalog(bands),
            gstRate: GST_RATE,
        };
    } catch (err) {
        // The catalog is presentation; the prices are what billing needs.
        logger.warn(`Plan catalog unavailable: ${err?.message || err}`);
        return { ...raw, ...bands, onboardingFee, planCatalog: null };
    }
};

// ───────────────────────── Delivery partner bonuses ─────────────────────────

function generateBonusTransactionId() {
    const n = Date.now().toString(36).slice(-6).toUpperCase();
    const r = Math.random().toString(36).slice(2, 6).toUpperCase();
    return `BON-${n}${r}`;
}

/**
 * Credit an ad-hoc bonus to a delivery partner.
 *
 * The credit goes through the wallet ledger rather than incrementing the balance
 * directly, which is what this did before — making it another writer racing the
 * real one, and leaving the bonus invisible in transaction history. The bonus
 * row's own id is the idempotency key, so a retried admin submit cannot pay
 * twice.
 */
export async function addDeliveryPartnerBonus(body, adminUser) {
    if (!isId(body?.deliveryPartnerId)) throw new ValidationError('Delivery partner not found');

    const partner = await prisma.foodDeliveryPartner.findUnique({
        where: { id: String(body.deliveryPartnerId) },
        select: { id: true, status: true },
    });
    if (!partner) throw new ValidationError('Delivery partner not found');
    if (partner.status !== 'approved') throw new ValidationError('Delivery partner must be approved');

    const amountToCredit = Number(body.amount) || 0;
    if (amountToCredit <= 0) throw new ValidationError('Bonus amount must be greater than 0');

    // transactionId is unique, so a collision retries rather than needing a
    // check-then-insert loop that raced with itself.
    let created = null;
    for (let attempt = 0; attempt < 5 && !created; attempt += 1) {
        try {
            created = await prisma.deliveryBonusTransaction.create({
                data: {
                    deliveryPartnerId: partner.id,
                    transactionId: generateBonusTransactionId(),
                    amount: amountToCredit,
                    reference: body.reference || '',
                    createdByAdminId: adminUser?.id || adminUser?._id || null,
                },
            });
        } catch (err) {
            if (err?.code !== 'P2002') throw err;
        }
    }
    if (!created) throw new ValidationError('Could not allocate a bonus id. Please try again.');

    await recordTransaction({
        entityType: 'deliveryBoy',
        entityId: partner.id,
        type: 'credit',
        amount: amountToCredit,
        description: body.reference ? `Bonus - ${body.reference}` : 'Bonus',
        category: 'adjustment',
        idempotencyKey: `delivery_bonus:${created.id}`,
        metadata: { source: 'admin_bonus', bonusId: created.id, transactionId: created.transactionId },
    });

    // totalBonus is a lifetime counter the ledger does not track.
    await prisma.wallet.update({
        where: { entityType_entityId: { entityType: 'deliveryBoy', entityId: partner.id } },
        data: { totalBonus: { increment: amountToCredit } },
    });

    try {
        const { notifyOwnerSafely } = await import('../../../../core/notifications/firebase.service.js');
        await notifyOwnerSafely(
            { ownerType: 'DELIVERY_PARTNER', ownerId: partner.id },
            {
                title: 'Bonus Credited!',
                body: `You have received a bonus of ₹${amountToCredit}. ${body.reference || 'Great job!'}`,
                image: 'https://i.ibb.co/5GzXz7r/Switcheats-Brand-Image.png',
                data: {
                    type: 'bonus_credited',
                    amount: String(amountToCredit),
                    transactionId: created.transactionId,
                },
            },
        );
    } catch (e) {
        logger.warn(`Failed to send bonus notification: ${e?.message || e}`);
    }

    return created;
}
