import { z } from 'zod';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import {
    RIDER_PAYMENT_METHODS,
    checkCoverage,
    money,
    normalizeRiderPhone,
} from '../services/adminRiderExtras.helpers.js';

/** The first problem zod found, as the one message the panel shows. */
const parse = (schema, value) => {
    const result = schema.safeParse(value);
    if (!result.success) throw new ValidationError(result.error.errors[0].message);
    return result.data;
};

const trimmed = (value) => (typeof value === 'string' ? value.trim() : value);
const optionalText = (max, label) =>
    z.preprocess(
        (v) => (v === null || v === undefined ? '' : trimmed(String(v))),
        z.string().max(max, `${label} must be at most ${max} characters`),
    );
const id = (message) => z.string().refine(isId, message);

// Same formats the rider app's sign-up accepts (delivery.validator.js).
const panRegex = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;
const aadharRegex = /^[0-9]{12}$/;
const drivingLicenseRegex = /^[A-Z]{2}[0-9A-Z]{8,16}$/;
const ifscRegex = /^[A-Z]{4}0[A-Z0-9]{6}$/;

/** Empty, or matching the pattern -- with this field's own message, not zod's union one. */
const blankOr = (regex, message) => z.string().refine((v) => !v || regex.test(v), message);

const upper = (v) => (typeof v === 'string' ? v.replace(/[\s-]/g, '').toUpperCase() : v);

const newRiderSchema = z.object({
    name: z.string().min(1, 'Name is required').max(100, 'Name must be at most 100 characters'),
    phone: z.string({ required_error: 'Phone is required' }).nullable()
        .refine((v) => Boolean(v), 'Enter a 10-digit phone number'),
    email: blankOr(/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, 'Enter a valid email'),
    zoneId: id('Choose a zone'),
    address: optionalText(500, 'Address'),
    city: optionalText(100, 'City'),
    state: optionalText(100, 'State'),
    vehicleType: z.string().min(1, 'Choose a vehicle type').max(64),
    vehicleName: optionalText(100, 'Vehicle name'),
    vehicleNumber: optionalText(20, 'Vehicle number'),
    panNumber: blankOr(panRegex, 'PAN must look like ABCDE1234F'),
    aadharNumber: blankOr(aadharRegex, 'Aadhaar must be 12 digits'),
    drivingLicenseNumber: blankOr(drivingLicenseRegex, 'Driving licence must be 2 letters followed by 8 to 16 letters or digits'),
    profilePhoto: optionalText(1000, 'Profile photo'),
    aadharPhoto: optionalText(1000, 'Aadhaar photo'),
    panPhoto: optionalText(1000, 'PAN photo'),
    drivingLicensePhoto: optionalText(1000, 'Driving licence photo'),
    bankAccountHolderName: optionalText(100, 'Account holder name'),
    bankAccountNumber: blankOr(/^[0-9]{6,20}$/, 'Account number must be 6 to 20 digits'),
    bankIfscCode: blankOr(ifscRegex, 'IFSC must look like SBIN0001234'),
    bankName: optionalText(100, 'Bank name'),
    upiId: blankOr(/^[\w.\-]{2,256}@[a-zA-Z]{2,64}$/, 'Enter a valid UPI id'),
});

/** The admin's "Add Delivery Man" form. Empty optional fields come back as ''. */
export function validateNewRiderDto(body = {}) {
    const text = (key) => (body[key] === null || body[key] === undefined ? '' : trimmed(String(body[key])));
    const data = parse(newRiderSchema, {
        name: text('name'),
        phone: normalizeRiderPhone(body.phone),
        email: text('email').toLowerCase(),
        zoneId: text('zoneId'),
        address: body.address,
        city: body.city,
        state: body.state,
        vehicleType: text('vehicleType'),
        vehicleName: body.vehicleName,
        vehicleNumber: upper(text('vehicleNumber')),
        panNumber: upper(text('panNumber')),
        aadharNumber: text('aadharNumber').replace(/\s/g, ''),
        drivingLicenseNumber: upper(text('drivingLicenseNumber')),
        profilePhoto: body.profilePhoto,
        aadharPhoto: body.aadharPhoto,
        panPhoto: body.panPhoto,
        drivingLicensePhoto: body.drivingLicensePhoto,
        bankAccountHolderName: body.bankAccountHolderName,
        bankAccountNumber: text('bankAccountNumber').replace(/\s/g, ''),
        bankIfscCode: upper(text('bankIfscCode')),
        bankName: body.bankName,
        upiId: text('upiId'),
    });
    if ((data.bankAccountNumber && !data.bankIfscCode) || (!data.bankAccountNumber && data.bankIfscCode)) {
        throw new ValidationError('Enter both the account number and the IFSC, or neither');
    }
    return data;
}

