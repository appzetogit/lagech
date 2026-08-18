/**
 * Centralized queue names for BullMQ.
 * Used by producers, workers, and queue initialization.
 *
 * There used to be otp, notification and payment queues here as well. Each had
 * a worker in the process list and a processor, and no producer that anything
 * ever called — three idle processes. OTPs and pushes are sent directly, and
 * the payment processor's post-delivery split is done by the live
 * FoodTransaction path; wiring it up would have paid everyone twice.
 */
export const ORDER_QUEUE = 'order';
export const TRACKING_QUEUE = 'tracking';
export const MAINTENANCE_QUEUE = 'maintenance';

export const QUEUE_NAMES = Object.freeze([
    ORDER_QUEUE,
    TRACKING_QUEUE,
    MAINTENANCE_QUEUE
]);
