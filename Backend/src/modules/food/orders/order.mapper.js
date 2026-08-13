/**
 * Translates between the flat `food_orders` row and the nested order shape the
 * rest of the codebase and every client already speak.
 *
 * The Mongo document nested pricing, payment, dispatch, deliveryState, ratings and
 * deliveryAddress as subdocuments. Postgres stores them as columns, because those
 * are exactly the fields the reporting queries aggregate on — but roughly 80 read
 * sites across order.helpers.js, the delivery/restaurant/admin services, the socket
 * payloads and the two frontends read `order.pricing.total`, `order.payment.status`
 * and `order.dispatch.deliveryPartnerId` by path.
 *
 * Rebuilding the nesting on the way out means none of those change. Only query
 * filters have to be rewritten by hand, because a WHERE clause cannot be mapped
 * after the fact.
 */

/** Relations that make up a whole order. */
export const orderInclude = {
    items: true,
    itemRatings: true,
    statusHistory: { orderBy: { at: 'asc' } },
    dispatchOffers: { orderBy: { at: 'asc' } }
};

/** The relations Mongoose used to `.populate()`, in the same three places. */
export const orderPopulate = {
    ...orderInclude,
    restaurant: true,
    user: true,
    deliveryPartner: true
};

/**
 * Mongoose populate replaced an id with the document in the SAME field, and
 * callers branch on that (`order.restaurantId?.restaurantName`,
 * `partner.lastLat`). Included relations therefore take the id field's place;
 * otherwise the bare id stays, exactly as an unpopulated document behaved.
 */
const populated = (relation, id) => relation ?? id;

const num = (value) => (value == null ? null : Number(value));
/** Money columns come back as Decimal; the API has always emitted numbers. */
const money = (value) => Number(value ?? 0);

const geoPoint = (lat, lng) =>
    lat == null || lng == null ? undefined : { type: 'Point', coordinates: [Number(lng), Number(lat)] };

const entityRating = (rating, comment, ratedAt) =>
    rating == null ? undefined : { rating, comment: comment || '', ratedAt };

/**
 * Flat row (+ relations) → the nested shape callers expect.
 */
export function toOrder(row) {
    if (!row) return row;

    return {
        ...row,
        _id: row.id,
        order_id: row.order_id,
        orderId: row.order_id || row.id,

        restaurantId: populated(row.restaurant, row.restaurantId),
        userId: populated(row.user, row.userId),

        items: (row.items || []).map((item) => ({
            ...item,
            price: money(item.price),
            variantPrice: money(item.variantPrice),
            otherPrice: money(item.otherPrice),
            addons: item.addons || []
        })),

        deliveryAddress: {
            label: row.addrLabel,
            name: row.addrName,
            fullName: row.addrFullName,
            street: row.addrStreet,
            additionalDetails: row.addrAdditionalDetails,
            city: row.addrCity,
            state: row.addrState,
            zipCode: row.addrZipCode,
            phone: row.addrPhone,
            location: geoPoint(row.addrLat, row.addrLng)
        },

        pricing: {
            subtotal: money(row.subtotal),
            tax: money(row.tax),
            packagingFee: money(row.packagingFee),
            deliveryFee: money(row.deliveryFee),
            deliveryFeeGst: money(row.deliveryFeeGst),
            platformFee: money(row.platformFee),
            quickDeliveryFee: money(row.quickDeliveryFee),
            deliveryMode: row.deliveryMode,
            restaurantCommission: money(row.restaurantCommission),
            discount: money(row.discount),
            couponCode: row.couponCode,
            total: money(row.total),
            currency: row.currency,
            distanceKm: num(row.distanceKm),
            roadDistanceKm: num(row.roadDistanceKm),
            roadDurationMins: row.roadDurationMins
        },

        payment: {
            method: row.paymentMethod,
            status: row.paymentStatus,
            amountDue: num(row.paymentAmountDue),
            razorpay: {
                orderId: row.razorpayOrderId,
                paymentId: row.razorpayPaymentId,
                signature: row.razorpaySignature
            },
            qr: row.qr || undefined,
            refund: {
                status: row.refundStatus,
                amount: money(row.refundAmount),
                refundId: row.refundId,
                processedAt: row.refundProcessedAt
            }
        },

        dispatch: {
            modeAtCreation: 'auto',
            status: row.dispatchStatus,
            deliveryPartnerId: populated(row.deliveryPartner, row.dispatchDeliveryPartnerId),
            assignedAt: row.dispatchAssignedAt,
            acceptedAt: row.dispatchAcceptedAt,
            dispatchingAt: row.dispatchingAt,
            offeredTo: (row.dispatchOffers || []).map((offer) => ({
                partnerId: offer.partnerId,
                at: offer.at,
                action: offer.action
            }))
        },

        deliveryState: {
            currentPhase: row.deliveryPhase,
            status: row.deliveryStatus,
            reachedPickupAt: row.reachedPickupAt,
            reachedDropAt: row.reachedDropAt,
            pickedUpAt: row.pickedUpAt,
            deliveredAt: row.deliveredAt
        },

        statusHistory: row.statusHistory || [],

        ratings: {
            restaurant: entityRating(row.restaurantRating, row.restaurantRatingComment, row.restaurantRatedAt),
            deliveryPartner: entityRating(row.partnerRating, row.partnerRatingComment, row.partnerRatedAt),
            customer: entityRating(row.customerRating, row.customerRatingComment, row.customerRatedAt),
            items: (row.itemRatings || []).map(({ itemId, name, rating, comment, ratedAt }) => ({
                itemId, name, rating, comment, ratedAt
            }))
        },

        deliveryVerification: {
            dropOtp: { required: row.dropOtpRequired, verified: row.dropOtpVerified }
        },

        lastRiderLocation: geoPoint(row.riderLat, row.riderLng),

        riderEarning: money(row.riderEarning),
        platformProfit: money(row.platformProfit),
        tripDistanceKm: num(row.tripDistanceKm)
    };
}

