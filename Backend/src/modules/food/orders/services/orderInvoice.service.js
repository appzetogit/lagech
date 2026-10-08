import { prisma } from '../../../../config/prisma.js';
import { toOrder, orderInclude } from '../order.mapper.js';
import { NotFoundError, ValidationError } from '../../../../core/auth/errors.js';
import { buildOrderIdentityFilter } from './order.helpers.js';
import { buildRestaurantFinanceView } from './order.service.js';

/**
 * Order invoice / bill, laid out like the old 6amMart v3.9 "Print invoice"
 * receipt the client is used to (restaurant header, "Cash receipt", Desc / Qty
 * / Price, then Subtotal ... Total).
 *
 * One builder serves all three copies -- admin, restaurant and customer -- so
 * every copy prints identical numbers. The bill lines are taken from the
 * order's stored pricing columns (never recomputed from today's settings) and
 * always add up to the order total; a line the old receipt did not have
 * (campaign, new-customer discount, GST, packaging, platform fee, quick
 * delivery) is printed only when it is not zero.
 *
 * The restaurant copy also carries the restaurant's earning on the order, from
 * the same finance view the restaurant order details already show.
 */

export const INVOICE_COPIES = ['admin', 'restaurant', 'customer'];
export const INVOICE_SIZES = ['thermal', 'a4'];

const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;
const n = (value) => round2(value);
const text = (value) => (value == null ? '' : String(value).trim());

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "14/Sep/2026 01:27:pm" in India time, as the old receipt printed it. */
export function formatInvoiceDate(date, timeZone = 'Asia/Kolkata') {
    const d = date ? new Date(date) : null;
    if (!d || Number.isNaN(d.getTime())) return '';
    const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-GB', {
            timeZone, year: 'numeric', month: 'numeric', day: '2-digit',
            hour: '2-digit', minute: '2-digit', hour12: true,
        }).formatToParts(d).map((p) => [p.type, p.value]),
    );
    const hour = String(Number(parts.hour) || 12).padStart(2, '0');
    const ampm = String(parts.dayPeriod || '').toLowerCase().replace(/\./g, '').trim() || 'am';
    return `${parts.day}/${MONTHS[Number(parts.month) - 1]}/${parts.year} ${hour}:${parts.minute}:${ampm}`;
}

/** "₹ 150" / "₹ 12.50": whole rupees without decimals, so the receipt reads like the old one. */
export function formatInvoiceMoney(value, symbol = '₹') {
    const v = round2(value);
    const body = Number.isInteger(v) ? String(v) : v.toFixed(2);
    return `${symbol} ${body}`;
}

const PAYMENT_METHOD_LABELS = {
    cash: 'Cash on delivery',
    razorpay: 'Online payment',
    razorpay_qr: 'UPI QR',
    wallet: 'Wallet',
    offline: 'Offline payment',
};

const PAYMENT_STATUS_LABELS = {
    paid: 'Paid',
    refunded: 'Refunded',
    failed: 'Failed',
    authorized: 'Paid',
};

const CANCELLED = new Set(['cancelled_by_user', 'cancelled_by_restaurant', 'cancelled_by_admin']);

/** The customer's address on one line, or "Takeaway". */
function addressLine(order) {
    if (order.orderType === 'takeaway') return 'Takeaway';
    const a = order.deliveryAddress || {};
    return [a.street, a.additionalDetails, a.city, a.state, a.zipCode].map(text).filter(Boolean).join(', ');
}

function restaurantAddress(restaurant = {}) {
    const formatted = text(restaurant.formattedAddress);
    if (formatted) return formatted;
    return [restaurant.addressLine1, restaurant.addressLine2, restaurant.area, restaurant.city, restaurant.state, restaurant.pincode]
        .map(text).filter(Boolean).join(', ');
}

