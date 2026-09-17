/**
 * Riders: `delivery_men` -> food_delivery_partners.
 *
 * Written directly: the only service that creates a rider is self-registration,
 * which puts every rider back through approval. Login needs no new credentials
 * -- it is an OTP to the rider's phone, matched on its last ten digits.
 *
 * Riders the old admin deleted are imported too, as deactivated placeholders.
 * The old system deleted the rider row but kept their orders, earnings and the
 * cash they were holding, and without an account to hang those on here the
 * order history would lose its rider and the cash owed would vanish from every
 * total. Nothing about them survives but the id, so that is all they carry;
 * their "phone" can never be logged in with.
 */
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../../../src/config/prisma.js';
import { config } from '../../../src/config/env.js';
import { buildPublicUrl } from '../../../src/services/storage.service.js';
import { loadIdMap, recordId } from '../idMap.mjs';

const ENTITY = 'delivery_partner';
const IMAGE_DIR = 'legacy/delivery-man';

const last10 = (phone) => String(phone || '').replace(/\D/g, '').slice(-10);

const parseJson = (raw, fallback) => {
    try {
        return raw ? JSON.parse(raw) : fallback;
    } catch {
        return fallback;
    }
};

const imageUrl = (file, missing) => {
    const name = String(file || '').trim();
    if (!name || name === 'def.png') return null;
    if (fs.existsSync(path.join(config.uploadStorageRoot || 'uploads', IMAGE_DIR, name))) {
        return buildPublicUrl(`${IMAGE_DIR}/${name}`);
    }
    missing.push(name);
    return null;
};

/** One emailed typo ("name@gmail.com>") is trimmed rather than dropped. */
const emailOf = (value) => {
    const email = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+$/, '');
    return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(email) ? email : null;
};

/**
 * Approval: application approved and switched on is approved; an admin
 * switching an approved rider off is a deactivation; a denied application is
 * a rejection.
 */
const statusOf = (row) => {
    if (row.application_status === 'denied') {
        return { status: 'rejected', rejectedAt: row.updated_at || new Date(), rejectionReason: 'Application denied' };
    }
    if (row.application_status !== 'approved') return { status: 'pending' };
    if (row.status !== 1) return { status: 'deactivated', approvedAt: row.created_at, rejectionReason: 'Suspended by admin' };
    return { status: 'approved', approvedAt: row.created_at || new Date() };
};

/**
 * The old app asked for "an identity" of a chosen type. A driving licence and
 * an Aadhaar (the old "nid") have fields here; anything else -- mostly the
 * "store_id" option, filled with made-up numbers -- is kept as a custom field
 * so nothing is lost. Every uploaded image is kept, the first in the matching
 * photo field.
 */
const identityOf = (row, missing) => {
    const number = String(row.identity_number || '').trim();
    const images = (parseJson(row.identity_image, []) || [])
        .map((entry) => imageUrl(entry?.img, missing))
        .filter(Boolean);
    const common = {
        customFields: { legacyIdentityType: row.identity_type || '', legacyIdentityNumber: number },
        customDocuments: images.length ? { legacyIdentityImages: images } : {},
    };
    if (row.identity_type === 'driving_license') {
        return { ...common, drivingLicenseNumber: number || null, drivingLicensePhoto: images[0] || null };
    }
    if (row.identity_type === 'nid') {
        return { ...common, aadharNumber: number || null, aadharPhoto: images[0] || null };
    }
    return common;
};

export async function importDeliveryPartners(mysql, report) {
    const idMap = await loadIdMap(ENTITY);
    const [rows] = await mysql.query('SELECT * FROM delivery_men ORDER BY id');
    const [[vehicle]] = await mysql.query('SELECT type FROM d_m_vehicles WHERE id = 2');
    const vehicleNames = new Map([[2, String(vehicle?.type || 'Bike')]]);
    const missing = [];

    const save = async (legacyId, data, label) => {
        const mappedId = idMap.get(String(legacyId));
        const exists = mappedId && (await prisma.foodDeliveryPartner.count({ where: { id: mappedId } })) > 0;
        let partner;
        try {
            partner = exists
                ? await prisma.foodDeliveryPartner.update({ where: { id: mappedId }, data, select: { id: true } })
                : await prisma.foodDeliveryPartner.create({ data, select: { id: true } });
        } catch (error) {
            report.skip(ENTITY, legacyId, label, error.message.split('\n').pop());
            return;
        }
        await recordId(ENTITY, legacyId, partner.id);
        idMap.set(String(legacyId), partner.id);
        report.done(ENTITY, exists ? 'updated' : 'created');
    };

    for (const row of rows) {
        const phone = last10(row.phone);
        if (phone.length !== 10) {
            report.skip(ENTITY, row.id, row.phone, 'phone is not a 10-digit number');
            continue;
        }
        const first = String(row.f_name || '').trim();
        const last = String(row.l_name || '').trim();
        const vehicleName = vehicleNames.get(Number(row.vehicle_id)) || '';

        await save(row.id, {
            name: (first === last ? first : `${first} ${last}`).trim() || `Rider ${phone}`,
            phone,
            countryCode: '+91',
            email: emailOf(row.email),
            profilePhoto: imageUrl(row.image, missing),
            vehicleType: vehicleName.toLowerCase() === 'bike' ? 'bike' : vehicleName.toLowerCase() || null,
            vehicleName: vehicleName || null,
            ...identityOf(row, missing),
            ...statusOf(row),
            // Everyone starts offline; their old app's online switch means nothing here.
            availabilityStatus: 'offline',
            totalDeliveries: Number(row.order_count) || 0,
            ...(row.created_at ? { createdAt: row.created_at } : {}),
        }, row.phone);
    }

    // Riders the old admin deleted, wherever something still points at them.
    const [orphans] = await mysql.query(`
        SELECT id FROM (
            SELECT delivery_man_id AS id FROM orders WHERE delivery_man_id IS NOT NULL
            UNION SELECT delivery_man_id FROM delivery_man_wallets
            UNION SELECT from_id FROM account_transactions WHERE from_type = 'deliveryman'
        ) referenced
        WHERE id NOT IN (SELECT id FROM delivery_men)
        ORDER BY id`);

    for (const { id } of orphans) {
        await save(id, {
            name: `Former rider #${id}`,
            // Not ten digits, so no OTP login can ever match it.
            phone: `legacy-dm-${id}`,
            status: 'deactivated',
            rejectionReason: 'Deleted in the previous system; kept for order history and cash owed',
            availabilityStatus: 'offline',
        }, `deleted rider #${id}`);
    }
    if (orphans.length) {
        report.warn(ENTITY, '-', '(all)',
            `${orphans.length} rider(s) deleted in the old system still had orders or a wallet; imported as deactivated "Former rider #id" placeholders (no name or phone survives)`);
    }
    if (missing.length) {
        report.warn(ENTITY, '-', '(all)', `${missing.length} rider image(s) not found in the copied storage`);
    }
}
