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

### Home banners (`/hero-banners/public`) — zone, type and target

`GET /v1/food/hero-banners/public?lat=..&lng=..` (or `?zoneId=..`, like the restaurant list) returns
the banners for **every zone plus the customer's zone**; with neither, every active banner (as
before). A point outside every zone returns `{ "banners": [], "outOfService": true }`.
`&featured=true` returns only banners the admin marked Featured.

Every field the app already reads is unchanged (`imageUrl`, `title`, `ctaText`, `ctaLink`,
`linkedRestaurants`, `sortOrder`, ...). Added per banner:

```jsonc
{
  "bannerType": "restaurant",            // restaurant | food | link — what a tap opens
  "linkedRestaurantIds": ["<restaurantId>"], // bannerType restaurant (linkedRestaurants has the cards)
  "linkedFoodId": null,                   // bannerType food: the dish id
  "linkedFood": null,                     // { id, name, image, price, foodType, restaurantId } for food banners
  "zoneId": null,                         // null = shown in every zone
  "isFeatured": false
}
```
Tap: `restaurant` → open `linkedRestaurantIds[0]`; `food` → open the dish (`linkedFood.restaurantId` +
`linkedFoodId`); `link` → open `ctaLink` if set, otherwise do nothing. A food banner whose dish was
deleted or unapproved has `linkedFood: null` — treat it as a plain image.

### Zones: payment switches and default zone

`/zones/detect` (`data.zone`) and `/zones/public` / `/zones/nearby` (each zone) now also carry
`cashOnDelivery`, `digitalPayment` and `isDefault`; `/zones/public` adds `data.defaultZoneId`.

```jsonc
GET /v1/food/zones/payment-options?restaurantId=<id>   // or ?zoneId=..  or ?lat=..&lng=..   — Public
// -> data: { "zoneId": "...", "cashOnDelivery": true, "digitalPayment": false, "wallet": true }
```
An order's zone is the `zoneId` sent with it, else the restaurant's zone, else the **default zone**;
so pass `restaurantId` at checkout to get exactly what order placement will accept.
`POST /v1/food/orders/calculate` also returns the same object as `data.paymentOptions`.

### Recommended restaurants
Every restaurant in `GET /v1/food/restaurant/restaurants` carries `isRecommended` (boolean) and
`recommendedSortOrder` (number). The admin picks and orders the recommended ones
(Restaurant Management → Recommended Restaurants).

`GET /v1/food/restaurant/restaurants?recommended=true` returns only those, in the admin's order
(lowest `recommendedSortOrder` first) unless a `sortBy` is given. It combines with every other filter
(`lat`/`lng`, `zoneId`, `search`, …), so the row shows only recommended restaurants that serve the
customer. An empty list means none are picked for that area — hide the row.

### Featured restaurants
Restaurants the admin marked featured carry `isFeatured: true`. `GET /v1/food/restaurant/restaurants?featured=true`
returns only those, and combines with every other filter (`lat`/`lng`, `zoneId`, …) like `recommended=true`.
The customer app shows them as a "Featured restaurants" row on home, scoped to the customer's zone; an
empty list hides the row.

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

### Delivery or takeaway, scheduled time and rider tip

Three Business Settings options. Each is offered only when the admin has it on; switched off, an
order is exactly a home delivery for now with no tip, as before.

**What to offer for one restaurant** (public, no login):

```jsonc
GET /v1/food/public/restaurants/:restaurantId/order-options
{
  "restaurantId": "…",
  "orderTypes": { "delivery": true, "takeaway": true },     // takeaway: setting on AND the restaurant offers it
  "schedule": {
    "enabled": true, "slotMinutes": 30, "minLeadMinutes": 45, "releaseMinutesBefore": 40,
    "days": [
      { "date": "2026-10-06", "label": "Today", "dayName": "Tue, 6 Oct",
        "slots": [ { "scheduledAt": "2026-10-06T07:30:00.000Z", "endsAt": "2026-10-06T08:00:00.000Z", "label": "1:00 pm - 1:30 pm" } ] },
      { "date": "2026-10-07", "label": "Tomorrow", "dayName": "Wed, 7 Oct", "slots": [ … ] }
    ]
  },                                                          // { "enabled": false, "days": [] } when off
  "tips": { "enabled": true, "presets": [10, 20, 30, 50], "max": 500 }   // { enabled: false, presets: [], max: 0 } when off
}
```

