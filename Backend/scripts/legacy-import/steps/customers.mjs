/**
 * Customers: `users` -> food_users, `customer_addresses` -> food_user_addresses.
 *
 * Written directly: the only service that creates a customer is OTP login,
 * which is the thing an imported customer has not done yet on this system.
 * They need no new credentials -- login is an OTP to the same phone.
 *
 * Phones are stored as the last ten digits. The old system kept "+91XXXXXXXXXX";
 * the customer app strips the country code before it asks for an OTP, and
 * login looks the customer up by that exact string, so a phone stored with
 * "+91" would never be found and the customer would land in a new, empty
 * account.
 */
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../../../src/config/prisma.js';
import { config } from '../../../src/config/env.js';
import { buildPublicUrl } from '../../../src/services/storage.service.js';
import { loadIdMap, recordId } from '../idMap.mjs';
import { byId, classifyProtected, fillBlanks, guardedUpdate, same } from '../sync.mjs';

const USER = 'user';
const ADDRESS = 'address';
const IMAGE_DIR = 'legacy/profile';

const last10 = (phone) => String(phone || '').replace(/\D/g, '').slice(-10);

/** "Siddharth Bhosale", from first and last names some people typed twice. */
const fullName = (row) => {
    const first = String(row.f_name || '').trim();
    const last = String(row.l_name || '').trim();
    const name = (first === last ? first : `${first} ${last}`).trim();
    // Blank stays blank: the app asks a customer with no name for one.
    return name || null;
};

const emailOf = (value) => {
    const email = String(value || '').trim().toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
};

const imageUrl = (file) => {
    const name = String(file || '').trim();
    if (!name || name === 'def.png') return '';
    const onDisk = path.join(config.uploadStorageRoot || 'uploads', IMAGE_DIR, name);
    return fs.existsSync(onDisk) ? buildPublicUrl(`${IMAGE_DIR}/${name}`) : null;
};

const LABELS = { home: 'Home', office: 'Office', others: 'Other', other: 'Other' };

/**
 * City, state and PIN from a Google-formatted address, which is what the old
 * app saved: "XCWP+G2V, Mahadevnagar, Phaltan, Maharashtra 415523, India".
 * Anything else (typed by hand, or in Marathi) returns blanks, and the caller
 * falls back to the zone the pin sits in.
 */
export const parseFormattedAddress = (text) => {
    const parts = String(text || '').split(',').map((part) => part.trim()).filter(Boolean);
    if (parts.length && /^india$/i.test(parts[parts.length - 1])) parts.pop();
    const stateAndPin = parts.length ? /^([A-Za-z .]+?)\s+(\d{6})$/.exec(parts[parts.length - 1]) : null;
    if (!stateAndPin) return { city: '', state: '', zipCode: '' };
    const city = parts.length >= 2 ? parts[parts.length - 2] : '';
    return {
        // A plus-code ("XCWP+G2V") is not a city.
        city: /\+/.test(city) ? '' : city,
        state: stateAndPin[1].trim(),
        zipCode: stateAndPin[2],
    };
};

/** One old customer row as this system's columns. */
const userData = (row, image) => ({
    phone: last10(row.phone),
    countryCode: '+91',
    name: fullName(row),
    email: emailOf(row.email),
    profileImage: image || '',
    isVerified: row.is_phone_verified === 1,
    isActive: row.status === 1,
    ...(row.created_at ? { createdAt: row.created_at } : {}),
});

/** Sync: what may change on a customer imported before. */
const USER_FILL = ['name', 'email', 'profileImage'];
const USER_STATUS = ['isActive'];
const USER_VERIFIED = ['isVerified'];

/**
 * Sync rules for one already-imported customer, as a patch: blanks filled,
 * active/blocked following the old system only while this system still holds
 * the imported value. Exported for the test.
 */