/** Order items as receipt rows: unit price includes add-ons (as charged); add-ons listed under the item. */
function invoiceItems(order) {
    return (order.items || []).map((item, index) => {
        const quantity = Math.max(1, Number(item.quantity) || 1);
        const addons = (Array.isArray(item.addons) ? item.addons : [])
            .filter((a) => a && typeof a === 'object')
            .map((a) => ({ name: text(a.name) || 'Add-on', price: n(a.price) }));
        const addonUnit = round2(addons.reduce((sum, a) => sum + a.price, 0));
        const unitPrice = n(item.price);
        return {
            sl: index + 1,
            name: text(item.name) || 'Item',
            variantName: text(item.variantName),
            addons,
            notes: text(item.notes),
            isVeg: item.isVeg !== false,
            campaign: Boolean(item.itemCampaignId),
            quantity,
            unitPrice,
            /** Per unit, without add-ons. */
            basePrice: round2(unitPrice - addonUnit),
            addonPrice: addonUnit,
            lineTotal: round2(unitPrice * quantity),
        };
    });
}

/**
 * The bill lines. `amount` is signed (a discount is negative) and every line
 * flagged `inTotal` adds up to `total`. `display` overrides the amount text
 * ("Free delivery").
 */
function billLines(order, items) {
    const p = order.pricing || {};
    const lines = [];
    const add = (key, label, amount, { always = false, sign = '+', inTotal = true, display, info = false } = {}) => {
        const value = round2(amount);
        if (!always && value === 0 && !display) return;
        lines.push({ key, label, amount: value, sign, inTotal, ...(display ? { display } : {}), ...(info ? { info } : {}) });
    };

    const subtotal = n(p.subtotal);
    const addonCost = round2(items.reduce((sum, it) => sum + it.addonPrice * it.quantity, 0));
    const itemsPrice = round2(subtotal - addonCost);

    // `discount` is everything taken off the items: campaign + new-customer + coupon.
    const discount = n(p.discount);
    const campaign = Math.min(discount, n(p.campaignDiscount));
    const newCustomer = Math.min(round2(discount - campaign), n(p.newCustomerDiscount));
    const rest = round2(discount - campaign - newCustomer);
    const coupon = p.couponId ? rest : 0;
    const otherDiscount = round2(rest - coupon);

    const quick = n(p.quickDeliveryFee);
    const additional = n(p.additionalCharge);
    const platform = round2(n(p.platformFee) - quick - additional);

    const isTakeaway = order.orderType === 'takeaway';
    const deliveryWaived = round2(n(p.deliveryFeeWaived) + n(p.freeDeliveryWaived));

    add('itemsPrice', 'Items price', itemsPrice, { always: true, inTotal: false, info: true });
    add('addonCost', 'Addon cost', addonCost, { always: true, inTotal: false, info: true });
    add('subtotal', 'Subtotal', subtotal, { always: true });
    add('discount', 'Discount', -otherDiscount, { always: true, sign: '-' });
    add('couponDiscount', p.couponCode && coupon ? `Coupon discount (${p.couponCode})` : 'Coupon discount', -coupon, { always: true, sign: '-' });
    add('campaignDiscount', 'Campaign discount', -campaign, { sign: '-' });
    add('newCustomerDiscount', 'New customer discount', -newCustomer, { sign: '-' });
    add('tax', 'GST', p.tax);
    add('packagingFee', 'Extra packaging', p.packagingFee);
    if (isTakeaway) {
        add('deliveryFee', 'Delivery charge', 0, { always: true, display: 'Takeaway' });
    } else if (n(p.deliveryFee) === 0 && deliveryWaived > 0) {
        add('deliveryFee', 'Delivery charge', 0, { always: true, display: 'Free delivery' });
    } else {
        add('deliveryFee', 'Delivery charge', p.deliveryFee, { always: true, sign: '' });
    }
    add('deliveryFeeGst', 'GST on delivery', p.deliveryFeeGst);
    add('platformFee', 'Platform fee', platform);
    add('quickDeliveryFee', 'Quick delivery', quick);
    add('riderTip', 'Delivery man tips', p.riderTip, { always: true });
    add('additionalCharge', text(p.additionalChargeName) || 'Additional charge', additional, { always: true });

    const total = n(p.total);
    const sum = round2(lines.filter((l) => l.inTotal).reduce((s, l) => s + l.amount, 0));
    // Never expected; keeps a hand-edited or legacy order's receipt honest.
    if (Math.abs(sum - total) >= 0.01) {
        add('adjustment', 'Adjustment', round2(total - sum), { sign: total - sum < 0 ? '-' : '+' });
    }
    return { lines, total };
}

