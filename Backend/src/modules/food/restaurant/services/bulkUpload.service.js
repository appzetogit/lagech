import ExcelJS from 'exceljs';
import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import { categoryAllowsFoodType, normalizeFoodTypeForCategory } from '../../shared/categoryWorkflow.js';
import { toFoodTypeColumn } from '../../shared/foodType.util.js';
import { dropMenuCache } from '../../shared/menuCache.util.js';
import { syncFoodVariants } from '../../admin/services/foodVariant.service.js';
import { isHostedUploadUrl, saveImageFromUrl } from '../../../../services/storage.service.js';

const PREP_TIME_OPTIONS = [
    '5-10 mins', '10-15 mins', '15-20 mins', '20-25 mins', 
    '25-30 mins', '30-40 mins', '40-50 mins', '50+ mins'
];

const TEMPLATE_SAMPLE_ROW_SIGNATURE = Object.freeze({
    category: 'starters',
    name: 'paneer tikka',
    description: 'spicy marinated paneer grilled to perfection',
    price: 250,
    foodType: 'veg',
    prepTime: '20-25 mins',
    imageUrl: 'https://example.com/paneer.jpg',
    variants: [
        { name: 'half', price: 150 },
        { name: 'full', price: 280 }
    ]
});

const isLegacyTemplateSampleRow = (data = {}) => {
    const normalizedVariants = Array.isArray(data.variants)
        ? data.variants.map((v) => ({
            name: String(v?.name || '').trim().toLowerCase(),
            price: Number(v?.price || 0)
        }))
        : [];

    if (normalizedVariants.length !== TEMPLATE_SAMPLE_ROW_SIGNATURE.variants.length) return false;

    const variantsMatch = TEMPLATE_SAMPLE_ROW_SIGNATURE.variants.every((sampleVariant, idx) => {
        const rowVariant = normalizedVariants[idx];
        return (
            rowVariant &&
            rowVariant.name === sampleVariant.name &&
            rowVariant.price === sampleVariant.price
        );
    });

    if (!variantsMatch) return false;

    return (
        String(data.category || '').trim().toLowerCase() === TEMPLATE_SAMPLE_ROW_SIGNATURE.category &&
        String(data.name || '').trim().toLowerCase() === TEMPLATE_SAMPLE_ROW_SIGNATURE.name &&
        String(data.description || '').trim().toLowerCase() === TEMPLATE_SAMPLE_ROW_SIGNATURE.description &&
        Number(data.price || 0) === TEMPLATE_SAMPLE_ROW_SIGNATURE.price &&
        String(data.foodType || '').trim().toLowerCase() === TEMPLATE_SAMPLE_ROW_SIGNATURE.foodType &&
        String(data.prepTime || '').trim().toLowerCase() === TEMPLATE_SAMPLE_ROW_SIGNATURE.prepTime &&
        String(data.imageUrl || '').trim().toLowerCase() === TEMPLATE_SAMPLE_ROW_SIGNATURE.imageUrl
    );
};

/**
 * Generates an Excel template for bulk menu upload.
 */