Slots run today and tomorrow (restaurant timezone), on the admin's interval, from at least
`minLeadMinutes` ahead, and only wholly inside the restaurant's opening hours. `GET
/v1/food/public/business-settings` also carries `order.takeaway`, `order.scheduledOrder`,
`order.scheduleSlotMinutes` and `tips` for the global switches.

**Sending them** — the same three optional fields on `POST /orders/calculate` and `POST /orders`:

| Field | Values | Notes |
|---|---|---|
| `orderType` | `"delivery"` (default) \| `"takeaway"` | Takeaway: refused unless on (400 "Takeaway is not available right now." / "… does not offer takeaway."). With home delivery off, `"delivery"` is refused. |
| `scheduledAt` | ISO time of a slot | Refused when scheduling is off (more than 5 min ahead), sooner than the lead time, past tomorrow, or when the restaurant is closed then. |
| `riderTip` | rupees, 0–500 | Refused when tips are off, on a takeaway, or above ₹500. |
| `extraPackaging` | `true` / `false` | Ask for the restaurant's extra packaging (see below). Ignored when not offered. |

**Home delivery off.** With `order.homeDelivery: false` only takeaway is offered: `"delivery"` (or no
`orderType`) → 400 "Home delivery is not available right now. Please choose takeaway."

### Extra packaging and additional charge (new bill lines)

Two Business Settings charges, both off by default (then nothing below changes a bill):

- **Extra packaging** — a restaurant's own packaging charge. `GET
  /v1/food/public/restaurants/:restaurantId/order-options` → `extraPackaging: null` or `{ amount,
  required }`. `required: true`: always charged, show it as a fixed line. Otherwise show an "Extra
  packaging (₹amount)" checkbox and send `extraPackaging: true` on `/orders/calculate` and `POST
  /orders` when ticked. The quote's `pricing.packagingFee` is what is charged (0 when not), and
  `pricing.extraPackaging` repeats `{ amount, required, applied }` (or null). Paid to the restaurant;
  no coupon or GST on it.
- **Additional charge** — a flat charge on every order with a name the admin sets (e.g. "Service
  charge"). `order-options` → `additionalCharge: null` or `{ name, amount }`; `GET
  /v1/food/public/business-settings` → `order.additionalCharge` the same.
  The quote and every order carry `pricing.additionalCharge` and `pricing.additionalChargeName`.
  **It is included in `pricing.platformFee`** (as the Quick Mode surcharge `pricing.quickDeliveryFee`
  already is), and in `total`. To show it as its own line: "<additionalChargeName>" =
  `additionalCharge`, and "Platform fee" = `platformFee − quickDeliveryFee − additionalCharge`
  (hide when 0).

The apps have no generic list of bill lines: each line is its own `pricing` field. **Flutter:** add the
packaging line (`packagingFee`, label "Extra packaging"), the additional charge line (labelled with
`additionalChargeName`), the opt-in checkbox, and subtract `additionalCharge` from the platform fee
line as above.

**Takeaway.** No delivery fee or its GST (`pricing.deliveryFee: 0`), no Quick Mode, no rider. Paid
in the app only: `razorpay` / `card`, `wallet` or `offline` (cash and `razorpay_qr` → 400 "Takeaway
orders are paid in the app…"). `address` may be left out (the restaurant's address is recorded).
The order carries `orderType: "takeaway"` and a 4-digit **`pickupCode`**: returned by `POST /orders`,
on `GET /orders` items and on `GET /orders/:id` until it is handed over. Show it on the order screen;
the restaurant asks for it at the counter. Status goes `created → confirmed → preparing →
ready_for_pickup` (push "Your takeaway order is ready…") `→ delivered` when the restaurant enters the
code. Cancellation and refunds work as for any order.

**Scheduled.** The order is placed and paid now (online payment as usual). It comes back with
`isScheduled: true`, `scheduledAt` and `releaseAt` (when the restaurant is alerted and a rider is
looked for — `releaseMinutesBefore` ahead of the slot). Until then it stays `created` (or
`confirmed` if the restaurant accepts early); show "Scheduled for <time>".

**Tip.** The quote returns `pricing.riderTip` and includes it in `pricing.total`; it is never
discounted by a coupon. Orders carry `pricing.riderTip` (and `riderTip`). All of it goes to the rider.

### Food campaign dishes
A food campaign dish (`GET /v1/food/public/campaigns` → `food[]`) is not a menu item. Put it in the cart
as a line whose `campaignId` (and `itemId`) is the campaign's `id`, from the campaign's restaurant:
```json
{ "itemId": "<campaign id>", "campaignId": "<campaign id>", "name": "Hyderabadi biryani", "price": 239.2, "quantity": 2 }
```
`/calculate` and `POST /orders` price it from the campaign row; the `price` sent is only compared, like any
line (a different one comes back in `priceChanges` with the campaign price). The campaign must belong to the
restaurant being ordered from and be running at the time the order is for (now, or `scheduledAt`), else
`"<title> is no longer available from this restaurant"` / `"The <title> campaign is not running any more"`.
No variants or add-ons.

In the result, the line's `price` is the campaign's full price, `campaignPrice` what the customer pays per
unit, and `itemCampaignId` the campaign. `pricing.campaignDiscount` is the total the campaigns take off; it
is **part of** `pricing.discount` (show it as its own "Campaign discount" row and the rest as the coupon's).
Coupons, "free delivery over" and the new-customer discount are worked out on the item total after it.
Placed orders keep it in `pricing.campaignDiscount`.

The platform funds the campaign discount: the restaurant is settled (and charged commission) on the full price.

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

Partial payment (part wallet, rest online or cash): see *Partial payment* below.

**Per-zone switches (Zone setup).** Each zone can switch off Cash On Delivery (`cash`) and/or
Digital Payment (`razorpay`, `card`, `razorpay_qr`). Placing an order with a switched-off method
returns 400, e.g. `"Cash on Delivery is not available in Phaltan. Please choose another payment
method."` / `"Online payment is not available in Phaltan. ..."`. `wallet` and `offline` are not
zone-governed. Hide the methods using `paymentOptions` (see §2 Zones) rather than waiting for the 400.