export function planUserSync(current, original, target) {
    const fill = fillBlanks(current, target, USER_FILL);
    const status = guardedUpdate(current, original, target, USER_STATUS);
    const verified = guardedUpdate(current, original, target, USER_VERIFIED);
    return {
        patch: { ...fill.patch, ...status.patch, ...verified.patch },
        kept: [...fill.kept, ...(status.protected ? USER_STATUS : []), ...(verified.protected ? USER_VERIFIED : [])],
    };
}

async function syncUser(row, mappedId, baselineRow, report) {
    const current = await prisma.foodUser.findUnique({
        where: { id: mappedId },
        select: { id: true, name: true, email: true, profileImage: true, isActive: true, isVerified: true },
    });
    if (!current) {
        report.skip(USER, row.id, row.phone, 'imported before but deleted here since; not recreated');
        return null;
    }
    const target = userData(row, imageUrl(row.image));
    const original = baselineRow ? userData(baselineRow, imageUrl(baselineRow.image)) : null;
    const { patch, kept } = planUserSync(current, original, target);
    // Only what the old system changed counts as "left alone"; a value that
    // differs because it was edited here, with the old one unchanged, is just
    // this system's own data.
    const legacyMoved = original ? kept.filter((field) => !same(original[field], target[field])) : kept;
    if (Object.keys(patch).length) {
        await prisma.foodUser.update({ where: { id: mappedId }, data: patch });
        report.done(USER, 'updated');
        report.detail(USER, Object.keys(patch));
    } else {
        report.done(USER, legacyMoved.length ? 'protected' : 'unchanged');
    }
    if (legacyMoved.length) report.detail(USER, legacyMoved.map((field) => `${field} (kept)`));
    return mappedId;
}

async function importUsers(mysql, report, ctx = {}) {
    const idMap = await loadIdMap(USER);
    const [rows] = await mysql.query('SELECT * FROM users ORDER BY id');
    const baseline = ctx.sync ? byId((await ctx.baseline.query('SELECT * FROM users ORDER BY id'))[0]) : null;

    const notCarried = { firebaseTokens: 0, referralCodes: 0, missingImages: 0 };

    for (const row of rows) {
        const phone = last10(row.phone);
        if (phone.length !== 10) {
            report.skip(USER, row.id, row.phone, 'phone is not a 10-digit number');
            continue;
        }

        const mappedId = idMap.get(String(row.id));
        if (ctx.sync && mappedId) {
            await syncUser(row, mappedId, baseline.get(String(row.id)), report);
            continue;
        }

        const image = imageUrl(row.image);
        if (image === null) notCarried.missingImages += 1;
        if (row.cm_firebase_token) notCarried.firebaseTokens += 1;
        if (row.ref_code) notCarried.referralCodes += 1;

        const data = userData(row, image);

        let existing = mappedId
            ? await prisma.foodUser.findUnique({ where: { id: mappedId }, select: { id: true } })
            : null;
        let adopted = false;
        if (!existing) {
            // Someone may already have signed in on this system with the same
            // phone. That is the same person: link to their account instead of
            // failing on the unique phone, and leave what they set there alone.
            existing = await prisma.foodUser.findUnique({
                where: { phone },
                select: { id: true, name: true, email: true, profileImage: true },
            });
            adopted = Boolean(existing);
        }

        let userId;
        if (!existing) {
            userId = (await prisma.foodUser.create({ data, select: { id: true } })).id;
            report.done(USER, 'created');
        } else if (adopted) {
            await prisma.foodUser.update({
                where: { id: existing.id },
                data: {
                    ...(existing.name ? {} : { name: data.name }),
                    ...(existing.email ? {} : { email: data.email }),
                    ...(existing.profileImage ? {} : { profileImage: data.profileImage }),
                    // Sync: an account made here since keeps its own status and
                    // sign-up date; only blanks are filled.
                    ...(ctx.sync ? {} : { isActive: data.isActive }),
                    ...(row.created_at && !ctx.sync ? { createdAt: row.created_at } : {}),
                },
            });
            userId = existing.id;
            report.warn(USER, row.id, phone, 'already had an account here; linked to it, keeping its own name and email');
            report.done(USER, 'updated');
        } else {
            await prisma.foodUser.update({ where: { id: existing.id }, data });
            userId = existing.id;
            report.done(USER, 'updated');
        }

        await recordId(USER, row.id, userId);
        idMap.set(String(row.id), userId);
    }

    // Who referred whom, once everyone exists. Counted from the links, so a
    // re-run cannot inflate it. A sync only links customers it brought in now,
    // and never replaces a referrer already recorded here.
    const referred = rows.filter((row) => row.ref_by && (!ctx.sync || ctx.isCreated(USER, row.id)));
    for (const row of referred) {
        const userId = idMap.get(String(row.id));
        const referrerId = idMap.get(String(row.ref_by));
        if (!userId || !referrerId || userId === referrerId) {
            report.warn(USER, row.id, row.phone, `referrer ${row.ref_by} not imported; referral link dropped`);
            continue;
        }
        await prisma.foodUser.updateMany({
            where: { id: userId, ...(ctx.sync ? { referredById: null } : {}) },
            data: { referredById: referrerId },
        });
    }
    const referrers = new Set(referred.map((row) => idMap.get(String(row.ref_by))).filter(Boolean));
    for (const referrerId of referrers) {
        const count = await prisma.foodUser.count({ where: { referredById: referrerId } });
        await prisma.foodUser.update({ where: { id: referrerId }, data: { referralCount: count } });
    }

    if (notCarried.firebaseTokens) {
        report.warn(USER, '-', '(all)',
            `${notCarried.firebaseTokens} push-notification token(s) not carried: they belong to the old app, and each customer registers a new one on first login`);
    }
    if (notCarried.referralCodes) {
        report.warn(USER, '-', '(all)',
            `${notCarried.referralCodes} old referral code(s) not carried: referrals here are by account id, and each customer gets a new link on first login`);
    }
    if (notCarried.missingImages) {
        report.warn(USER, '-', '(all)', `${notCarried.missingImages} profile picture(s) not found in the copied storage`);
    }
}