export async function generateBulkMenuTemplate() {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Menu Template');

    // Define Columns
    sheet.columns = [
        { header: 'Category*', key: 'category', width: 20 },
        { header: 'Item Name*', key: 'name', width: 30 },
        { header: 'Description', key: 'description', width: 40 },
        { header: 'Base Price*', key: 'price', width: 15 },
        { header: 'Food Type (Veg/Non-Veg)*', key: 'foodType', width: 25 },
        { header: 'Recommended (Yes/No)', key: 'isRecommended', width: 25 },
        { header: 'Preparation Time*', key: 'prepTime', width: 25 },
        { header: 'Image URL', key: 'imageUrl', width: 40 },
        { header: 'Variant 1 Name', key: 'v1Name', width: 20 },
        { header: 'Variant 1 Price', key: 'v1Price', width: 15 },
        { header: 'Variant 2 Name', key: 'v2Name', width: 20 },
        { header: 'Variant 2 Price', key: 'v2Price', width: 15 },
        { header: 'Variant 3 Name', key: 'v3Name', width: 20 },
        { header: 'Variant 3 Price', key: 'v3Price', width: 15 },
    ];

    // Style headers
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFE0E0E0' }
    };

    // Add Data Validations for 500 rows
    for (let i = 2; i <= 501; i++) {
        // Food Type Dropdown
        sheet.getCell(`E${i}`).dataValidation = {
            type: 'list',
            allowBlank: false,
            formulae: ['"Veg,Non-Veg"']
        };

        // Recommended Dropdown
        sheet.getCell(`F${i}`).dataValidation = {
            type: 'list',
            allowBlank: true,
            formulae: ['"Yes,No"']
        };

        // Preparation Time Dropdown
        sheet.getCell(`G${i}`).dataValidation = {
            type: 'list',
            allowBlank: false,
            formulae: [`"${PREP_TIME_OPTIONS.join(',')}"`]
        };

        // Numeric Validation for Prices
        const priceCells = [`D${i}`, `J${i}`, `L${i}`, `N${i}`];
        priceCells.forEach(cell => {
            sheet.getCell(cell).dataValidation = {
                type: 'decimal',
                operator: 'greaterThanOrEqual',
                showErrorMessage: true,
                allowBlank: true,
                formulae: [0],
                errorTitle: 'Invalid Price',
                error: 'Price must be a number greater than or equal to 0'
            };
        });
    }

    return workbook;
}

/**
 * Processes the uploaded bulk menu Excel file.
 */