function paymentBlock(order, total) {
    const pay = order.payment || {};
    const method = text(pay.method);
    let methodLabel = PAYMENT_METHOD_LABELS[method] || method || '—';
    if (method === 'cash' && order.orderType === 'takeaway') methodLabel = 'Cash';
    const offlineName = text(order.offlinePayment?.methodName || order.offlinePayment?.method?.name);
    if (method === 'offline' && offlineName) methodLabel = `Offline payment (${offlineName})`;

    const walletAmount = n(pay.walletAmount);
    const isPartial = Boolean(pay.isPartial) && walletAmount > 0;
    const remaining = isPartial ? round2(total - walletAmount) : total;

    let statusLabel = PAYMENT_STATUS_LABELS[pay.status] || 'Unpaid';
    if (isPartial && statusLabel === 'Unpaid') statusLabel = 'Partially paid';

    const split = isPartial
        ? [
              { key: 'wallet', label: 'Paid by wallet', amount: walletAmount },
              { key: 'rest', label: `Paid by ${methodLabel.toLowerCase()}`, amount: remaining },
          ]
        : [];

    const refund = pay.refund || {};
    return {
        method,
        methodLabel: isPartial ? `Wallet ${formatInvoiceMoney(walletAmount)} + ${methodLabel} ${formatInvoiceMoney(remaining)}` : methodLabel,
        status: pay.status || null,
        statusLabel,
        isPartial,
        walletAmount,
        amountDue: isPartial ? remaining : null,
        split,
        refund: n(refund.amount) > 0 ? { status: refund.status, amount: n(refund.amount) } : null,
    };
}

function restaurantEarning(finance) {
    if (!finance) return null;
    const lines = [
        { key: 'itemTotal', label: 'Item total', amount: n(finance.itemTotal), sign: '' },
    ];
    if (n(finance.packagingFee) > 0) lines.push({ key: 'packagingFee', label: 'Extra packaging', amount: n(finance.packagingFee), sign: '+' });
    lines.push({ key: 'commission', label: 'Commission', amount: -n(finance.commission), sign: '-' });
    if (n(finance.restaurantDiscountShare) > 0) {
        lines.push({ key: 'discountFunded', label: 'Discount you fund', amount: -n(finance.restaurantDiscountShare), sign: '-' });
    }
    return {
        lines,
        netPayout: n(finance.netPayout),
        isSettled: Boolean(finance.isSettled),
    };
}

/**
 * Pure: an order (toOrder shape, restaurant + user included) → invoice data.
 */
export function buildInvoice(order, { copy = 'customer', business = {}, finance = null } = {}) {
    const restaurant = order.restaurantId && typeof order.restaurantId === 'object' ? order.restaurantId : order.restaurant || {};
    const user = order.userId && typeof order.userId === 'object' ? order.userId : order.user || {};
    const items = invoiceItems(order);
    const { lines, total } = billLines(order, items);
    const companyName = text(business.companyName) || 'Lagech';
    const year = new Date(order.createdAt || Date.now()).getFullYear();

    return {
        copy,
        title: 'Cash receipt',
        orderId: order.order_id || order.orderId || order.id,
        id: order.id,
        createdAt: order.createdAt,
        date: formatInvoiceDate(order.createdAt),
        orderStatus: order.orderStatus,
        isCancelled: CANCELLED.has(order.orderStatus),
        orderType: order.orderType || 'delivery',
        scheduledAt: order.scheduledAt || null,
        currency: order.pricing?.currency || 'INR',
        currencySymbol: '₹',
        restaurant: {
            id: restaurant.id || null,
            name: text(restaurant.restaurantName) || 'Restaurant',
            address: restaurantAddress(restaurant),
            phone: text(restaurant.primaryContactNumber || restaurant.ownerPhone),
            gstNumber: restaurant.gstRegistered ? text(restaurant.gstNumber) : '',
            fssaiNumber: text(restaurant.fssaiNumber),
        },
        customer: {
            name: text(order.customerName || order.deliveryAddress?.fullName || order.deliveryAddress?.name || user.name) || 'Customer',
            phone: text(order.customerPhone || order.deliveryAddress?.phone || user.phone),
            address: addressLine(order),
        },
        items,
        lines,
        total,
        payment: paymentBlock(order, total),
        note: text(order.note),
        deliveryInstructions: text(order.deliveryInstructions),
        business: {
            name: companyName,
            logoUrl: text(business.logoUrl),
            address: [business.address, business.state, business.pincode].map(text).filter(Boolean).join(', '),
            phone: [text(business.phoneCountryCode), text(business.phoneNumber)].filter(Boolean).join(' ').trim(),
            email: text(business.email),
        },
        footer: {
            thanks: 'THANK YOU',
            text: `© ${companyName.toUpperCase()}. © ${year} Food Delivery. All rights reserved.`,
        },
        restaurantEarning: copy === 'restaurant' ? restaurantEarning(finance) : null,
    };
}