/** The old columns an address is built from; a change in any is an old-side edit. */
const ADDRESS_COLUMNS = ['address', 'address_type', 'contact_person_name', 'contact_person_number', 'latitude', 'longitude', 'house', 'road', 'floor'];

async function importAddresses(mysql, report, ctx = {}) {
    const userMap = await loadIdMap(USER);
    const idMap = await loadIdMap(ADDRESS);
    const [rows] = await mysql.query('SELECT * FROM customer_addresses ORDER BY user_id, id');
    const [people] = await mysql.query('SELECT id, f_name, l_name FROM users');
    const customerNames = new Map(people.map((person) => [String(person.id), fullName(person) || '']));

    // Each customer's most recently saved address becomes their default; the
    // old app had no default, and the newest is the one they last used.
    const newestByUser = new Map();
    for (const row of rows) newestByUser.set(String(row.user_id), row.id);

    const zones = await prisma.foodZone.findMany({ select: { id: true, name: true } });
    const zoneNames = new Map(zones.map((zone) => [zone.id, zone.name]));
    const fallbacks = { cityFromZone: 0, noCity: 0 };

    // Sync: an address imported before is the customer's to edit or delete
    // here now, and is left alone; only new ones come across.
    const baseline = ctx.sync ? byId((await ctx.baseline.query('SELECT * FROM customer_addresses'))[0]) : null;
    const liveUsers = ctx.sync
        ? new Set((await prisma.foodUser.findMany({ where: { id: { in: [...new Set(userMap.values())] } }, select: { id: true } })).map((u) => u.id))
        : null;

    for (const row of rows) {
        const userId = userMap.get(String(row.user_id));
        if (!userId) {
            report.skip(ADDRESS, row.id, row.address_type, `customer ${row.user_id} no longer exists in the old data`);
            continue;
        }
        if (ctx.sync && idMap.has(String(row.id))) {
            const { outcome, columns } = classifyProtected(baseline.get(String(row.id)), row, ADDRESS_COLUMNS);
            report.done(ADDRESS, outcome);
            if (outcome === 'protected') report.detail(ADDRESS, columns);
            continue;
        }
        if (ctx.sync && !liveUsers.has(userId)) {
            report.skip(ADDRESS, row.id, row.address_type, `customer ${row.user_id} was deleted here since`);
            continue;
        }

        const latitude = Number(row.latitude);
        const longitude = Number(row.longitude);
        const hasPin = Number.isFinite(latitude) && Number.isFinite(longitude)
            && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 && !(latitude === 0 && longitude === 0);

        const street = String(row.address || '').trim();
        let { city, state, zipCode } = parseFormattedAddress(street);
        if (!city && hasPin) {
            const [zone] = await prisma.$queryRaw`
                SELECT id FROM food_zones
                WHERE boundary IS NOT NULL
                  AND ST_Covers(boundary, ST_SetSRID(ST_MakePoint(${longitude}, ${latitude}), 4326)::geography)
                LIMIT 1`;
            if (zone) {
                city = zoneNames.get(zone.id) || '';
                fallbacks.cityFromZone += 1;
            }
        }
        if (!city) fallbacks.noCity += 1;

        // Usually the customer themselves. When it is someone else -- an
        // order for a parent, a colleague at the office -- the rider needs to
        // know who to ask for, and the new address has no name field.
        const contactName = String(row.contact_person_name || '').trim();
        const customerName = customerNames.get(String(row.user_id)) || '';
        const otherContact = contactName
            && contactName.toLowerCase() !== customerName.toLowerCase()
            && !customerName.toLowerCase().startsWith(contactName.toLowerCase());

        const data = {
            userId,
            label: LABELS[String(row.address_type || '').toLowerCase()] || 'Other',
            street: street || [row.house, row.road].filter(Boolean).join(', '),
            // House, road and floor were separate boxes in the old app; the
            // new one has a single line for the details a rider needs.
            additionalDetails: [
                otherContact && `Contact: ${contactName}`,
                row.house && `House: ${String(row.house).trim()}`,
                row.road && `Road: ${String(row.road).trim()}`,
                row.floor && `Floor: ${String(row.floor).trim()}`,
            ].filter(Boolean).join(', '),
            city,
            state,
            zipCode,
            phone: last10(row.contact_person_number),
            latitude: hasPin ? latitude : null,
            longitude: hasPin ? longitude : null,
            isDefault: newestByUser.get(String(row.user_id)) === row.id,
            ...(row.created_at ? { createdAt: row.created_at } : {}),
        };
        // Sync: a customer who already has a default here keeps it.
        if (ctx.sync && data.isDefault && (await prisma.userAddress.count({ where: { userId, isDefault: true } })) > 0) {
            data.isDefault = false;
        }
        if (!hasPin) report.warn(ADDRESS, row.id, street.slice(0, 40), 'no usable map pin; imported without one');

        const mappedId = idMap.get(String(row.id));
        const exists = mappedId && (await prisma.userAddress.count({ where: { id: mappedId } })) > 0;
        const address = exists
            ? await prisma.userAddress.update({ where: { id: mappedId }, data, select: { id: true } })
            : await prisma.userAddress.create({ data, select: { id: true } });

        await recordId(ADDRESS, row.id, address.id);
        report.done(ADDRESS, exists ? 'updated' : 'created');
    }

    if (fallbacks.cityFromZone) {
        report.warn(ADDRESS, '-', '(all)',
            `${fallbacks.cityFromZone} address(es) were not in Google's format; city taken from the delivery zone the pin is in`);
    }
    if (fallbacks.noCity) {
        report.warn(ADDRESS, '-', '(all)', `${fallbacks.noCity} address(es) have no city: not in Google's format and outside every zone`);
    }
}

export async function importCustomers(mysql, report, ctx = {}) {
    await importUsers(mysql, report, ctx);
    await importAddresses(mysql, report, ctx);
}