**`razorpay_qr` is the pay-at-the-door replacement.** Same UX as COD: nothing is
charged upfront, the order dispatches immediately, `payment.status` stays
`pending_qr`, and the rider presents a QR on arrival. No `verify-payment` call.
If the QR fails the rider can switch the order to cash from their side.

For `razorpay` / `card`, call `verify-payment` after checkout:

```jsonc
POST /v1/food/orders/verify-payment
{ "orderId": "...", "razorpayOrderId": "...", "razorpayPaymentId": "...", "razorpaySignature": "..." }
```

### Partial payment (wallet + online or cash)

When `business.payment.partialPayment` is true and the customer's wallet
balance (`GET /v1/food/user/wallet` → `balance`) is above 0 but **below** the
order total, offer "Use wallet balance (₹X)". (A balance that covers the whole
total is the ordinary `paymentMethod: "wallet"`.) With the toggle on, the
customer picks the method for the rest:

- `business.payment.partialPaymentMethod`: `"both"` (cash or online), `"cod"`
  (cash only) or `"digital"` (online only), and only methods that are also on
  (`cod` / `digital`, and the zone's `paymentOptions`).
- `paymentMethod` is the method for the rest: `"razorpay"` (or `"card"`) or
  `"cash"`. Not `razorpay_qr`, `offline` or `wallet`.

```jsonc
POST /v1/food/orders
{
  ...,
  "paymentMethod": "razorpay",      // or "cash"
  "useWallet": true,
  "walletAmount": 120               // optional: the wallet part you showed = min(balance, total)
}
```

The server takes the wallet part from the wallet **in the same database
transaction that creates the order** and stores it on the order:

- the order's `walletAmount` and `payment.walletAmount` = the wallet part,
  `payment.isPartial: true`, `payment.method` = the method for the rest,
  `payment.amountDue` = total − wallet part (what is charged online or collected
  in cash). `pricing.total` is the full order total as before.
- `razorpay`: the response's `razorpay.amount` is the rest only (paise). Verify
  as usual. If the payment is abandoned (`DELETE /orders/:id/pending-payment`),
  fails or is never completed (unpaid orders are removed after 30 minutes), the
  wallet part goes back to the wallet automatically.
- `cash`: the order is placed at once; the rider collects only `amountDue`.
- Cancelled or refunded: the wallet part goes back to the wallet; a paid online
  part is refunded to the original payment method. A cancelled wallet + cash
  order shows `payment.refund.status: "processed"` with the wallet part as the
  amount, and `payment.status` stays `cod_pending` (no cash was taken).

Refusals (400, nothing is written and the wallet is untouched):
"Paying part of an order with the wallet is not available right now. ..." (switched off),
"Your wallet balance is empty. ...",
"Your wallet balance has changed (₹50 now). Please review the payment and try again."
(the balance is now below the `walletAmount` you sent, or another order spent it at the same moment),
"Your wallet covers the whole order. Choose Wallet as the payment method.",
"The rest of a wallet payment can only be paid with cash on delivery." / "... only be paid online.",
"The amount left to pay online is below ₹1. ...".

Show the split on the bill (Wallet −₹X, To pay online / in cash ₹Y) and in order
details from `payment.walletAmount` and `payment.amountDue`.

### Guest checkout

Not supported: every order needs a signed-in customer (phone OTP).
`business.customer.guestCheckout` is stored for the admin panel only; keep the
login step before checkout whatever it says.

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

Admin push notifications (Push Notification page) arrive with `data.type: "admin_broadcast"`,
`broadcastId`, `link`, `couponCode` and, when the admin attached one, `data.image` (absolute URL;
also set as the FCM notification image). The matching inbox row carries the same image at
`metadata.image`. The admin can **Resend** one: the same inbox row comes back unread (no duplicate,
same `broadcastId`), so dedupe local notifications by `broadcastId`. Switching one off removes it
from the inbox list.

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
  customer pays. The dish is orderable: add it to the cart as a line with `campaignId` (see
  "Food campaign dishes" under Orders).

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

Each review carries `reply`: the restaurant's reply, `{ "text": "Sorry about the wait!", "repliedAt": "…" }`,
or `null`. Show it under the review. The customer's own order (`GET /v1/food/orders/:orderId`) has it too,
in `ratings.restaurantReply` (same shape, or `null`).

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
                      "source": "order | conversion | refund", "orderId": "…", "walletAmount": 0,
                      "note": "Order FOD-…", "createdAt": "…" } ],
  "pagination": { "page": 1, "limit": 20, "total": 3, "pages": 1 } }