const RESTAURANT_SELECT = {
    id: true, restaurantName: true, ownerPhone: true, primaryContactNumber: true,
    addressLine1: true, addressLine2: true, area: true, city: true, state: true, pincode: true,
    formattedAddress: true, gstRegistered: true, gstNumber: true, fssaiNumber: true,
};

/**
 * Loads an order for one copy and builds its invoice. A customer or restaurant
 * asking for someone else's order gets 404 -- the same as an order that does
 * not exist, so ids cannot be probed.
 */
export async function getOrderInvoice(orderId, { copy = 'customer', userId, restaurantId } = {}) {
    if (!INVOICE_COPIES.includes(copy)) throw new ValidationError('Unknown invoice copy');
    const identity = buildOrderIdentityFilter(orderId);
    if (!identity) throw new ValidationError('Order id required');

    const where = { AND: [identity] };
    if (copy === 'customer') {
        if (!userId) throw new NotFoundError('Order not found');
        where.AND.push({ userId: String(userId) });
    }
    if (copy === 'restaurant') {
        if (!restaurantId) throw new NotFoundError('Order not found');
        where.AND.push({ restaurantId: String(restaurantId) });
    }

    const [row, business] = await Promise.all([
        prisma.foodOrder.findFirst({
            where,
            include: {
                items: orderInclude.items,
                restaurant: { select: RESTAURANT_SELECT },
                user: { select: { id: true, name: true, phone: true } },
            },
        }),
        prisma.foodBusinessSettings.findFirst({
            select: {
                companyName: true, email: true, phoneCountryCode: true, phoneNumber: true,
                address: true, state: true, pincode: true, logoUrl: true,
            },
        }).catch(() => null),
    ]);
    if (!row) throw new NotFoundError('Order not found');
    // The receipt is for an order that was placed: one still waiting on its
    // online payment has no bill yet.
    if (row.orderStatus === 'pending_payment' && copy !== 'admin') throw new NotFoundError('Order not found');

    const order = toOrder(row);
    const finance = copy === 'restaurant' ? await buildRestaurantFinanceView(row) : null;
    return buildInvoice(order, { copy, business: business || {}, finance });
}

