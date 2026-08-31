/**
 * Seeds one approved demo restaurant with a small menu.
 *
 * Builds the row through the application's own deriveRestaurantFields and
 * fromRestaurantLocation rather than writing columns directly. Those derive
 * restaurantNameNormalized and ownerPhoneLast10 -- which together form a unique
 * constraint -- and the flat lat/lng columns the PostGIS trigger reads to build
 * the geography point. Hand-writing the columns produces a row that looks right
 * but is invisible to name search and to every ST_DWithin delivery-radius query.
 *
 * Idempotent on that unique pair, so re-running updates rather than duplicating.
 *
 *   node scripts/seed-demo-restaurant.mjs
 */
import 'dotenv/config';
import { prisma } from '../src/config/prisma.js';
import { deriveRestaurantFields, fromRestaurantLocation } from '../src/modules/food/restaurant/restaurant.mapper.js';

const NAME = 'Kadhai Chammach';
const PHONE = '9876543210';

const derived = deriveRestaurantFields({
    restaurantName: NAME,
    ownerPhone: PHONE,
    estimatedDeliveryTime: '25-30 mins',
});

const location = fromRestaurantLocation({
    // Central Indore. Real coordinates matter: delivery zones are polygons and
    // a restaurant at 0,0 falls outside every one of them.
    latitude: 22.7196,
    longitude: 75.8577,
    formattedAddress: '12 MG Road, Indore, Madhya Pradesh 452001',
    addressLine1: '12 MG Road',
    area: 'MG Road',
    city: 'Indore',
    state: 'Madhya Pradesh',
    pincode: '452001',
});

const data = {
    restaurantName: NAME,
    ownerName: 'Demo Owner',
    ownerEmail: 'owner@example.com',
    ownerPhone: PHONE,
    primaryContactNumber: PHONE,
    ...derived,
    ...location,
    cuisines: ['North Indian', 'Chinese'],
    openingTime: '10:00',
    closingTime: '23:00',
    openDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    pureVegRestaurant: false,
    isAcceptingOrders: true,
    estimatedDeliveryTime: '25-30 mins',
    featuredDish: 'Paneer Butter Masala',
    featuredPrice: 260,
    rating: 4.3,
    totalRatings: 128,
    // Admin-created restaurants are approved on creation; pending ones are
    // hidden from customers, which makes for a poor demo.
    status: 'approved',
    approvedAt: new Date(),
};

const restaurant = await prisma.foodRestaurant.upsert({
    where: {
        restaurantNameNormalized_ownerPhoneLast10: {
            restaurantNameNormalized: derived.restaurantNameNormalized,
            ownerPhoneLast10: derived.ownerPhoneLast10,
        },
    },
    create: data,
    update: data,
});
console.log(`restaurant: ${restaurant.restaurantName} (${restaurant.id}) status=${restaurant.status}`);

const CATEGORIES = [
    {
        name: 'Main Course',
        items: [
            ['Paneer Butter Masala', 260, 'Veg'],
            ['Dal Makhani', 220, 'Veg'],
            ['Butter Chicken', 340, 'NonVeg'],
        ],
    },
    { name: 'Breads', items: [['Garlic Naan', 70, 'Veg'], ['Tandoori Roti', 30, 'Veg']] },
    { name: 'Desserts', items: [['Gulab Jamun', 90, 'Veg']] },
];

let itemCount = 0;
for (const { name, items } of CATEGORIES) {
    // Scoped to this restaurant rather than global: a demo category should not
    // appear in every other restaurant's menu.
    const existing = await prisma.foodCategory.findFirst({ where: { name, restaurantId: restaurant.id } });
    const category = existing ?? await prisma.foodCategory.create({
        data: { name, restaurantId: restaurant.id, createdByRestaurantId: restaurant.id, isApproved: true },
    });

    for (const [itemName, price, foodType] of items) {
        const found = await prisma.foodItem.findFirst({ where: { restaurantId: restaurant.id, name: itemName } });
        const payload = {
            restaurantId: restaurant.id,
            name: itemName,
            price,
            categoryId: category.id,
            categoryName: name,
            foodType,
            isAvailable: true,
        };
        if (found) await prisma.foodItem.update({ where: { id: found.id }, data: payload });
        else await prisma.foodItem.create({ data: payload });
        itemCount += 1;
    }
}
console.log(`menu: ${CATEGORIES.length} categories, ${itemCount} items`);

await prisma.$disconnect();