const vehicleCategorySchema = z.object({
    type: z.string().min(1, 'Vehicle type is required').max(64, 'Vehicle type must be at most 64 characters'),
    startingCoverageKm: z.number({ invalid_type_error: 'Starting coverage must be a number' }).min(0).max(1000),
    maxCoverageKm: z.number({ invalid_type_error: 'Maximum coverage must be a number' }).max(1000, 'Maximum coverage must be at most 1000 km'),
    extraCharges: z.number({ invalid_type_error: 'Extra charges must be a number' })
        .min(0, 'Extra charges cannot be negative').max(100000),
    isActive: z.boolean(),
});

const toNumber = (v) => (v === '' || v === null || v === undefined ? undefined : Number(v));
const toBool = (v) => (v === undefined ? undefined : v === true || v === 'true' || v === 1 || v === '1');

/**
 * A vehicle category. With `existing`, missing fields keep their stored
 * value, so a status toggle can send only isActive.
 */
export function validateVehicleCategoryDto(body = {}, existing = null) {
    const pick = (key, convert) => {
        const value = convert(body[key]);
        return value === undefined && existing ? convert(existing[key]) : value;
    };
    const data = parse(vehicleCategorySchema, {
        type: body.type !== undefined ? trimmed(String(body.type)) : existing?.type,
        startingCoverageKm: pick('startingCoverageKm', toNumber) ?? 0,
        maxCoverageKm: pick('maxCoverageKm', toNumber),
        extraCharges: pick('extraCharges', toNumber) ?? 0,
        isActive: pick('isActive', toBool) ?? true,
    });
    const problem = checkCoverage(data);
    if (problem) throw new ValidationError(problem);
    return {
        ...data,
        startingCoverageKm: money(data.startingCoverageKm),
        maxCoverageKm: money(data.maxCoverageKm),
        extraCharges: money(data.extraCharges),
    };
}

const paymentSchema = z.object({
    deliveryPartnerId: id('Choose a delivery man'),
    amount: z.number({ invalid_type_error: 'Enter an amount' })
        .min(1, 'Amount must be at least ₹1').max(1000000, 'Amount must be at most ₹10,00,000'),
    method: z.enum(RIDER_PAYMENT_METHODS, { errorMap: () => ({ message: 'Choose how the money was paid' }) }),
    reference: optionalText(120, 'Reference'),
    note: optionalText(500, 'Note'),
});

/** An admin recording money paid to a rider. */
export function validateRiderPaymentDto(body = {}) {
    const data = parse(paymentSchema, {
        deliveryPartnerId: String(body.deliveryPartnerId ?? ''),
        amount: toNumber(body.amount),
        method: String(body.method ?? ''),
        reference: body.reference,
        note: body.note,
    });
    return { ...data, amount: money(data.amount) };
}

const generateSchema = z.object({
    minAmount: z.number({ invalid_type_error: 'Minimum amount must be a number' })
        .min(1, 'Minimum amount must be at least ₹1').max(1000000),
});

export function validateGenerateDisbursementDto(body = {}) {
    return parse(generateSchema, { minAmount: toNumber(body.minAmount) ?? 1 });
}

const decideSchema = z.object({
    ids: z.array(id('Invalid payout')).min(1, 'Select at least one payout').max(500),
    status: z.enum(['paid', 'failed'], { errorMap: () => ({ message: 'Status must be paid or failed' }) }),
    reference: optionalText(120, 'Reference'),
    note: optionalText(500, 'Note'),
});

/** Marking disbursement lines paid or failed. */
export function validateDecidePayoutsDto(body = {}) {
    const ids = Array.isArray(body.ids) ? [...new Set(body.ids.map(String))] : [];
    return parse(decideSchema, { ids, status: String(body.status ?? ''), reference: body.reference, note: body.note });
}