// ─── HTML ────────────────────────────────────────────────────────────────────

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };
export const escapeHtml = (value) => String(value ?? '').replace(/[&<>"'`]/g, (c) => HTML_ESCAPES[c]);

/** Only an http(s) logo URL is ever put in the page. */
const safeImageUrl = (url) => {
    const raw = text(url);
    if (!raw) return '';
    try {
        const parsed = new URL(raw);
        return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : '';
    } catch {
        return '';
    }
};

const lineAmount = (line) => {
    if (line.display) return line.display;
    const money = formatInvoiceMoney(Math.abs(line.amount));
    if (line.sign === '-') return `- ${money}`;
    if (line.sign === '+' && !['subtotal', 'itemsPrice', 'addonCost'].includes(line.key)) return `+ ${money}`;
    return money;
};

/**
 * A self-contained printable page: inline CSS, no scripts beyond the optional
 * print call (carrying `nonce`), no external assets except the business logo.
 * `size` 'thermal' is an 80 mm receipt; 'a4' a normal page.
 */
export function renderInvoiceHtml(invoice, { size = 'thermal', autoPrint = false, nonce = '' } = {}) {
    const inv = invoice;
    const thermal = size !== 'a4';
    const e = escapeHtml;
    const logo = safeImageUrl(inv.business.logoUrl);

    const itemRows = inv.items.map((it) => {
        const sub = [];
        if (it.variantName) sub.push(`<div class="sub">Size: ${e(it.variantName)}</div>`);
        for (const a of it.addons) sub.push(`<div class="sub">+ ${e(a.name)} (${e(formatInvoiceMoney(a.price))})</div>`);
        if (it.notes) sub.push(`<div class="sub">Note: ${e(it.notes)}</div>`);
        return `<tr>
  <td class="desc"><div class="iname">${e(it.name)}</div><div class="sub">${e(formatInvoiceMoney(it.unitPrice))}</div>${sub.join('')}</td>
  <td class="qty">${e(it.quantity)}</td>
  <td class="amt">${e(formatInvoiceMoney(it.lineTotal))}</td>
</tr>`;
    }).join('\n');

    // Items price / Addon cost head the A4 bill (as on the old order details
    // page); the thermal receipt starts at Subtotal, like the old one.
    const billRows = inv.lines.filter((l) => !(thermal && l.info)).map((l) =>
        `<tr${l.info ? ' class="info"' : ''}><td>${e(l.label)} :</td><td class="amt">${e(lineAmount(l))}</td></tr>`,
    ).join('\n');

    const pay = inv.payment;
    const payRows = [
        `<div class="row"><span>Payment :</span><span>${e(pay.methodLabel)} · ${e(pay.statusLabel)}</span></div>`,
        ...pay.split.map((s) => `<div class="row small"><span>${e(s.label)}</span><span>${e(formatInvoiceMoney(s.amount))}</span></div>`),
        pay.refund ? `<div class="row small"><span>Refunded</span><span>${e(formatInvoiceMoney(pay.refund.amount))}</span></div>` : '',
    ].join('\n');

    const earning = inv.restaurantEarning
        ? `<div class="dash"></div>
<div class="center bold">Your earning</div>
<table class="bill">
${inv.restaurantEarning.lines.map((l) => `<tr><td>${e(l.label)} :</td><td class="amt">${e(lineAmount(l))}</td></tr>`).join('\n')}
<tr class="total"><td>You'll receive :</td><td class="amt">${e(formatInvoiceMoney(inv.restaurantEarning.netPayout))}</td></tr>
</table>`
        : '';

    const r = inv.restaurant;
    const c = inv.customer;
    const extraNotes = [
        inv.note ? `<div class="small">Order note: ${e(inv.note)}</div>` : '',
        inv.deliveryInstructions ? `<div class="small">Delivery instructions: ${e(inv.deliveryInstructions)}</div>` : '',
    ].join('');

    const printScript = autoPrint
        ? `<script${nonce ? ` nonce="${e(nonce)}"` : ''}>window.addEventListener('load',function(){setTimeout(function(){window.print();},300);});</script>`
        : '';

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Invoice #${e(inv.orderId)}</title>
<style>
  @page { size: ${thermal ? '80mm auto' : 'A4'}; margin: ${thermal ? '2mm' : '12mm'}; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #fff; color: #000; font-family: ${thermal ? "'Courier New', Courier, monospace" : 'Arial, Helvetica, sans-serif'}; font-size: ${thermal ? '12px' : '13px'}; }
  .receipt { width: ${thermal ? '76mm' : '100%'}; max-width: ${thermal ? '76mm' : '180mm'}; margin: 0 auto; padding: ${thermal ? '2mm' : '0'}; }
  .center { text-align: center; }
  .bold { font-weight: bold; }
  .small { font-size: ${thermal ? '11px' : '12px'}; }
  .logo { max-height: 48px; max-width: 60%; display: block; margin: 0 auto 4px; }
  h1 { font-size: ${thermal ? '16px' : '20px'}; margin: 2px 0; }
  .title { font-size: ${thermal ? '14px' : '16px'}; font-weight: bold; margin: 6px 0 2px; text-transform: none; }
  .dash { border-top: 1px dashed #000; margin: 6px 0; }
  .row { display: flex; justify-content: space-between; gap: 8px; }
  .row span:last-child { text-align: right; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; border-bottom: 1px dashed #000; padding: 2px 0; }
  td { vertical-align: top; padding: 2px 0; }
  .qty { text-align: center; width: 14%; }
  .amt { text-align: right; white-space: nowrap; }
  th.qty { text-align: center; }
  th.amt { text-align: right; }
  .iname { font-weight: bold; }
  .sub { font-size: ${thermal ? '11px' : '12px'}; color: #222; }
  .bill td:first-child { padding-right: 6px; }
  .bill tr.info td { color: #333; }
  .bill tr.total td { font-weight: bold; font-size: ${thermal ? '14px' : '16px'}; border-top: 1px dashed #000; padding-top: 4px; }
  .cancelled { border: 2px solid #000; text-align: center; font-weight: bold; padding: 2px; margin: 4px 0; }
  .copy { font-size: 10px; text-transform: uppercase; letter-spacing: 1px; }
  @media print { .receipt { margin: 0 auto; } }
</style>
</head>
<body>
<div class="receipt">
  ${logo ? `<img class="logo" src="${e(logo)}" alt="${e(inv.business.name)}">` : ''}
  <div class="center">
    <h1>${e(r.name)}</h1>
    ${r.address ? `<div class="small">${e(r.address)}</div>` : ''}
    ${r.phone ? `<div class="small">Phone : ${e(r.phone)}</div>` : ''}
    ${r.gstNumber ? `<div class="small">GSTIN : ${e(r.gstNumber)}</div>` : ''}
    ${r.fssaiNumber ? `<div class="small">FSSAI : ${e(r.fssaiNumber)}</div>` : ''}
    <div class="title">${e(inv.title)}</div>
    ${inv.copy === 'restaurant' ? '<div class="copy">Restaurant copy</div>' : ''}
  </div>
  ${inv.isCancelled ? '<div class="cancelled">CANCELLED</div>' : ''}
  <div class="dash"></div>
  <div class="row"><span>Order id : ${e(inv.orderId)}</span></div>
  <div>${e(inv.date)}</div>
  ${inv.scheduledAt ? `<div class="small">Scheduled for : ${e(formatInvoiceDate(inv.scheduledAt))}</div>` : ''}
  <div class="dash"></div>
  <div>Contact name : ${e(c.name)}</div>
  ${c.phone ? `<div>Phone : ${e(c.phone)}</div>` : ''}
  <div>Address : ${e(c.address)}</div>
  ${extraNotes}
  <div class="dash"></div>
  <table class="items">
    <thead><tr><th>Desc</th><th class="qty">Qty</th><th class="amt">Price</th></tr></thead>
    <tbody>
${itemRows}
    </tbody>
  </table>
  <div class="dash"></div>
  <table class="bill">
${billRows}
<tr class="total"><td>Total :</td><td class="amt">${e(formatInvoiceMoney(inv.total))}</td></tr>
  </table>
  ${payRows}
  ${earning}
  <div class="dash"></div>
  <div class="center bold">${e(inv.footer.thanks)}</div>
  <div class="center small">${e(inv.footer.text)}</div>
  ${[inv.business.phone, inv.business.email].filter(Boolean).length ? `<div class="center small">${e([inv.business.phone, inv.business.email].filter(Boolean).join(' · '))}</div>` : ''}
</div>
${printScript}
</body>
</html>`;
}

/**
 * Content-Security-Policy for the HTML response: helmet's default-src 'self'
 * would block the inline styles and the logo when an app opens the URL
 * directly.
 */
export const invoiceCsp = (nonce) =>
    `default-src 'none'; style-src 'unsafe-inline'; img-src https: http: data:; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'`;