```
Points are earned when an order is **delivered**: `pointsPerHundred` points per ₹100 of the
order total, rounded down. When that order is refunded, its points are taken back once (a
`debit` with `source: "refund"`); points already converted stay converted, so the balance
never goes below 0. `worth` is what the current points convert into, in rupees.
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
  "payment": { "cod": true, "digital": true, "offline": false, "wallet": true, "partialPayment": true, "partialPaymentMethod": "both" },
  "order": {
    "homeDelivery": true, "takeaway": false,               // takeaway on: offer Delivery / Takeaway (see §5)
    "scheduledOrder": false, "scheduleSlotMinutes": 30,    // slot length; slots come from /restaurants/:id/order-options
    "freeDeliveryOver": null,                              // or 499: item total from which delivery is free
    "extraPackagingCharge": false,                         // restaurants may charge extra packaging (order-options says how much)
    "confirmedBy": "restaurant",                           // or "deliveryman": delivery orders are confirmed at once
    "additionalCharge": null                               // or { "name": "Service charge", "amount": 10 } on every order
  },
  "business": { "commissionModel": true, "subscriptionModel": true },   // restaurant app: hide plans when subscriptionModel is false
  "customer": {
    "wallet": true, "addFund": false,                      // addFund: show "Add money" in the wallet
    "vegNonVegToggle": true, "guestCheckout": false,       // stored only: every order needs a phone-OTP login (see §5 Guest checkout)
    "newCustomerDiscount": null                            // or { type: "amount"|"percent", value, maxDiscount, minOrderAmount, validityDays }
  },
  "rider": { "maxAssignedOrders": 2, "canCancelOrder": false, "showEarning": true, "pictureUpload": true, "selfRegistration": true, "tipsEnabled": false },
  "tips": { "enabled": false, "presets": [], "max": 0 },   // on: { enabled: true, presets: [10, 20, 30, 50], max: 500 }
  "restaurant": { "canCancelOrder": false, "canReplyToReviews": false, "dishApprovalRequired": true, "selfRegistration": true },
  "refund": { "requestEnabled": true, "requestWindowHours": 24 }   // 0 = no time limit; see section 18
}
```

