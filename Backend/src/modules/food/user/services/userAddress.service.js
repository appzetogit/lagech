import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import { normalizeDeliveryAddress } from '../../shared/geo.utils.js';

const normalizeLabel = (label) => {
    const v = String(label || '').trim().toLowerCase();
    if (v === 'home' || v === 'house' || v === 'flat') return 'Home';
    if (v === 'office' || v === 'work') return 'Office';
    return 'Other';
};

const coords = ({ latitude, longitude }) => {
    const lat = Number(latitude);
    const lng = Number(longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return {};
    // Only the plain coordinates are written; the PostGIS point is derived by
    // the user_address_location_sync trigger.
    return { latitude: lat, longitude: lng };
};

/** Newest last, so "promote the last one" keeps meaning what it did. */
const BY_AGE = [{ createdAt: 'asc' }];

const requireOwnedAddress = async (userId, addressId) => {
    if (!isId(addressId)) throw new ValidationError('Invalid address id');

    const address = await prisma.userAddress.findFirst({
        where: { id: String(addressId), userId: String(userId) },
    });
    // Ownership is part of the lookup, so another user's id reads as "not found"
    // rather than leaking that it exists.
    if (!address) throw new ValidationError('Address not found');
    return address;
};

export const listAddresses = async (userId) => {
    const rows = await prisma.userAddress.findMany({
        where: { userId: String(userId) },
        orderBy: BY_AGE,
    });
    return { addresses: rows.map((address) => normalizeDeliveryAddress(address)) };
};

export const addAddress = async (userId, dto) => {
    const user = await prisma.foodUser.findUnique({
        where: { id: String(userId) },
        select: { id: true },
    });
    if (!user) throw new ValidationError('User not found');

    const existingDefault = await prisma.userAddress.count({
        where: { userId: user.id, isDefault: true },
    });

    // Adding used to overwrite any existing address carrying the same label, on
    // the theory that a customer wants one Home and one Office. With only three
    // labels that capped everyone at three addresses and silently destroyed the
    // old one — saving a second "Other" wiped the first with no warning. Adding
    // now always adds; editing an address is what PATCH is for.
    const address = await prisma.userAddress.create({
        data: {
            userId: user.id,
            label: normalizeLabel(dto.label),
            street: dto.street,
            additionalDetails: dto.additionalDetails || '',
            city: dto.city,
            state: dto.state,
            zipCode: dto.zipCode || '',
            phone: dto.phone || '',
            ...coords(dto),
            // The first address a customer saves becomes their default.
            isDefault: existingDefault === 0,
        },
    });

    return { address: normalizeDeliveryAddress(address) };
};

export const updateAddress = async (userId, addressId, dto) => {
    const existing = await requireOwnedAddress(userId, addressId);

    const data = {};
    if (dto.label !== undefined) data.label = normalizeLabel(dto.label);
    if (dto.street !== undefined) data.street = dto.street;
    if (dto.additionalDetails !== undefined) data.additionalDetails = dto.additionalDetails || '';
    if (dto.city !== undefined) data.city = dto.city;
    if (dto.state !== undefined) data.state = dto.state;
    if (dto.zipCode !== undefined) data.zipCode = dto.zipCode || '';
    if (dto.phone !== undefined) data.phone = dto.phone || '';
    Object.assign(data, coords(dto));

    const address = await prisma.userAddress.update({ where: { id: existing.id }, data });
    return { address: normalizeDeliveryAddress(address) };
};

export const deleteAddress = async (userId, addressId) => {
    const existing = await requireOwnedAddress(userId, addressId);

    await prisma.$transaction(async (tx) => {
        await tx.userAddress.delete({ where: { id: existing.id } });

        // Deleting the default would leave the customer with none, so promote the
        // newest survivor. Inside the transaction, since the partial unique index
        // permits exactly one default per user.
        if (existing.isDefault) {
            const newest = await tx.userAddress.findFirst({
                where: { userId: String(userId) },
                orderBy: { createdAt: 'desc' },
                select: { id: true },
            });
            if (newest) {
                await tx.userAddress.update({ where: { id: newest.id }, data: { isDefault: true } });
            }
        }
    });

    return { success: true };
};

export const setDefaultAddress = async (userId, addressId) => {
    const existing = await requireOwnedAddress(userId, addressId);

    const address = await prisma.$transaction(async (tx) => {
        // Clear first. The partial unique index allows only one default per user,
        // so setting before clearing would collide with the incumbent.
        await tx.userAddress.updateMany({
            where: { userId: String(userId), isDefault: true },
            data: { isDefault: false },
        });
        return tx.userAddress.update({ where: { id: existing.id }, data: { isDefault: true } });
    });

    return { address: normalizeDeliveryAddress(address) };
};
