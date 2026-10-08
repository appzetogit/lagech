import { DEFAULT_OTP_MESSAGE } from './thirdParty.catalog.js';

/**
 * Sending an OTP through SMS India Hub with the effective SMS settings
 * (3rd Party > SMS Module, falling back to the server's SMS_INDIA_HUB_*).
 *
 * The request URL carries the API key, so it is never logged; neither is the
 * provider's raw reply without the key scrubbed out of it.
 */

export const normalizeMsisdn = (phone) => {
    const digits = String(phone || '').replace(/\D/g, '');
    return digits.startsWith('91') && digits.length === 12 ? digits : `91${digits.slice(-10)}`;
};

/** The OTP text for the template: {otp} replaced. */
export const otpMessageText = (settings, otp) =>
    String(settings?.otpMessage || DEFAULT_OTP_MESSAGE).split('{otp}').join(String(otp));

/** SMS India Hub HTTP GET URL. Query names are case-sensitive per the provider. */
export function buildSmsIndiaHubUrl(settings, phone, otp) {
    const url = new URL('http://cloud.smsindiahub.in/vendorsms/pushsms.aspx');
    url.searchParams.append('APIKey', settings.apiKey || '');
    url.searchParams.append('sid', settings.senderId || '');
    url.searchParams.append('msisdn', normalizeMsisdn(phone));
    url.searchParams.append('msg', otpMessageText(settings, otp));
    url.searchParams.append('gwid', '2');
    url.searchParams.append('fl', '0');
    if (settings.username) url.searchParams.append('uname', settings.username);
    if (settings.dltTemplateId) url.searchParams.append('DLT_TE_ID', settings.dltTemplateId);
    return url;
}

/** The provider's reply with any secret it might echo removed, shortened. */
export const scrubReply = (text, settings) => {
    let out = String(text || '');
    for (const secret of [settings?.apiKey].filter((s) => s && s.length >= 4)) out = out.split(secret).join('••••');
    return out.slice(0, 300);
};

/**
 * Reads SMS India Hub's reply. It answers HTTP 200 for most failures, as JSON
 * with an ErrorCode or as plain text such as "Failed#Invalid Login".
 */
export function interpretSmsReply(status, ok, text) {
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* plain text */ }
    if (parsed && parsed.ErrorCode && parsed.ErrorCode !== '000') {
        const hint = parsed.ErrorCode === '006'
            ? ' (DLT template mismatch: the message must match the registered template exactly)'
            : '';
        return { ok: false, reason: `[${parsed.ErrorCode}] ${parsed.ErrorMessage || 'error'}${hint}` };
    }
    if (!ok) return { ok: false, reason: `HTTP ${status}` };
    if (/^\s*(failed|error)|^\s*failed#/i.test(text)) return { ok: false, reason: 'rejected by the provider' };
    return { ok: true };
}

/**
 * Sends one OTP SMS. Never throws: returns { ok, reason?, reply } where reply
 * is the scrubbed provider text.
 */
export async function sendOtpSms(settings, phone, otp, { fetchImpl = fetch } = {}) {
    if (!settings?.apiKey || !settings?.senderId) {
        return { ok: false, reason: 'SMS is not configured (API key and sender ID are needed)', reply: '' };
    }
    try {
        const response = await fetchImpl(buildSmsIndiaHubUrl(settings, phone, otp).toString());
        const text = await response.text();
        const verdict = interpretSmsReply(response.status, response.ok, text);
        return { ...verdict, reply: scrubReply(text, settings) };
    } catch (error) {
        return { ok: false, reason: scrubReply(error?.message || 'request failed', settings), reply: '' };
    }
}
