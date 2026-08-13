import { prisma } from "../../../../config/prisma.js";
import { isId } from "../../../../utils/helpers.js";

const toNum = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const logRestaurantSubscriptionHistory = async (payload = {}) => {
  const restaurantId = String(payload?.restaurantId || "");
  if (!isId(restaurantId)) return null;
  if (!payload?.eventType) return null;

  return prisma.foodRestaurantSubscriptionHistory.create({
    data: {
      restaurantId,
      eventType: String(payload.eventType),
      plan: String(payload.plan || "").toLowerCase(),
      paymentType: String(payload.paymentType || "").toLowerCase(),
      amount: Math.max(0, toNum(payload.amount, 0)),
      dueBefore: Math.max(0, toNum(payload.dueBefore, 0)),
      dueAfter: Math.max(0, toNum(payload.dueAfter, 0)),
      paidBefore: Math.max(0, toNum(payload.paidBefore, 0)),
      paidAfter: Math.max(0, toNum(payload.paidAfter, 0)),
      gmvLast30Days: Math.max(0, toNum(payload.gmvLast30Days, 0)),
      note: String(payload.note || "").trim(),
      metadata: payload?.metadata && typeof payload.metadata === "object" ? payload.metadata : {},
    },
  });
};

export const getRestaurantSubscriptionHistory = async (restaurantId, query = {}) => {
  if (!isId(restaurantId)) return { items: [], page: 1, limit: 20, total: 0 };

  const page = Math.max(1, Number(query?.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(query?.limit) || 20));
  const rid = String(restaurantId);

  const [items, total, restaurant] = await Promise.all([
    prisma.foodRestaurantSubscriptionHistory.findMany({
      where: { restaurantId: rid },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.foodRestaurantSubscriptionHistory.count({ where: { restaurantId: rid } }),
    prisma.foodRestaurant.findUnique({
      where: { id: rid },
      select: {
        id: true, subscriptionPlan: true, subscriptionAmount: true,
        subscriptionPaidAmount: true, subscriptionDueAmount: true,
        subscriptionStatus: true, subscriptionValidTill: true,
        createdAt: true, updatedAt: true,
      },
    }),
  ]);

  if (total > 0 || !restaurant) return { items, page, limit, total };

  // Backward-compatible fallback for restaurants created before history logging existed.
  const fallbackItem = {
    _id: `fallback-${restaurant.id}`,
    restaurantId: restaurant.id,
    eventType: "subscription_payment",
    plan: String(restaurant.subscriptionPlan || "").toLowerCase(),
    paymentType: "legacy",
    amount: Math.max(0, toNum(restaurant.subscriptionPaidAmount, 0)),
    dueBefore: Math.max(0, toNum(restaurant.subscriptionAmount, 0)),
    dueAfter: Math.max(0, toNum(restaurant.subscriptionDueAmount, 0)),
    paidBefore: 0,
    paidAfter: Math.max(0, toNum(restaurant.subscriptionPaidAmount, 0)),
    gmvLast30Days: 0,
    note: "Legacy subscription state imported for history visibility",
    metadata: { source: "fallback_legacy_subscription" },
    createdAt: restaurant.updatedAt || restaurant.createdAt || new Date(),
    updatedAt: restaurant.updatedAt || restaurant.createdAt || new Date(),
  };

  return { items: [fallbackItem], page, limit, total: 1 };
};

export const getAdminRestaurantSubscriptionHistory = async (query = {}) => {
  const page = Math.max(1, Number(query?.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(query?.limit) || 20));
  const search = String(query?.search || "").trim();

  const where = { status: "approved" };
  if (search) {
    where.OR = [
      { restaurantName: { contains: search, mode: "insensitive" } },
      { ownerName: { contains: search, mode: "insensitive" } },
      { ownerPhone: { contains: search, mode: "insensitive" } },
    ];
  }

  const [rows, total] = await Promise.all([
    prisma.foodRestaurant.findMany({
      where,
      select: {
        id: true, restaurantName: true, ownerName: true, ownerPhone: true,
        subscriptionPlan: true, subscriptionStatus: true, subscriptionDueAmount: true,
        subscriptionValidTill: true, subscriptionAutoDeductedAmount: true,
      },
      orderBy: { updatedAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.foodRestaurant.count({ where }),
  ]);

  const ids = rows.map((row) => row.id);
  const now = new Date();
  const start = new Date(now);
  start.setDate(start.getDate() - 30);

  // The Mongo pipeline folded "newest event" and "sum of auto-deducts" into one
  // $group with a $cond. Two groupBys express the same thing without the
  // conditional accumulator.
  const [gmvAgg, lastEventAgg, autoDeductAgg] = await Promise.all([
    prisma.foodTransaction.groupBy({
      by: ["restaurantId"],
      where: {
        restaurantId: { in: ids },
        status: { in: ["authorized", "captured"] },
        createdAt: { gte: start, lte: now },
      },
      _sum: { restaurantShare: true },
    }),
    prisma.foodRestaurantSubscriptionHistory.groupBy({
      by: ["restaurantId"],
      where: { restaurantId: { in: ids } },
      _max: { createdAt: true },
    }),
    prisma.foodRestaurantSubscriptionHistory.groupBy({
      by: ["restaurantId"],
      where: { restaurantId: { in: ids }, eventType: "subscription_auto_deduct" },
      _sum: { amount: true },
    }),
  ]);

  const gmvMap = new Map(
    gmvAgg.map((row) => [row.restaurantId, Math.max(0, toNum(row._sum?.restaurantShare, 0))]),
  );
  const lastEventMap = new Map(lastEventAgg.map((row) => [row.restaurantId, row._max?.createdAt]));
  const autoDeductMap = new Map(
    autoDeductAgg.map((row) => [row.restaurantId, toNum(row._sum?.amount, 0)]),
  );

  const items = rows.map((row) => ({
    ...row,
    gmvLast30Days: gmvMap.get(row.id) || 0,
    totalAutoDeducted: Math.max(
      0,
      autoDeductMap.get(row.id) || 0,
      toNum(row?.subscriptionAutoDeductedAmount, 0),
    ),
    lastEventAt: lastEventMap.get(row.id) || null,
  }));

  return { items, page, limit, total };
};