export const toOrders = (rows) => (rows || []).map(toOrder);

/**
 * Same treatment for the per-order financial split, which callers read as
 * `tx.payment.qr.paymentLinkId`, `tx.pricing.total` and `tx.amounts.riderShare`.
 */
export function toFoodTransaction(row) {
    if (!row) return row;

    return {
        ...row,
        _id: row.id,
        payment: {
            method: row.paymentMethod,
            status: row.paymentStatusLabel,
            amountDue: money(row.amountDue),
            razorpay: {
                orderId: row.razorpayOrderId || '',
                paymentId: row.razorpayPaymentId || '',
                signature: row.razorpaySignature || ''
            },
            qr: row.qr || {}
        },
        pricing: {
            subtotal: money(row.subtotal),
            tax: money(row.tax),
            packagingFee: money(row.packagingFee),
            deliveryFee: money(row.deliveryFee),
            deliveryFeeGst: money(row.deliveryFeeGst),
            platformFee: money(row.platformFee),
            restaurantCommission: money(row.restaurantCommission),
            discount: money(row.discount),
            couponCode: row.couponCode,
            total: money(row.total),
            currency: row.currency
        },
        amounts: {
            totalCustomerPaid: money(row.totalCustomerPaid),
            restaurantShare: money(row.restaurantShare),
            // Column is `commissionAmount` so it does not collide with the pricing
            // snapshot's own restaurantCommission; callers still read `amounts.restaurantCommission`.
            restaurantCommission: money(row.commissionAmount),
            riderShare: money(row.riderShare),
            platformNetProfit: money(row.platformNetProfit),
            taxAmount: money(row.taxAmount),
            adminDiscountShare: money(row.adminDiscountShare),
            restaurantDiscountShare: money(row.restaurantDiscountShare),
            discountAdminBearPercentage: money(row.discountAdminBearPercentage),
            discountRestaurantBearPercentage: money(row.discountRestaurantBearPercentage)
        },
        gateway: {
            provider: row.gatewayProvider,
            razorpayOrderId: row.razorpayOrderId,
            razorpayPaymentId: row.razorpayPaymentId,
            razorpaySignature: row.razorpaySignature,
            qrUrl: row.qr?.imageUrl
        },
        settlement: {
            isRestaurantSettled: row.isRestaurantSettled,
            restaurantSettledAt: row.restaurantSettledAt,
            isRiderSettled: row.isRiderSettled,
            riderSettledAt: row.riderSettledAt
        },
        history: row.history || []
    };
}

/**
 * Nested write payload → flat Prisma `data`.
 *
 * Only keys actually present are emitted, so this works for both create and a
 * partial update. `items`, `statusHistory` and `dispatch.offeredTo` are relations
 * and are handled by the caller — a mapper that silently rewrote child rows would
 * make every update a delete-and-recreate.
 */
