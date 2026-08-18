/**
 * Centralized queue names for BullMQ.
 * Used by producers, workers, and queue initialization.
 *
 * There used to be otp, notification, payment and maintenance queues here as
 * well. The first three had a worker in the process list and a processor, and
 * no producer that anything ever called — idle processes. OTPs and pushes are
 * sent directly, and the payment processor's post-delivery split is done by
 * the live FoodTransaction path; wiring it up would have paid everyone twice.
 * Maintenance scheduled two jobs that scripts/run-scheduled-jobs.js already
 * runs, so the two schedulers raced each other for the monthly billing.
 */
export const ORDER_QUEUE = 'order';
export const TRACKING_QUEUE = 'tracking';

export const QUEUE_NAMES = Object.freeze([
    ORDER_QUEUE,
    TRACKING_QUEUE
]);