export async function processBulkMenuUpload(restaurantId, fileBuffer, options = {}) {
    const approvalStatus = options.approvalStatus === 'approved' ? 'approved' : 'pending';
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(fileBuffer);
    const sheet = workbook.getWorksheet(1);
    if (!sheet) throw new ValidationError('Invalid Excel file: worksheet missing');

    const normalizeHeader = (value) =>
        String(value || '')
            .trim()
            .replace(/\s+/g, ' ')
            .toLowerCase();

    const requiredHeaders = [
        'Category*',
        'Item Name*',
        'Description',
        'Base Price*',
        'Food Type (Veg/Non-Veg)*',
        'Recommended (Yes/No)',
        'Preparation Time*',
        'Image URL',
        'Variant 1 Name',
        'Variant 1 Price',
        'Variant 2 Name',
        'Variant 2 Price',
        'Variant 3 Name',
        'Variant 3 Price',
    ];

    const headerRow = sheet.getRow(1);
    const uploadedHeaders = new Set(
        (headerRow.values || [])
            .slice(1)
            .map((value) => normalizeHeader(value)),
    );
    const missingHeaders = requiredHeaders.filter(
        (header) => !uploadedHeaders.has(normalizeHeader(header)),
    );
    if (missingHeaders.length > 0) {
        throw new ValidationError(
            `Uploaded Excel is missing required column(s): ${missingHeaders.join(', ')}`,
        );
    }
    if (!isId(restaurantId)) throw new ValidationError('Invalid restaurant id');
    const restaurant = await prisma.foodRestaurant.findUnique({
        where: { id: String(restaurantId) },
        select: { id: true, zoneId: true },
    });
    if (!restaurant) throw new ValidationError('Restaurant not found');

    const items = [];
    const parsingErrors = [];
    const maxItems = 500;
    let rowCount = 0;

    const getNumericValue = (cell) => {
        if (!cell || cell.value === null || cell.value === undefined) return 0;
        if (typeof cell.value === 'object' && cell.value.result !== undefined) {
            return parseFloat(cell.value.result) || 0;
        }
        return parseFloat(cell.value) || 0;
    };

    const getTextValue = (cell) => {
        if (!cell || cell.value === null || cell.value === undefined) return '';

        // Handle Hyperlinks (often how URLs are stored in Excel)
        if (typeof cell.value === 'object') {
            if (cell.value.hyperlink) return String(cell.value.hyperlink).trim();
            if (cell.value.text) return String(cell.value.text).trim();
        }

        // Handle Rich Text
        if (cell.value.richText) {
            return cell.value.richText.map((rt) => rt.text).join('').trim();
        }

        // Handle Formula Result
        if (typeof cell.value === 'object' && cell.value.result !== undefined) {
            return String(cell.value.result).trim();
        }

        // Handle Shared Strings / Plain Values
        return String(cell.value).trim();
    };

    sheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return; // Skip Header
        if (rowCount >= maxItems) return;

        try {
            const data = {
                category: getTextValue(row.getCell(1)),
                name: getTextValue(row.getCell(2)),
                description: getTextValue(row.getCell(3)),
                price: getNumericValue(row.getCell(4)),
                foodType: getTextValue(row.getCell(5)),
                isRecommended: String(row.getCell(6).value || '').toLowerCase() === 'yes',
                prepTime: getTextValue(row.getCell(7)),
                imageUrl: getTextValue(row.getCell(8)),
                variants: [],
            };

            // Mandatory Field Check
            if (!data.category || !data.name) {
                // Only report as error if row is not completely empty
                const hasAnyData = row.values.some((v) => v !== null && v !== undefined && v !== '');
                if (hasAnyData) {
                    parsingErrors.push({
                        row: rowNumber,
                        item: data.name || 'Unknown Entry',
                        error: 'Category and Item Name are mandatory',
                    });
                }
                return;
            }

            rowCount++;

            // Parse Variants (Columns 9 to 14)
            for (let j = 0; j < 3; j++) {
                const vName = getTextValue(row.getCell(9 + j * 2));
                const vPrice = getNumericValue(row.getCell(10 + j * 2));
                if (vName && vPrice > 0) {
                    data.variants.push({ name: vName, price: vPrice });
                }
            }

            // Backward compatibility guard:
            // Old templates had a pre-filled sample row (Paneer Tikka). Skip it automatically.
            if (isLegacyTemplateSampleRow(data)) return;

            items.push({ data, rowNumber });
        } catch (err) {
            parsingErrors.push({
                row: rowNumber,
                item: getTextValue(row.getCell(2)) || 'Unknown Entry',
                error: `Parsing error: ${err.message}`,
            });
        }
    });

    if (items.length === 0 && parsingErrors.length === 0) {
        throw new ValidationError('No valid items found in the Excel sheet');
    }

    const results = { success: 0, failed: parsingErrors.length, details: [...parsingErrors] };
    const fail = (rowNumber, name, error) => {
        results.failed += 1;
        results.details.push({ row: rowNumber, item: name || 'Unknown Entry', error });
    };

    // ── Resolve every category once ──────────────────────────────────────────
    // A sheet of 500 rows usually names a handful of categories, so this is a
    // handful of queries rather than one per row.
    const categoryCache = new Map();
    for (const name of new Set(items.map((it) => it.data.category.trim()))) {
        let category = await prisma.foodCategory.findFirst({
            where: {
                name: { equals: name, mode: 'insensitive' },
                OR: [{ restaurantId: null }, { restaurantId: restaurant.id }],
            },
        });

        if (!category) {
            category = await prisma.foodCategory.create({
                data: {
                    name,
                    restaurantId: restaurant.id,
                    createdByRestaurantId: restaurant.id,
                    approvalStatus: 'approved',
                    zoneId: restaurant.zoneId,
                },
            });
        }
        categoryCache.set(name.toLowerCase(), category);
    }

    // ── Fetch the images, in batches ─────────────────────────────────────────
    // The one genuinely slow step: a row may name a remote image that has to be
    // downloaded and re-hosted. Ten at a time, as before.
    const CONCURRENCY = 10;
    const resolveImage = async ({ data, rowNumber }) => {
        const url = String(data.imageUrl || '').trim();
        if (!url) return '';

        // Already ours (local VPS or legacy Cloudinary) — nothing to fetch.
        if (isHostedUploadUrl(url) || url.includes('cloudinary.com')) return url;
        if (!url.startsWith('http') && !url.startsWith('//')) return '';

        try {
            const saved = await saveImageFromUrl(
                url.startsWith('//') ? `https:${url}` : url,
                `restaurants/${restaurant.id}/food`,
            );
            return saved.url;
        } catch (imgErr) {
            // A missing picture is not worth losing the dish over.
            console.error(`Row ${rowNumber}: Image upload failed [${url}]:`, imgErr.message);
            return '';
        }
    };

    const prepared = [];
    for (let i = 0; i < items.length; i += CONCURRENCY) {
        const chunk = items.slice(i, i + CONCURRENCY);
        const images = await Promise.all(chunk.map(resolveImage));

        chunk.forEach((item, index) => {
            const { data, rowNumber } = item;
            const category = categoryCache.get(data.category.trim().toLowerCase());
            if (!category) {
                fail(rowNumber, data.name, `Category ${data.category} could not be resolved`);
                return;
            }

            const foodType = normalizeFoodTypeForCategory(data.foodType);
            const scope = String(category.foodTypeScope || 'Both').trim();
            if (!categoryAllowsFoodType(scope, foodType)) {
                fail(
                    rowNumber,
                    data.name,
                    `Category "${category.name}" allows only ${scope} items, but row has ${foodType}`,
                );
                return;
            }

            prepared.push({ data, rowNumber, category, foodType, image: images[index] });
        });
    }

    // ── Write ────────────────────────────────────────────────────────────────
    // Matched by name within this restaurant, as the Mongo upsert was. Ids
    // created during this run go into the map too, so a sheet that lists the
    // same dish twice updates one row instead of creating two.
    const existing = await prisma.foodItem.findMany({
        where: { restaurantId: restaurant.id, name: { in: prepared.map((p) => p.data.name) } },
        select: { id: true, name: true },
    });
    const idByName = new Map(existing.map((f) => [f.name, f.id]));

    const now = new Date();
    const approvalStamps = approvalStatus === 'pending'
        ? { requestedAt: now, approvedAt: null }
        : { approvedAt: now, requestedAt: null };

    for (const { data, rowNumber, category, foodType, image } of prepared) {
        const fields = {
            categoryId: category.id,
            categoryName: category.name,
            description: data.description,
            // A dish with sizes is advertised at its cheapest one.
            price: data.variants.length > 0
                ? Math.min(...data.variants.map((v) => v.price))
                : data.price,
            ...(image ? { image } : {}),
            foodType: toFoodTypeColumn(foodType),
            isRecommended: data.isRecommended,
            preparationTime: data.prepTime,
            approvalStatus,
            ...approvalStamps,
            rejectionReason: '',
            rejectedAt: null,
        };

        try {
            // One transaction per dish: variants are their own rows now, so a
            // dish and its sizes have to land together or not at all.
            const id = await prisma.$transaction(async (tx) => {
                const existingId = idByName.get(data.name);
                const food = existingId
                    ? await tx.foodItem.update({ where: { id: existingId }, data: fields })
                    : await tx.foodItem.create({
                        data: { restaurantId: restaurant.id, name: data.name, ...fields },
                    });

                await syncFoodVariants(tx, food.id, data.variants);
                return food.id;
            });

            idByName.set(data.name, id);
            // Counted from what actually landed. The old code derived this by
            // subtracting failures from the row count, so a bulk write that blew
            // up still reported every row as a success.
            results.success += 1;
        } catch (err) {
            fail(rowNumber, data.name, `Could not be saved: ${err.message}`);
        }
    }

    if (results.success > 0) await dropMenuCache(restaurant.id);

    return results;
}
