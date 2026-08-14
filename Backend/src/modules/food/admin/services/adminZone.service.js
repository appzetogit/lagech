import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { invalidateActiveZonesCache } from '../../landing/controllers/zonePublic.controller.js';

/**
 * Service-zone CRUD, extracted from the 6,258-line admin.service.js.
 *
 * `coordinates` stays the editable record — it is the ring the admin map draws
 * and sends back — and the GIST-indexed `boundary` polygon beside it is derived
 * by the zone_boundary_sync trigger. So there is still one thing to write, and
 * zone matching is an indexed ST_Contains rather than a ray-casting scan.
 */

const normalizeRing = (coordinates) =>
    (Array.isArray(coordinates) ? coordinates : []).map((c) => ({
        latitude: Number(c.latitude) || 0,
        longitude: Number(c.longitude) || 0,
    }));

export async function getZones(query = {}) {
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 100, 1), 1000);
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const skip = (page - 1) * limit;

    const search = typeof query.search === 'string' ? query.search.trim() : '';
    const { isActive } = query;

    const where = {};
    if (isActive !== undefined && isActive !== '') {
        where.isActive = isActive === 'true' || isActive === '1';
    }
    if (search) {
        const contains = { contains: search, mode: 'insensitive' };
        where.OR = [
            { name: contains },
            { zoneName: contains },
            { serviceLocation: contains },
            { country: contains },
        ];
    }

    const [zones, total] = await Promise.all([
        prisma.foodZone.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit }),
        prisma.foodZone.count({ where }),
    ]);

    return { zones, total, page, limit };
}

export async function getZoneById(id) {
    if (!isId(id)) return null;
    return prisma.foodZone.findUnique({ where: { id: String(id) } });
}

export async function createZone(body = {}) {
    const name =
        typeof body.name === 'string' && body.name.trim()
            ? body.name.trim()
            : (body.zoneName || '').trim();
    if (!name) return { error: 'Zone name is required' };

    const coordinates = normalizeRing(body.coordinates);
    // Checked here as well as by the database CHECK, so the admin gets a plain
    // message rather than a constraint violation.
    if (coordinates.length < 3) {
        return { error: 'At least 3 coordinates (polygon points) are required' };
    }

    const zone = await prisma.foodZone.create({
        data: {
            name,
            zoneName: body.zoneName?.trim() || name,
            country: body.country?.trim() || 'India',
            serviceLocation: body.serviceLocation?.trim() || name,
            unit: body.unit === 'miles' ? 'miles' : 'kilometer',
            coordinates,
            isActive: body.isActive !== false,
        },
    });

    void invalidateActiveZonesCache();
    return { zone };
}

export async function updateZone(id, body = {}) {
    if (!isId(id)) return null;

    const existing = await prisma.foodZone.findUnique({ where: { id: String(id) } });
    if (!existing) return null;

    const data = {};
    if (body.name !== undefined) data.name = String(body.name).trim();
    if (body.zoneName !== undefined) data.zoneName = String(body.zoneName).trim();
    if (body.country !== undefined) data.country = String(body.country).trim();
    if (body.serviceLocation !== undefined) {
        data.serviceLocation = String(body.serviceLocation).trim();
    }
    if (body.unit !== undefined) data.unit = body.unit === 'miles' ? 'miles' : 'kilometer';
    if (body.isActive !== undefined) data.isActive = body.isActive !== false;

    // A ring shorter than 3 points is ignored rather than saved — it would make
    // the zone match nothing, and the database would refuse it anyway.
    if (Array.isArray(body.coordinates) && body.coordinates.length >= 3) {
        data.coordinates = normalizeRing(body.coordinates);
    }

    // serviceLocation is the label the app shows; never let it go blank.
    const nextName = data.name ?? existing.name;
    if (nextName && !(data.serviceLocation ?? existing.serviceLocation)) {
        data.serviceLocation = nextName;
    }

    const zone = await prisma.foodZone.update({ where: { id: existing.id }, data });
    void invalidateActiveZonesCache();
    return { zone };
}

export async function deleteZone(id) {
    if (!isId(id)) return null;

    // deleteMany, so a zone that has already gone returns null rather than
    // throwing P2025 out of the controller.
    const { count } = await prisma.foodZone.deleteMany({ where: { id: String(id) } });
    if (!count) return null;

    void invalidateActiveZonesCache();
    return { id: String(id) };
}