- **Who confirms.** With `order.confirmedBy: "deliveryman"` a delivery order goes from placed (or
  paid) straight to `confirmed` — show "Confirmed" rather than "Waiting for the restaurant"; it is
  never cancelled for the restaurant not accepting. Takeaway orders still wait for the restaurant.
- **Self registration.** `restaurant.selfRegistration` / `rider.selfRegistration` false: the public
  restaurant and rider sign-ups return 403 with a message; the website and apps hide those buttons.
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
can pick when asking for a refund. The ids are stable across admin edits. Send the `id` as
`reasonId` to `POST /v1/food/user/orders/:orderId/refund-request` (section 18).

### `GET /v1/food/public/order-issue-reasons`

`{ "reasons": [{ "id": "...", "text": "Item missing" }] }` — the predefined messages a customer can
pick when reporting a problem with an order (Business Settings → Automated message). Replaces the
hard-coded list in the app. Send the `id` as `reasonId` to `POST /v1/food/user/orders/:orderId/issues`
(section 18).

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

## 18. Refund requests and order issue reports — `/v1/food/user` (Bearer USER)

`:orderId` is the order's id or its display id (`FOD-…`); only the signed-in customer's own
orders are found (`404` "Order not found" otherwise). Photos are optional: send the request as
`multipart/form-data` with up to 3 image files in the field `images` (and the other fields as
form fields), or as plain JSON without photos. Every `400` carries a `message` to show as is.

### `GET /v1/food/user/orders/:orderId/refund-request`

