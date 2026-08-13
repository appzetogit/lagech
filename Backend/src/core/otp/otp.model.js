import mongoose from 'mongoose';

const otpSchema = new mongoose.Schema(
    {
        phone: {
            type: String,
            required: true
        },
        otp: {
            type: String,
            required: true
        },
        expiresAt: {
            type: Date,
            required: true
        },
        attempts: {
            type: Number,
            default: 0
        },
        requestCount: {
            type: Number,
            default: 1
        },
        lastRequestAt: {
            type: Date,
            default: Date.now
        },
        /**
         * Start of the current per-phone rate-limit window.
         *
         * The quota is a FIXED window anchored here, not a sliding one anchored
         * on lastRequestAt. Anchoring on lastRequestAt meant every new request
         * pushed the window forward, so requests spaced just under the window
         * apart accumulated forever and eventually locked out a legitimate user
         * who had never exceeded the rate the limit describes.
         */
        windowStartedAt: {
            type: Date,
            default: Date.now
        },
        /**
         * When this document may be reaped. Deliberately distinct from
         * [expiresAt] (which is OTP *validity*): the TTL index used to run off
         * expiresAt, so the document — and with it requestCount — was deleted
         * OTP_EXPIRY_SECONDS (300s) after issue, while the quota window is
         * OTP_RATE_WINDOW (600s). The counter vanished mid-window, so the
         * per-phone OTP quota could never actually be enforced.
         *
         * Set to max(otp validity, rate window) by the service.
         */
        purgeAt: {
            type: Date,
            required: true
        }
    },
    {
        collection: 'food_otps',
        timestamps: true
    }
);

// TTL index for automatic expiry.
// Runs off purgeAt, NOT expiresAt — see the purgeAt field comment. An OTP that
// has expired is rejected by verifyOtp on its own; the document must outlive it
// so the rate-limit counter survives the full quota window.
//
// NOTE: the old `expiresAt_1` TTL index must be dropped on existing deployments,
// otherwise Mongo keeps reaping documents at OTP expiry and this change is a
// no-op. See scripts/migrate-otp-ttl.js.
otpSchema.index({ phone: 1 });
otpSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

export const FoodOtp = mongoose.model('FoodOtp', otpSchema);

