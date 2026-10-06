# Suvio — User App API Reference

Every endpoint below was enumerated from the live route files, not from memory.
Anything not listed here does not exist.

- **Base URL:** `https://<api-host>/api`
- **Auth:** `Authorization: Bearer <accessToken>` unless marked **Public**
- **Response envelope:** `{ "success": true, "message": "...", "data": { ... } }`
- **Errors:** `{ "success": false, "message": "<human readable>" }` with a 4xx/5xx status

Two route groups are mounted with a hard role gate — `/v1/food/user/*` and
`/v1/food/orders/*` both require `requireRoles('USER')`. A restaurant or delivery
token gets 403 on those, not 404.

---

## 1. Auth — `/v1/auth`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/v1/auth/user/request-otp` | Public | Send login OTP |
| POST | `/v1/auth/user/verify-otp` | Public | Verify OTP, get tokens |
| POST | `/v1/auth/refresh-token` | Public | Exchange refresh token |
| POST | `/v1/auth/logout` | Bearer | Invalidate session |
| GET | `/v1/auth/me` | Bearer | Current identity |

```jsonc
// POST /v1/auth/user/request-otp
{ "phone": "9876543210" }

// POST /v1/auth/user/verify-otp
{ "phone": "9876543210", "otp": "1234" }
// -> data: { accessToken, refreshToken, user: { _id, name, phone, role } }
```

---