Whether the customer may ask for a refund on this order now, and the requests already made.
Call it on the order details screen and show **Request refund** only when `eligible` is true;
otherwise show `message` (and the latest request's status, if there is one).

```jsonc
{
  "eligible": false,
  "message": "A refund request for this order is already being reviewed",
  "maxAmount": 0,                    // what can still be refunded (₹) when eligible
  "windowEndsAt": "2026-10-07T…",    // last moment to ask, or null (no limit / not delivered)
  "refundTo": "wallet",              // "razorpay" (original payment method) or "wallet"
  "request": { /* the latest request, or null — shape below */ },
  "requests": [ /* every request on this order, newest first */ ]
}
```

Rules (the server enforces them; `POST` answers `400` with the same `message`):

- Business Settings → Refund → *Refund request* is on (`refund.requestEnabled`).
- The order is **delivered** and **paid** (`paymentStatus: "paid"`: online payments, wallet,
  verified offline payments, and cash-on-delivery once the cash was collected).
- Within `refund.requestWindowHours` (default 24) of delivery; `0` means no limit.
- One open request per order: while one is `pending`, another is refused. After a rejection
  the customer may ask again (still within the window). Once refunded, never again.

### `POST /v1/food/user/orders/:orderId/refund-request`

Fields: `reasonId` (an id from `GET /v1/food/public/refund-reasons`) **or** `reason` (free text,
≤ 200 chars, for "Other"), `note` (optional, ≤ 1000 chars), `images` (optional files, ≤ 3).
`201` → `{ "request": RefundRequest }`.

```jsonc
// RefundRequest
{
  "id": "…", "orderId": "<order row id>", "orderDisplayId": "FOD-…",
  "status": "pending",               // pending | approved (being processed) | refunded | rejected
  "reasonId": "a1b2c3d4e5f6", "reason": "Food was cold", "note": "…",
  "images": ["https://…/food/refund-requests/….jpg"],
  "requestedAmount": 540,            // what was refundable when asked
  "refundedAmount": null,            // set when refunded (may be less: partial refund)
  "refundMethod": "",                // when refunded: "razorpay" or "wallet"
  "adminNote": "",                   // the admin's note; always set on a rejection
  "createdAt": "…", "decidedAt": null, "updatedAt": "…"
}
```

Where the money goes when the admin approves (all or part of it):

| Order paid by | Refunded to |
|---|---|
| Razorpay (card, UPI, …) | the original payment method (5–7 working days) |
| Wallet | the wallet |
| Cash on delivery | the wallet |
| Offline payment verified by the admin, Razorpay QR | the wallet |

Wallet refunds show in `GET /v1/food/user/refunds` and the wallet history like any order refund.
Loyalty points the order earned are taken back (section 15).

The customer gets a push (also in the notification inbox): `data.type = "refund_processed"`
when refunded, `"refund_request_rejected"` when rejected, each with `orderId` (display id),
`orderRowId` and `refundRequestId`.

### `GET /v1/food/user/refund-requests?page=1&limit=20&status=`

The customer's requests across all orders, newest first. `status` optional
(`pending|approved|refunded|rejected`). → `{ "requests": [RefundRequest], "pagination": { "page", "limit", "total", "pages" } }`.

### `POST /v1/food/user/orders/:orderId/issues`

"Report an issue" on an order, at any point after it was placed (not while it is still waiting
for its online payment). Fields: `reasonId` (an id from `GET /v1/food/public/order-issue-reasons`;
required while the admin has any reasons set up — with none, send `reason` as free text), `note`
(optional, ≤ 1000 chars), `images` (optional files, ≤ 3). One open report per order: until the
admin resolves it, another is refused ("You have already reported an issue on this order; …").
`201` → `{ "issue": OrderIssue }`.

```jsonc
// OrderIssue
{
  "id": "…", "orderId": "<order row id>", "orderDisplayId": "FOD-…",
  "reasonId": "…", "reason": "Item missing", "note": "…", "images": ["https://…"],
  "status": "open",                  // open | in-progress | resolved
  "adminResponse": "",               // the admin's reply, when there is one
  "createdAt": "…", "updatedAt": "…"
}
```

A report is a support ticket of type `order`: it also appears in `GET /v1/food/user/support/my-tickets`.
When the admin replies, the customer gets a push (and an inbox entry) with
`data.type = "SUPPORT_RESPONSE"`, `ticketId` and `orderId` (order row id).

### `GET /v1/food/user/orders/:orderId/issues` · `GET /v1/food/user/order-issues?page=1&limit=20`

One order's reports, or all of the customer's order reports, newest first →
`{ "issues": [OrderIssue], "pagination": { "page", "limit", "total", "pages" } }`.

