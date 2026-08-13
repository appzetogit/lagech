import { prisma } from '../../../../config/prisma.js';
import { saveImageFile, deleteStoredFile } from '../../../../services/storage.service.js';

const BANNER_FOLDER = 'food/top-banners';

export const listTopBannersController = async (req, res) => {
    try {
        const banners = await prisma.topBanner.findMany({ orderBy: { order: 'asc' } });
        res.status(200).json({ success: true, data: { banners } });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to fetch top banners', error: error.message });
    }
};

export const uploadTopBannersController = async (req, res) => {
    try {
        if (!req.files?.length) {
            return res.status(400).json({ success: false, message: 'No images provided' });
        }

        const banners = [];
        const errors = [];

        for (const file of req.files) {
            try {
                const saved = await saveImageFile(file, BANNER_FOLDER);
                const last = await prisma.topBanner.findFirst({
                    orderBy: { order: 'desc' },
                    select: { order: true },
                });

                banners.push(await prisma.topBanner.create({
                    data: {
                        image: saved.url,
                        publicId: saved.path,
                        order: last ? last.order + 1 : 0,
                        isActive: true,
                    },
                }));
            } catch (err) {
                errors.push(`Failed to upload ${file.originalname}: ${err.message}`);
            }
        }

        res.status(201).json({
            success: true,
            message: 'Top banners processed',
            data: { banners, errors },
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Internal server error', error: error.message });
    }
};

export const deleteTopBannerController = async (req, res) => {
    try {
        const banner = await prisma.topBanner.findUnique({ where: { id: req.params.id } });
        if (!banner) {
            return res.status(404).json({ success: false, message: 'Banner not found' });
        }

        await prisma.topBanner.delete({ where: { id: banner.id } });

        // After the row, not before: a failed row delete used to leave a live
        // banner pointing at an image that no longer existed.
        if (banner.publicId) {
            await deleteStoredFile(banner.publicId).catch((err) =>
                console.error('Storage deletion failed:', err.message));
        }

        res.status(200).json({ success: true, message: 'Banner deleted successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to delete banner', error: error.message });
    }
};

export const updateTopBannerOrderController = async (req, res) => {
    try {
        const order = Number(req.body?.order);
        if (!Number.isFinite(order)) {
            return res.status(400).json({ success: false, message: 'order must be a number' });
        }

        const { count } = await prisma.topBanner.updateMany({
            where: { id: req.params.id },
            data: { order },
        });
        if (!count) {
            return res.status(404).json({ success: false, message: 'Banner not found' });
        }

        const banner = await prisma.topBanner.findUnique({ where: { id: req.params.id } });
        res.status(200).json({ success: true, message: 'Order updated', data: { banner } });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to update order', error: error.message });
    }
};

export const toggleTopBannerStatusController = async (req, res) => {
    try {
        const current = await prisma.topBanner.findUnique({
            where: { id: req.params.id },
            select: { isActive: true },
        });
        if (!current) {
            return res.status(404).json({ success: false, message: 'Banner not found' });
        }

        const banner = await prisma.topBanner.update({
            where: { id: req.params.id },
            data: { isActive: !current.isActive },
        });
        res.status(200).json({ success: true, message: 'Status updated', data: { banner } });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to update status', error: error.message });
    }
};
