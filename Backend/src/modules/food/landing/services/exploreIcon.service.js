import { prisma } from '../../../../config/prisma.js';
import { saveImageFile, deleteStoredFile } from '../../../../services/storage.service.js';

const ICON_FOLDER = 'food/explore-icons';

export const listExploreIcons = () =>
    prisma.foodExploreIcon.findMany({ orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }] });

const getNextSortOrder = async () => {
    const last = await prisma.foodExploreIcon.findFirst({
        orderBy: { sortOrder: 'desc' },
        select: { sortOrder: true },
    });
    return (last?.sortOrder ?? -1) + 1;
    // ponytail: two icons created at the same moment share an order. They sort
    // by createdAt after that, and an admin can drag them apart. A sequence is
    // the fix if it ever matters.
};

export const createExploreIcon = async (file, meta) => {
    if (!file?.buffer) throw new Error('Image file is required');

    const label = (meta?.label || '').trim();
    if (!label) throw new Error('Label is required');

    const saved = await saveImageFile(file, ICON_FOLDER);

    return prisma.foodExploreIcon.create({
        data: {
            label,
            iconUrl: saved.url,
            publicId: saved.path,
            linkType: 'custom',
            targetPath: (meta?.link || '').trim() || null,
            sortOrder: await getNextSortOrder(),
            isActive: true,
        },
    });
};

export const updateExploreIcon = async (id, payload) => {
    const doc = await prisma.foodExploreIcon.findUnique({ where: { id } });
    if (!doc) return null;

    const updates = {};

    if (payload?.file?.buffer) {
        try {
            const saved = await saveImageFile(payload.file, ICON_FOLDER);
            updates.iconUrl = saved.url;
            updates.publicId = saved.path;
            // Drop the old file only once the new one is stored. Deleting first
            // meant a failed upload left the icon pointing at nothing.
            if (doc.publicId) await deleteStoredFile(doc.publicId).catch(() => {});
        } catch {
            throw new Error('Image upload failed');
        }
    }

    if (payload?.label !== undefined) updates.label = String(payload.label).trim();
    if (payload?.link !== undefined) updates.targetPath = String(payload.link).trim() || null;

    if (Object.keys(updates).length === 0) return doc;

    return prisma.foodExploreIcon.update({ where: { id }, data: updates });
};

export const deleteExploreIcon = async (id) => {
    const doc = await prisma.foodExploreIcon.findUnique({ where: { id } });
    if (!doc) return { deleted: false };

    await prisma.foodExploreIcon.delete({ where: { id } });
    if (doc.publicId) await deleteStoredFile(doc.publicId).catch(() => {});
    return { deleted: true };
};

export const toggleExploreIconStatus = async (id) => {
    const doc = await prisma.foodExploreIcon.findUnique({ where: { id }, select: { isActive: true } });
    if (!doc) return null;
    return prisma.foodExploreIcon.update({ where: { id }, data: { isActive: !doc.isActive } });
};

/** Body uses "order" rather than sortOrder, for frontend compatibility. */
export const updateExploreIconOrder = async (id, order) => {
    const sortOrder = Number(order);
    if (Number.isNaN(sortOrder)) return null;

    return prisma.foodExploreIcon
        .update({ where: { id }, data: { sortOrder } })
        .catch((error) => {
            if (error?.code === 'P2025') return null;
            throw error;
        });
};