## 2. Catalog & discovery — **Public**

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/food/restaurant/restaurants` | Restaurant list (supports lat/lng, paging) |
| GET | `/v1/food/restaurant/restaurants/:id` | Restaurant detail |
| GET | `/v1/food/restaurant/restaurants/:id/menu` | Menu |
| GET | `/v1/food/restaurant/restaurants/:id/addons` | **Add-ons — see §3** |
| GET | `/v1/food/restaurant/restaurants/:id/outlet-timings` | Opening hours |
| GET | `/v1/food/restaurant/public/foods` | Flat dish list |
| GET | `/v1/food/restaurant/offers` | Offers |
| GET | `/v1/food/restaurant/categories/public` | Categories |
| GET | `/v1/food/search/unified` | Unified search |
| GET | `/v1/food/dining/categories/public` | Dining categories |
| GET | `/v1/food/dining/restaurants/public` | Dining restaurants |

### Landing / banners — all Public

`/v1/food/hero-banners/public`, `/top-banners/public`,
`/hero-banners/under-250/public`, `/hero-banners/dining/public`,
`/hero-banners/home-promotion/public`, `/hero-banners/gourmet/public`,
`/explore-icons/public`, `/landing/settings/public`, `/pages/:key`,
`/referral-settings`, `/zones/detect`, `/zones/nearby`

> The non-`/public` variants of the banner routes are **admin-only** and will 403.

### Recommended restaurants
Every restaurant in `GET /v1/food/restaurant/restaurants` carries `isRecommended` (boolean) and
`recommendedSortOrder` (number). The admin picks and orders the recommended ones
(Restaurant Management → Recommended Restaurants).

`GET /v1/food/restaurant/restaurants?recommended=true` returns only those, in the admin's order
(lowest `recommendedSortOrder` first) unless a `sortBy` is given. It combines with every other filter
(`lat`/`lng`, `zoneId`, `search`, …), so the row shows only recommended restaurants that serve the
customer. An empty list means none are picked for that area — hide the row.

### Nutrition and allergens on dishes
Every dish in the menu (`/restaurants/:id/menu`) and the flat dish list (`/public/foods`) carries:
```json
{ "nutrition": ["Calories 250 kcal", "High protein"], "allergens": ["Peanuts"] }
```
Both are always arrays (empty when not set), free text as entered by the restaurant or admin. Show
them on the dish detail; they are not searchable.

---

## 3. Add-ons (per-item, Zomato-style)

```
GET /v1/food/restaurant/restaurants/:restaurantId/addons?foodId=<menuItemId>
```

`foodId` is optional. With it you get that dish's add-ons **plus** any whole-menu
ones. Without it you get everything the restaurant offers.

```jsonc
{
  "data": {
    // Flat list — every add-on, each carrying its own foodIds + group
    "addons": [
      {
        "id": "...", "name": "Extra Cheese Slice", "price": 30,
        "isVeg": true, "image": "", "images": [],
        "foodIds": ["6a646591..."],       // empty => applies to whole menu
        "appliesToWholeMenu": false,
        "group": { "name": "Upgrade Your Base", "minSelect": 0, "maxSelect": 1, "sortOrder": 1 }
      }
    ],
    // Ready-to-render groups — use THIS for the item sheet
    "groups": [
      {
        "name": "Upgrade Your Base",
        "title": "Upgrade Your Base",
        "minSelect": 0,
        "maxSelect": 1,
        "isRequired": false,
        "selectionLabel": "Select up to 1 option",
        "selectionType": "single",      // "single" => radios, "multi" => checkboxes
        "options": [ /* addon objects */ ]
      }
    ]
  }
}
```

Rendering rules, so the sheet matches Zomato:
- `selectionType: "single"` → radio buttons, at most one selected
- `selectionType: "multi"` → checkboxes, capped at `maxSelect`
- `isRequired: true` → block "Add item" until `minSelect` are chosen
- Show `selectionLabel` verbatim as the group subtitle

**Adding add-ons to the cart:** send each selected add-on as its own entry in
`items[]` using its add-on `id` as `itemId`. The server prices it from the
published record — client prices are ignored.

> Known gap: add-on line items carry no parent-item reference yet, so the cart
> cannot yet say *which* burger the cheese belongs to. Needs a `parentItemId`
> field on the order item schema.

---

## 4. Cart & addresses — `/v1/food/user`

| Method | Path | Purpose |
|---|---|---|
| PUT | `/v1/food/user/cart` | Replace the server-side cart |
| GET | `/v1/food/user/addresses` | List addresses |
| POST | `/v1/food/user/addresses` | Add address |
| PATCH | `/v1/food/user/addresses/:addressId` | Edit address |
| DELETE | `/v1/food/user/addresses/:addressId` | Remove address |
| PATCH | `/v1/food/user/addresses/:addressId/default` | Set default |

---

## 5. Orders — `/v1/food/orders`

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/food/orders/calculate` | Price the cart before placing |
| POST | `/v1/food/orders` | Place order |
| POST | `/v1/food/orders/verify-payment` | Verify Razorpay signature |
| DELETE | `/v1/food/orders/:orderId/pending-payment` | Abandon an unpaid order |
| GET | `/v1/food/orders` | Order history (paged) |
| GET | `/v1/food/orders/:orderId` | Single order |
| GET | `/v1/food/orders/:orderId/route` | **Live tracking route — see §6** |
| GET | `/v1/food/orders/:orderId/drop-otp` | Handover OTP |
| GET | `/v1/food/orders/:orderId/payments` | Payment ledger |
| PATCH | `/v1/food/orders/:orderId/cancel` | Cancel |
| PATCH | `/v1/food/orders/:orderId/ratings` | **Ratings — see §7** |
| PATCH | `/v1/food/orders/:orderId/instructions` | Update delivery instructions |

### Placing an order

```jsonc
POST /v1/food/orders
{
  "restaurantId": "6a633bd2bacbe2b007e206e7",
  "items": [
    { "itemId": "6a646591e53ad2837c40e3d4", "quantity": 1, "variantId": "", "notes": "" },
    { "itemId": "<addonId>", "quantity": 1 }
  ],
  "address": { "street": "...", "city": "...", "state": "...", "location": { "lat": 0, "lng": 0 } },
  "pricing": { /* from /calculate */ },
  "paymentMethod": "razorpay_qr",
  "note": "", "deliveryInstructions": "", "sendCutlery": true
}
```

### Coupons at checkout

Unchanged contract: send the code as `couponCode` to `POST /orders/calculate`, then send the
`pricing` it returns (which carries `couponCode`) with `POST /orders`. Codes are matched
case-insensitively. A code that does not apply never fails `/calculate`; the cart is priced
without it and the reason comes back. Fields added to `pricing` (all additive):