export function fromOrder(input = {}) {
    const data = {};
    const set = (key, value) => {
        if (value !== undefined) data[key] = value;
    };

    const SKIP = new Set([
        'pricing', 'payment', 'dispatch', 'deliveryState', 'ratings',
        'deliveryAddress', 'deliveryVerification', 'lastRiderLocation',
        // relations and derived fields, never columns
        'items', 'statusHistory', 'itemRatings', 'dispatchOffers',
        'restaurant', 'user', 'deliveryPartner', 'zone', 'foodTransaction',
        'payments', 'refunds', 'transactions', 'chatMessages',
        '_id', 'id', 'orderId',
    ]);

    for (const [key, value] of Object.entries(input)) {
        if (SKIP.has(key)) continue;
        // A populated relation sits in the id field; write back only the id.
        if ((key === 'restaurantId' || key === 'userId' || key === 'zoneId') && value && typeof value === 'object') {
            data[key] = value.id;
            continue;
        }
        data[key] = value;
    }

    const { pricing, payment, dispatch, deliveryState, ratings,
            deliveryAddress: addr, deliveryVerification: verify, lastRiderLocation: rider } = input;

    if (addr) {
        set('addrLabel', addr.label);
        set('addrName', addr.name);
        set('addrFullName', addr.fullName);
        set('addrStreet', addr.street);
        set('addrAdditionalDetails', addr.additionalDetails);
        set('addrCity', addr.city);
        set('addrState', addr.state);
        set('addrZipCode', addr.zipCode);
        set('addrPhone', addr.phone);
        const [lng, lat] = addr.location?.coordinates || [];
        set('addrLat', lat);
        set('addrLng', lng);
    }

    if (pricing) {
        for (const key of ['subtotal', 'tax', 'packagingFee', 'deliveryFee', 'deliveryFeeGst',
                           'platformFee', 'quickDeliveryFee', 'deliveryMode', 'restaurantCommission',
                           'discount', 'couponCode', 'total', 'currency', 'distanceKm',
                           'roadDistanceKm', 'roadDurationMins']) {
            set(key, pricing[key]);
        }
    }

    if (payment) {
        set('paymentMethod', payment.method);
        set('paymentStatus', payment.status);
        set('paymentAmountDue', payment.amountDue);
        set('razorpayOrderId', payment.razorpay?.orderId);
        set('razorpayPaymentId', payment.razorpay?.paymentId);
        set('razorpaySignature', payment.razorpay?.signature);
        set('qr', payment.qr);
        set('refundStatus', payment.refund?.status);
        set('refundAmount', payment.refund?.amount);
        set('refundId', payment.refund?.refundId);
        set('refundProcessedAt', payment.refund?.processedAt);
    }

    if (dispatch) {
        set('dispatchStatus', dispatch.status);
        set(
            'dispatchDeliveryPartnerId',
            dispatch.deliveryPartnerId && typeof dispatch.deliveryPartnerId === 'object'
                ? dispatch.deliveryPartnerId.id
                : dispatch.deliveryPartnerId
        );
        set('dispatchAssignedAt', dispatch.assignedAt);
        set('dispatchAcceptedAt', dispatch.acceptedAt);
        set('dispatchingAt', dispatch.dispatchingAt);
    }

    if (deliveryState) {
        set('deliveryPhase', deliveryState.currentPhase);
        set('deliveryStatus', deliveryState.status);
        set('reachedPickupAt', deliveryState.reachedPickupAt);
        set('reachedDropAt', deliveryState.reachedDropAt);
        set('pickedUpAt', deliveryState.pickedUpAt);
        set('deliveredAt', deliveryState.deliveredAt);
    }

    if (ratings) {
        set('restaurantRating', ratings.restaurant?.rating);
        set('restaurantRatingComment', ratings.restaurant?.comment);
        set('restaurantRatedAt', ratings.restaurant?.ratedAt);
        set('partnerRating', ratings.deliveryPartner?.rating);
        set('partnerRatingComment', ratings.deliveryPartner?.comment);
        set('partnerRatedAt', ratings.deliveryPartner?.ratedAt);
        set('customerRating', ratings.customer?.rating);
        set('customerRatingComment', ratings.customer?.comment);
        set('customerRatedAt', ratings.customer?.ratedAt);
    }

    if (verify?.dropOtp) {
        set('dropOtpRequired', verify.dropOtp.required);
        set('dropOtpVerified', verify.dropOtp.verified);
    }

    if (rider) {
        const [lng, lat] = rider.coordinates || [];
        set('riderLat', lat);
        set('riderLng', lng);
    }

    return data;
}
