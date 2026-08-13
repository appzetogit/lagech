import { saveImageFile, deleteStoredFile } from '../../../../services/storage.service.js';

/**
 * The five operations every landing banner has.
 *
 * Hero, dining and under-250 banners were three files that differed only in
 * which Mongoose model they imported, which folder they uploaded to, and one
 * extra column each. Keeping them as three copies meant a fix to the delete
 * path (see below) had to be made three times, and in Mongo it had only ever
 * been made once.
 *
 * @param {object} delegate      a Prisma model delegate
 * @param {string} folder        storage folder for uploads
 * @param {(meta: object) => object} extraFields  the columns unique to this banner
 */
export const makeBannerService = (delegate, folder, extraFields = () => ({})) => {
    const byOrder = [{ sortOrder: 'asc' }, { createdAt: 'desc' }];

    // findByIdAndUpdate returned null for a missing id; Prisma throws P2025.
    // The controllers branch on null to send a 404, so keep returning null.
    const orNull = (promise) =>
        promise.catch((error) => {
            if (error?.code === 'P2025') return null;
            throw error;
        });

    return {
        list: () => delegate.findMany({ orderBy: byOrder }),

        createFromFiles: async (files, meta = {}) => {
            if (!files?.length) return [];

            const results = [];
            for (const file of files) {
                try {
                    const saved = await saveImageFile(file, folder);
                    const banner = await delegate.create({
                        data: {
                            imageUrl: saved.url,
                            publicId: saved.path,
                            title: meta.title,
                            ctaText: meta.ctaText,
                            ctaLink: meta.ctaLink,
                            sortOrder: Number(meta.sortOrder) || 0,
                            isActive: true,
                            ...extraFields(meta),
                        },
                    });
                    results.push({ success: true, banner });
                } catch (error) {
                    // One bad upload must not abandon the rest of the batch —
                    // the admin uploads banners several at a time.
                    results.push({ success: false, error: error.message });
                }
            }
            return results;
        },

        remove: async (id) => {
            const doc = await delegate.findUnique({ where: { id } });
            if (!doc) return { deleted: false };

            await delegate.delete({ where: { id } });

            // Row first, then the file. The other order leaves a live banner
            // pointing at a deleted image if the row delete fails; this order
            // leaves an orphaned file, which nobody sees.
            if (doc.publicId) {
                await deleteStoredFile(doc.publicId).catch(() => {});
            }
            return { deleted: true };
        },

        setOrder: (id, sortOrder) =>
            orNull(delegate.update({ where: { id }, data: { sortOrder: Number(sortOrder) || 0 } })),

        setActive: (id, isActive) =>
            orNull(delegate.update({ where: { id }, data: { isActive: Boolean(isActive) } })),
    };
};