```jsonc
{
  "discount": 50,                 // item discount (0 for a free-delivery coupon)
  "deliveryFee": 0,               // after a free-delivery coupon
  "deliveryFeeGst": 0,
  "originalDeliveryFee": 40,      // before any waiver
  "deliveryFeeWaived": 47.2,      // delivery fee + its GST taken off by a free-delivery coupon, else 0
  "couponId": "6a6…",             // the coupon that applied, else null
  "couponError": null,            // why the sent code did not apply, ready to show, e.g.
                                  // "This coupon expired on 9 Oct 2026",
                                  // "Add items worth ₹100 more to use this coupon (minimum purchase ₹600)"
  "couponErrorReason": null,      // machine-readable: not_found | inactive | not_started | expired |
                                  // wrong_restaurant | wrong_zone | login_required | not_eligible |
                                  // not_first_order | min_purchase | limit_reached | user_limit_reached
  "appliedCoupon": {              // null when no code applied; `code` and `discount` as before
    "code": "SAVE50", "discount": 50, "couponId": "6a6…", "title": "Weekend treat",
    "couponType": "default",      // default | store_wise | zone_wise | free_delivery | first_order
    "freeDelivery": false, "deliveryFeeWaived": 0,
    "savings": 50                 // discount + deliveryFeeWaived
  }
}
```

Rules: `store_wise` only at its restaurant(s); `zone_wise` only when the order's zone (the `zoneId`
sent, else the restaurant's) is one of its zones; `free_delivery` waives the delivery fee and its
GST (item GST, platform fee and the Quick Mode surcharge are still charged); `first_order` only while
the customer has no placed order (cancelled orders, unpaid online orders and failed payments do not
count); `default` any order. Every coupon also checks: switched on, between its start date (00:00
IST) and expire date (23:59 IST), customer restriction, minimum purchase on the item subtotal, the
percent cap (`maxDiscount`), and "limit for same user" (counted from the customer's orders with that
coupon, again excluding cancelled/unpaid/failed).

`POST /orders` with a `pricing.discount` (or `pricing.deliveryFeeWaived`) above 0 for a coupon that no
longer applies returns 400 with the reason, e.g. `"This coupon is not active. Please review your
cart and try again."` — re-run `/calculate` and show the new total. Echoing a code that never
applied (discount 0) places the order as before. Orders read back carry `pricing.couponId` and
`pricing.deliveryFeeWaived`.

