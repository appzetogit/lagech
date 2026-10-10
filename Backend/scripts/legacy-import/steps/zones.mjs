/**
 * Zones: `zones` -> food_zones.
 *
 * The old table holds a MySQL POLYGON; the new one holds the lat/lng ring the
 * admin UI edits, and a trigger derives the PostGIS boundary from it. So the
 * ring is written through createZone/updateZone, exactly as the admin panel
 * would, and the boundary follows.
 */
import { prisma } from '../../../src/config/prisma.js';
import { createZone, updateZone } from '../../../src/modules/food/admin/services/adminZone.service.js';
import { loadIdMap, recordId } from '../idMap.mjs';

const ENTITY = 'zone';

/**
 * GeoJSON polygon -> the UI's unclosed ring. GeoJSON orders points as
 * [longitude, latitude] and repeats the first point to close the ring; the new
 * model does neither.
 */
const toRing = (geoJson) => {
    const outer = JSON.parse(geoJson)?.coordinates?.[0] || [];
    const points = outer.map(([longitude, latitude]) => ({ latitude, longitude }));
    const first = points[0];
    const last = points[points.length - 1];
    if (first && last && first.latitude === last.latitude && first.longitude === last.longitude) {
        points.pop();
    }
    return points;
};

const ZONE_SQL = `SELECT id, name, display_name, status, created_at, cash_on_delivery, digital_payment, is_default,
                ST_AsGeoJSON(coordinates) AS geo
         FROM zones ORDER BY id`;
const ZONE_COLUMNS = ['name', 'display_name', 'status', 'cash_on_delivery', 'digital_payment', 'is_default', 'geo'];

export async function importZones(mysql, report, ctx = {}) {
    const [rows] = await mysql.query(ZONE_SQL);
    const idMap = await loadIdMap(ENTITY);
    const baseline = ctx.sync ? await ctx.baselineRows(ZONE_SQL) : null;

    for (const row of rows) {
        // Sync: zones are the new admin's now; an old-side change is only reported.
        if (ctx.sync && idMap.has(String(row.id))) {
            ctx.leaveAlone(report, ENTITY, row, baseline, ZONE_COLUMNS);
            continue;
        }
        const body = {
            name: String(row.display_name || row.name).trim(),
            zoneName: String(row.name).trim(),
            serviceLocation: String(row.display_name || row.name).trim(),
            coordinates: toRing(row.geo),
            isActive: row.status === 1,
            // The old Zone setup's switches. A default flag is only ever set,
            // never cleared, so a default chosen here survives a re-run.
            cashOnDelivery: Number(row.cash_on_delivery) === 1,
            digitalPayment: Number(row.digital_payment) === 1,
            // A sync never moves the default away from the one chosen here.
            ...(Number(row.is_default) === 1 && row.status === 1 && !ctx.sync ? { isDefault: true } : {}),
        };

        const existingId = idMap.get(String(row.id));
        const exists = existingId
            && (await prisma.foodZone.count({ where: { id: existingId } })) > 0;

        const result = exists ? await updateZone(existingId, body) : await createZone(body);
        if (!result || result.error) {
            report.skip(ENTITY, row.id, row.name, result?.error || 'zone service refused it');
            continue;
        }
        const { zone } = result;

        // Keep the original creation date: reports order by it.
        if (row.created_at) {
            await prisma.foodZone.update({ where: { id: zone.id }, data: { createdAt: row.created_at } });
        }
        await recordId(ENTITY, row.id, zone.id);
        report.done(ENTITY, exists ? 'updated' : 'created');
    }
}