`GET /v1/food/restaurant/offers` (coupon list): each entry adds `couponTitle` (the admin's title),
`couponType`, `freeDelivery`, `zoneIds`, `startDate`; `title` stays the headline ("20% OFF",
"Flat ₹50 OFF", now "Free Delivery" for free-delivery coupons). Zone-wise coupons are listed only
when the zone is known (from `restaurantId`, or a `zoneId` query param) and matches.

### Payment methods

`"cash" | "razorpay" | "razorpay_qr" | "card" | "wallet" | "offline"`

Which of these the customer may use is set by the admin (Business Settings →
Payment / Customer) and published in `GET /v1/food/public/app-settings` →
`business.payment` (see §17). Show only the switched-on ones; placing an order
with a switched-off method returns 400 with a message for the customer:

- `cash` — `business.payment.cod`. "Cash on Delivery is not available right now. Please pay online."
- `razorpay`, `razorpay_qr`, `card` — `business.payment.digital`.
- `wallet` — `business.payment.wallet`.
- `offline` — `business.payment.offline` (and the methods from `/offline-payment-methods`).

Partial payment (part wallet, rest online or cash) is **not** available yet:
`business.payment.partialPayment` is published for later but a wallet order
must still cover the whole total.

**`razorpay_qr` is the pay-at-the-door replacement.** Same UX as COD: nothing is
charged upfront, the order dispatches immediately, `payment.status` stays
`pending_qr`, and the rider presents a QR on arrival. No `verify-payment` call.
If the QR fails the rider can switch the order to cash from their side.

For `razorpay` / `card`, call `verify-payment` after checkout:

```jsonc
POST /v1/food/orders/verify-payment
{ "orderId": "...", "razorpayOrderId": "...", "razorpayPaymentId": "...", "razorpaySignature": "..." }
```

### Offline payment (bank transfer, UPI, ...)

The admin sets up offline methods (System Settings → 3rd Party & Configurations →
Offline Payment Setup) and can switch the whole feature off. Show "Offline payment"
at checkout only when `enabled` is `true` and `methods` is not empty.

```jsonc
GET /v1/food/public/offline-payment-methods        // public, no login
{
  "data": {
    "enabled": true,
    "methods": [
      {
        "id": "3f9c0a1b2c3d4e5f",
        "name": "Bank transfer",
        // Show these to the customer: where to send the money.
        "paymentInfo": [
          { "label": "Account number", "value": "..." },
          { "label": "IFSC", "value": "..." }
        ],
        // The customer fills these in after paying. type: text | number | email.
        // A number field is digits only (leading zeros kept); send it as a string.
        "fields": [
          { "key": "transaction_id", "label": "Transaction id", "type": "text", "required": true, "placeholder": "" }
        ]
      }
    ]
  }
}
```

Place the order with `paymentMethod: "offline"` and the method's `id`, with the
customer's values keyed by each field's `key`:

```jsonc
POST /v1/food/orders
{
  // ...cart as above...
  "paymentMethod": "offline",
  "offlinePayment": {
    "methodId": "3f9c0a1b2c3d4e5f",
    "fields": { "transaction_id": "UTR123456789" },
    "note": "Paid from my SBI account"          // optional, max 300
  }
}
```

- 400 with a readable message when offline payment is off, the method is not
  active, or a required field is blank (`"Transaction id is required"`).
- No `verify-payment` call and no Razorpay. The order comes back with
  `orderStatus: "pending_payment"`, `payment.method: "offline"`,
  `payment.status: "created"`, and `offlinePayment`:
  ```jsonc
  "offlinePayment": {
    "status": "pending",                  // pending | verified | rejected
    "methodId": "...", "methodName": "Bank transfer",
    "paymentInfo": [ ... ],               // as shown at checkout, frozen on the order
    "fields": [ { "key": "transaction_id", "label": "Transaction id", "value": "UTR123456789" } ],
    "customerNote": "", "submittedAt": "2026-10-06T10:00:00.000Z",
    "decidedAt": null, "adminNote": ""    // set once the admin decides
  }
  ```
- Unlike an unpaid Razorpay order, an offline order **is listed** in
  `GET /v1/food/orders` while it waits, so show it with a "Payment being verified"
  state. The restaurant does not see it yet. It is never auto-deleted, and
  `DELETE /:orderId/pending-payment` is refused for it (the customer may already
  have paid); the customer contacts support instead.
- The admin then either:
  - **verifies** it: `payment.status` → `paid`, `offlinePayment.status` → `verified`,
    `orderStatus` → `created`, and from here it is an ordinary paid order (the
    restaurant gets it, tracking etc. as usual). Push `data.type: "order_created"`.
  - **rejects** it: `payment.status` → `failed`, `orderStatus` → `cancelled_by_admin`,
    `offlinePayment.status` → `rejected` with the reason in `offlinePayment.adminNote`.
    Push `data.type: "payment_failed"` and socket `order_status_update`.
- Refunds of a verified offline payment are not automatic; support handles them.

---

## 6. Live tracking

```
GET /v1/food/orders/:orderId/route
```

```jsonc
{
  "data": {
    "polyline": "<encoded polyline>",
    "distanceKm": 2.94, "distanceMeters": 2940,
    "durationSeconds": 660, "durationMins": 11,
    "target": "restaurant",              // "restaurant" pre-pickup, "customer" after
    "origin": { "lat": 22.72, "lng": 75.88 },   // the RIDER's position
    "destination": { "lat": 22.71, "lng": 75.88 }
  }
}
```

- The origin is the rider's last known position, resolved **server-side**. This
  endpoint accepts no coordinates from the client.
- `target` flips automatically at pickup, so the polyline is always the leg the
  rider is actually on.
- Poll roughly every 12s while an order is active, plus immediately on any status
  change. `polyline` may be `""` before a rider is assigned and located — draw a
  dotted arc between restaurant and address until then.
- `origin` doubles as the rider marker position when no socket fix has arrived.

Live position also arrives over Socket.IO (`location-update` in room
`tracking:<orderId>`) and Firebase RTDB at `active_orders/{orderMongoId}`.

> RTDB caveat: `boy_lat`/`boy_lng` in that node are seeded with the **restaurant's**
> coordinates at accept time. They are not a rider fix until the rider actually
> pings. Do not treat them as a position.

---

## 7. Ratings

```
PATCH /v1/food/orders/:orderId/ratings
```

```jsonc
{
  "restaurantRating": 5,
  "restaurantComment": "Great food",
  "deliveryPartnerRating": 4,
  "deliveryPartnerComment": "Fast and polite",
  "itemRatings": [
    { "itemId": "6a646591e53ad2837c40e3d4", "rating": 5, "comment": "Perfect" }
  ]
}
```

Returns the updated order in `data.order`.

Constraints the UI must respect:
- Only `delivered` orders → else `"You can rate only delivered orders"`
- `deliveryPartnerRating` is **mandatory** when the order had a rider → show both
  star rows together
- One submission per order → a second call returns `"Ratings already submitted"`
- `itemRatings` is optional; `itemId` must be a dish on **that** order, and each
  dish may be rated once

| Direction | Where |
|---|---|
| Customer → restaurant | `restaurantRating` |
| Customer → delivery boy | `deliveryPartnerRating` |
| Customer → each dish | `itemRatings[]` |
| Rider → customer | `PATCH /v1/food/delivery/orders/:orderId/rate-customer` (rider token) |

`GET /v1/food/orders/:orderId` populates the rider with `rating` and
`totalRatings`, so their score can be shown on the tracking screen with no extra
call.

---

## 8. Wallet, cashback, refunds, referrals — `/v1/food/user`

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/food/user/wallet` | Balance + transactions |
| POST | `/v1/food/user/wallet/topup/order` | Create a top-up order |
| POST | `/v1/food/user/wallet/topup/verify` | Verify top-up payment |
| GET | `/v1/food/user/cashback` | Cashback history |
| GET | `/v1/food/user/refunds` | Refund history |
| GET | `/v1/food/user/referrals/stats` | Referral totals |
| GET | `/v1/food/user/referrals/details` | Referral breakdown |

Read-only mirrors under `/v1/food/payments`: `/wallet/balance`,
`/wallet/transactions`, `/orders/:orderId/payments`, `/orders/:orderId/transactions`,
`/orders/:orderId/refunds`.

---

## 9. Profile & support — `/v1/food/user`

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/food/user/profile` | Get profile |
| PATCH | `/v1/food/user/profile` | Update profile |
| POST | `/v1/food/user/profile/profile-image` | Upload avatar |
| DELETE | `/v1/food/user/profile` | Delete account |
| POST | `/v1/food/user/support/ticket` | Raise a ticket |
| GET | `/v1/food/user/support/my-tickets` | List tickets |
| POST | `/v1/food/user/safety-emergency-reports` | Raise an SOS report |
| GET | `/v1/food/user/safety-emergency-reports` | List SOS reports |

---

## 10. Chat — `/v1/food/chat`

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/food/chat/conversations` | Conversation list |
| GET | `/v1/food/chat/messages` | Messages in a conversation |
| POST | `/v1/food/chat/messages` | Send a message |

`conversationId` equals `order._id.toString()`. Live messages arrive over
Socket.IO.

---

## 11. Notifications & FCM

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/food/notifications/inbox` | Notification inbox |
| PATCH | `/v1/food/notifications/:id/read` | Mark read |
| DELETE | `/v1/food/notifications/:id` | Delete one |
| DELETE | `/v1/food/notifications/inbox/all` | Clear inbox |
| POST | `/v1/fcm-tokens/mobile/save` | **Register device token** |
| DELETE | `/v1/fcm-tokens/remove` | Unregister |

```jsonc
POST /v1/fcm-tokens/mobile/save
{ "ownerType": "USER", "ownerId": "<userId>", "token": "<fcm token>", "platform": "mobile" }
```

Call this on login **and on every token refresh**. A device with no stored token
cannot be reached by any push, and this is currently the most common cause of
"notifications not arriving".

User-facing pushes carry `data.type = "order_status_update"` with `orderId`,
`orderMongoId` and `orderStatus`, and use the Android channel
`high_importance_channel` — which the user app already creates at
`Importance.max`. Keep that channel id, or Android silently downgrades the
notification to a non-heads-up default channel.

Other order pushes: `order_created` (order placed / offline payment verified),
`order_cancelled`, `refund_processed`, `delivery_accepted` (rider assigned) and
`payment_failed` (an online payment that could not be confirmed, or an offline
payment the admin rejected). The title and body of these can be reworded or
switched off by the admin (Firebase Notification page), so the app should show
the `title`/`body` it receives rather than building its own text from the type.

Analytics ids the admin set (Analytics Script page) are in
`GET /v1/food/public/app-settings` → `data.analytics`
(`{ "googleAnalytics": "G-…", "googleTagManager": "GTM-…", "metaPixel": "123…" }`,
only the tools switched on), and alone at `GET /v1/food/public/analytics`.

---

## 12. Socket.IO

Rooms: `user:<userId>`, `tracking:<orderId>`.

| Event | Direction | Meaning |
|---|---|---|
| `location-update` | in | Rider moved: `{ lat, lng, heading }` |
| `order_status_update` | in | Status changed — refetch the order over REST |
| `delivery_drop_otp` | in | Handover OTP |
| `new_message` | in | Chat message |

REST is authoritative. Treat socket events as a signal to refetch, not as the
source of truth.

## 13. Promotions and cancel reasons — public, no login

### `GET /v1/food/public/advertisements`
Restaurant ads running now, best priority first. Show as a carousel; tapping one opens the restaurant.
```json
{ "ads": [ { "id": "…", "type": "restaurant | video", "title": "…", "description": "…",
  "coverImage": "/uploads/…", "logoImage": "/uploads/…", "videoUrl": "",
  "restaurant": { "id": "…", "name": "…", "area": "…", "rating": 4.3, "totalRatings": 42 } } ] }
```
`rating` / `totalRatings` are omitted when the ad hides them.

### `GET /v1/food/public/reels`
Reels showing now: `{ reels: [ { id, description, videoUrl, thumbnail, views, likes, restaurant: { id, name, logo } } ] }`.

### `POST /v1/food/public/reels/:id/view` · `/like` · `/visit`
Count a view (once per play), a like, or a tap through to the restaurant. `{ counted: true }`.

### `GET /v1/food/public/campaigns`
Campaigns running now (switched on, and between their start and end). Two kinds:
```json
{ "basic": [ { "id": "…", "title": "Weekend Feast", "description": "…", "image": "/uploads/…",
               "startsAt": "2026-10-10T04:30:00.000Z", "endsAt": "2026-10-12T18:29:00.000Z",
               "restaurants": [ { "id": "…", "name": "…", "logo": "/uploads/…", "coverImage": "/uploads/…",
                                  "area": "…", "rating": 4.3, "totalRatings": 42, "isAcceptingOrders": true } ] } ],
  "food":  [ { "id": "…", "title": "Hyderabadi biryani", "description": "…", "image": "/uploads/…",
               "price": 299, "discountType": "percent", "discount": 20, "finalPrice": 239.2,
               "foodType": "Non-Veg", "startsAt": "…", "endsAt": "…",
               "restaurant": { "id": "…", "name": "…", "logo": "…", "coverImage": "…", "area": "…",
                               "rating": 4.1, "totalRatings": 12, "isAcceptingOrders": true } } ] }
```
- **basic**: a promotion with a banner; `restaurants` are the approved restaurants taking part (may be
  empty). Tapping a restaurant opens it.
- **food**: one special dish. `discountType` is `percent` or `amount`; `finalPrice` is what the
  customer pays. These dishes are not orderable through checkout yet — tapping one opens its restaurant.

Both lists are empty when nothing is running; hide the section rather than showing placeholders.

### `GET /v1/food/public/cancel-reasons?userType=customer`
The reasons to offer when a customer cancels: `{ reasons: [ { id, reason } ] }`. Send the chosen text as `reason` to `PATCH /v1/food/orders/:orderId/cancel`.

## 14. Restaurant reviews — public, no login

### `GET /v1/food/public/restaurants/:restaurantId/reviews?page=1&limit=20&withComments=true`
Real customer ratings of the restaurant, newest first. `withComments=true` returns only ratings that have a written comment; the summary always covers all ratings.
```json
{ "summary": { "rating": 4.3, "totalRatings": 42, "totalReviews": 16,
               "breakdown": { "5": 30, "4": 4, "3": 4, "2": 0, "1": 4 } },
  "reviews": [ { "id": "…", "userName": "Prathamesh C.", "rating": 5, "comment": "Best service",
                 "ratedAt": "2026-09-08T21:11:08.000Z", "dishName": "Maharaja burger",
                 "dishImage": "/uploads/legacy/product/….png" } ],
  "pagination": { "page": 1, "limit": 20, "total": 16, "pages": 1 } }
```
`userName` is the first name and last initial only. A restaurant with no ratings returns `rating: 0` and empty lists — show "No reviews yet", never sample data.

An order whose dish review an admin has hidden (Food Setup → Review) is left out of both the list and the summary.

## 15. Wallet bonus and loyalty points — `/v1/food/user`

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/food/user/wallet/bonuses` | Top-up bonus offers running now |
| GET | `/v1/food/user/loyalty-points?page=1&limit=20` | Points balance, rules and history |
| POST | `/v1/food/user/loyalty-points/convert` | Convert points into wallet balance |

### `GET /v1/food/user/wallet/bonuses`
Show on the "Add money" screen, e.g. "Add ₹500 or more, get 10% extra (up to ₹50)".
```json
{ "bonuses": [ { "id": "…", "title": "Diwali top-up", "description": "",
  "bonusType": "percentage | amount", "bonusAmount": 10, "minimumAddAmount": 500,
  "maximumBonus": 50, "startDate": "…", "endDate": "…", "state": "running" } ] }
```
`maximumBonus` is 0 when uncapped (always 0 for `amount`). Nothing to send at top-up: when
`POST /wallet/topup/verify` succeeds, the running offer that pays the most is credited as
its own wallet entry ("Top-up bonus: <title>"), and the verify response carries
`bonus: { title, amount }` (or `bonus: null`). A replayed verify credits nothing more.

### `GET /v1/food/user/loyalty-points`
```json
{ "enabled": true, "points": 120, "worth": 12, "totalEarned": 220, "totalConverted": 100,
  "settings": { "pointsPerHundred": 5, "pointsPerRupee": 10, "minimumConvertPoints": 50 },
  "transactions": [ { "id": "…", "type": "credit | debit", "points": 25, "balanceAfter": 120,
                      "source": "order | conversion", "orderId": "…", "walletAmount": 0,
                      "note": "Order FOD-…", "createdAt": "…" } ],
  "pagination": { "page": 1, "limit": 20, "total": 3, "pages": 1 } }
```
Points are earned when an order is **delivered**: `pointsPerHundred` points per ₹100 of the
order total, rounded down. `worth` is what the current points convert into, in rupees.
Hide the section when `enabled` is false.

### `POST /v1/food/user/loyalty-points/convert`
Body: `{ "points": 100, "requestId": "<uuid made once per tap>" }`. Converts at
`pointsPerRupee` points per ₹1 (rounded down to paise) and credits the wallet in the same
step. Returns the `GET /loyalty-points` shape plus `wallet` (as `GET /wallet`). Sending the
same `requestId` again does nothing, so a retry after a timeout is safe. `400` with a
message to show when: points are switched off, fewer than `minimumConvertPoints`, more than
the balance, or not a whole number.

## 16. Newsletter — public, no login

### `POST /v1/food/public/newsletter/subscribe`
Body: `{ "email": "asha@example.com" }` → `{ "subscribed": true }`. The email is stored
lower-cased; subscribing an address that is already on the list answers the same way and
adds nothing. `400` "Enter a valid email address" for anything that is not an email.

## 17. Business settings — public, no login

What the admin set under Business Settings that changes what the app shows.
Read it at start-up (it is also inside `GET /v1/food/public/app-settings` as
`business`); it may change at any time, and the server enforces every switch
below whatever the app shows.

### `GET /v1/food/public/business-settings`

```jsonc
{
  "maintenance": { "maintenanceMode": false, "maintenanceMessage": "" },
  "currency": { "code": "INR", "decimals": 0 },          // decimals to show prices with
  "payment": { "cod": true, "digital": true, "offline": false, "wallet": true, "partialPayment": true },
  "order": {
    "homeDelivery": true, "takeaway": false,               // takeaway: no takeaway flow yet; keep hidden
    "scheduledOrder": false, "scheduleSlotMinutes": 30,    // slot length for the time picker
    "freeDeliveryOver": null                               // or 499: item total from which delivery is free
  },
  "customer": {
    "wallet": true, "addFund": false,                      // addFund: show "Add money" in the wallet
    "vegNonVegToggle": true, "guestCheckout": false,       // guest checkout is not supported by the API yet
    "newCustomerDiscount": null                            // or { type: "amount"|"percent", value, maxDiscount, minOrderAmount, validityDays }
  },
  "rider": { "maxAssignedOrders": 2, "canCancelOrder": false, "showEarning": true, "pictureUpload": true, "selfRegistration": true },
  "restaurant": { "canCancelOrder": false, "canReplyToReviews": false, "dishApprovalRequired": true, "selfRegistration": true },
  "refund": { "requestEnabled": true }
}
```

- **Maintenance.** While `maintenanceMode` is on, `POST /v1/food/orders` returns 400 with
  `maintenanceMessage` (or a default text). Show the message and disable checkout.
- **Scheduled orders.** With `scheduledOrder` off, a `scheduledAt` more than 5 minutes ahead is
  refused ("Scheduled orders are not available. Please order for now.").
- **Free delivery over.** When the item total reaches `freeDeliveryOver`, the quote
  (`POST /orders/calculate`) comes back with `deliveryFee: 0`, `deliveryFeeGst: 0` and
  `pricing.freeDeliveryWaived` = the fee + GST waived (`originalDeliveryFee` keeps the fee).
  It never stacks with a free-delivery coupon (that one is `deliveryFeeWaived`). Orders carry
  `pricing.freeDeliveryWaived` too.
- **New customer discount.** On a customer's first order (no earlier placed order; account younger
  than `validityDays`, 0 = any age; item total at least `minOrderAmount`) the quote includes it in
  `pricing.discount` and shows it alone as `pricing.newCustomerDiscount`. It does not stack with
  a coupon discount: when a coupon gives a discount, the new-customer discount is 0. Send the quote's
  `pricing` back with the order as usual.
- **Add fund.** With `addFund` false, `POST /v1/food/user/wallet/topup/order` returns 400
  ("Adding money to the wallet is not available right now."). Verifying a payment already made
  still credits it.

### `GET /v1/food/public/refund-reasons`

`{ "reasons": [{ "id": "a1b2c3d4e5f6", "text": "Food was cold" }] }` — the active reasons a customer
can pick when asking for a refund. The ids are stable across admin edits. (A customer
refund-request endpoint does not exist yet; `refund.requestEnabled` says whether to show the option
once it does.)

### `GET /v1/food/public/order-issue-reasons`

`{ "reasons": [{ "id": "...", "text": "Item missing" }] }` — the predefined messages a customer can
pick when reporting a problem with an order (Business Settings → Automated message). Replaces the
hard-coded list in the app.

### List order (Priority setup)

When the app sends no `sortBy`, these lists use the order the admin chose (Business Settings →
Priority setup), else their usual default:

| Section | Endpoint | Applied |
|---|---|---|
| All restaurants | `GET /v1/food/restaurant/restaurants` | yes (`rating`, `nearest`, `newest`, `deliveryTime`) |
| Recommended | `GET /v1/food/restaurant/restaurants?recommended=true` | yes (same sorts) |
| Category item lists | `GET /v1/food/restaurant/public/foods?categoryId=…` | yes (`newest`, `price_low`, `price_high`) |
| Search | `GET /v1/food/search/unified` | yes (`rating`, `newest`, `nearest` with coordinates) |
| Best nearby, special offers, popular items, best reviewed, new on Lagech | — | saved only: these rails are filters on the lists above |

An explicit `sortBy` from the app always wins. The lists are cached for a few minutes, so a change
can take that long to show.

