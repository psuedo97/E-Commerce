# KOMA

Online store for a single seller in India, connected to an existing physical shop: one shared inventory,
prepaid orders, GST-aware pricing. Built as a modular monolith so it can grow (multi-vendor, separate
services) without a rewrite.

- Design: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Roadmap and status: [docs/PLAN.md](docs/PLAN.md)

## Status

| Phase | Area | State |
|---|---|---|
| 0 | Setup (monorepo, Docker, schema) | Done |
| 1 | Accounts: register, login, roles, addresses | Done |
| 2 | Catalog: categories, products, variants, images, search | Done |
| 3 | Inventory: locations, stock changes, history, reservations | Done |
| 4 | Cart and checkout: guest and account carts, GST pricing, stock holds, store pickup | Done |
| 5 | Payments: Razorpay, webhooks, refunds, confirmation email | Done (see "Payments" below) |
| 6 to 10 | Admin panel, shipping, POS, polish, launch | Planned |

Customers can browse, fill a cart, check out, pay and cancel an unpaid order. Until you add Razorpay keys the
shop runs in a built-in **test mode** that moves no money (see "Payments").

## Tech stack

| Layer | Choice |
|---|---|
| Storefront | Next.js 15, React 19, TypeScript |
| API | NestJS 11, REST under `/api/v1` |
| Database | PostgreSQL 16 with Prisma 6 |
| Cache and queues | Redis 7 (reserved for later phases) |
| Payments | Razorpay (UPI, cards, net banking), prepaid only |
| Email | Resend (optional; logs to the console without it) |
| Tests | Jest and Supertest (API), Vitest (storefront units), Playwright (real-browser journeys) |

## Prerequisites

- Node.js 22 or newer
- pnpm 10 (`npm i -g pnpm`)
- Docker Desktop (running) for Postgres and Redis

## Getting started

```bash
pnpm install

# 1. Environment files
cp .env.example apps/api/.env          # then edit the secrets
# apps/web/.env.local needs API_URL and NEXT_PUBLIC_API_ORIGIN (see the bottom of .env.example)

# 2. Database
pnpm db:up                             # Postgres on :5433, Redis on :6379
pnpm db:migrate                        # create the tables
pnpm --filter api db:seed              # optional: sample categories, products, one shop with stock

# 3. Run (two terminals)
pnpm dev:api                           # http://localhost:4000/api/v1/health
pnpm dev:web                           # http://localhost:3000
```

The storefront reads everything from the API, so start the API first. If the web app shows
"Cannot reach the API", it is not running.

### Ports

| Service | Port |
|---|---|
| Storefront | 3000 |
| API | 4000 |
| Postgres | 5433 (not 5432, to avoid clashing with a local install) |
| Redis | 6379 |

## Accounts and roles

Everyone registers as a customer. Promote an account after it exists:

```bash
pnpm --filter api make-admin you@example.com           # ADMIN
pnpm --filter api make-admin clerk@example.com STAFF   # store staff: can manage stock
```

The person must log in again to get a token with the new role.

| Role | Can do |
|---|---|
| CUSTOMER | Browse, manage own profile and addresses |
| STAFF | Everything a customer can, plus stock operations |
| ADMIN | Everything, including catalog management and locations |

## Common commands

| Command | What it does |
|---|---|
| `pnpm dev:api` / `pnpm dev:web` | Start the API / storefront in watch mode |
| `pnpm db:up` / `pnpm db:down` | Start / stop Postgres and Redis |
| `pnpm db:migrate` | Create and apply a migration after editing `schema.prisma` |
| `pnpm db:studio` | Browse the database in the browser |
| `pnpm test` | All tests (needs Docker running) |
| `pnpm --filter api test` | Fast unit tests only, no database |
| `pnpm --filter api test:e2e` | API tests against the `koma_test` database |
| `pnpm --filter web test` | Storefront unit tests |
| `pnpm test:browser` | Real-browser tests of browsing, cart, login, checkout and payment (see below) |
| `pnpm build` | Production build of both apps |

## Testing

API end-to-end tests run the real app against a separate `koma_test` database, which is created and
migrated automatically. Your development data is never touched, and the suite refuses to run against a
database whose name does not contain "test". Set `TEST_DATABASE_URL` to use a different one.

### Browser tests

`pnpm test:browser` drives a real headless Chromium through the shop: add to cart as a guest, register at
checkout (the cart is kept), add an address, place and cancel an order, store pickup, GST split by state,
login surviving a reload, and more. First time only: `pnpm --filter web exec playwright install chromium`.

It starts its own API (port 4100) and storefront (port 3100) against a separate `koma_e2e` database, so your
dev servers and data are untouched. Needs Docker running; takes about a minute.

## Project layout

```
apps/
  api/                 NestJS backend
    prisma/            schema.prisma, migrations, seed script
    src/
      auth/            register, login, refresh, guards, roles
      users/           profile and addresses
      catalog/         categories, products, variants, images
      inventory/       locations, stock changes, reservations
      cart/            guest and account carts
      orders/          checkout, GST pricing, orders, expiry of unpaid orders
      payments/        Razorpay (and test-mode) gateway, payments, webhooks, refunds
      mail/            email sending and templates
      shipping/        delivery pincode check
      storage/         image storage (local disk for now)
    test/              end-to-end tests and helpers
    scripts/           make-admin
  web/                 Next.js storefront
    app/               pages: catalog, cart, checkout, login, orders
    components/        shared UI
    lib/               API client (login, cart), formatting, helpers
    e2e/               Playwright browser tests
docs/                  architecture and plan
docker-compose.yml     Postgres and Redis for local development
```

## API overview

All routes are under `/api/v1`. Admin routes require a Bearer access token with the right role.

| Area | Routes |
|---|---|
| Auth | `POST /auth/register`, `/auth/login`, `/auth/refresh`, `/auth/logout` |
| Profile | `GET`/`PATCH /users/me`, `GET`/`POST /users/me/addresses`, `PATCH`/`DELETE /users/me/addresses/:id` |
| Catalog | `GET /categories`, `GET /products` (search, category, price, sort, page), `GET /products/:slug` |
| Catalog admin | `/admin/categories`, `/admin/products`, `/admin/variants`, `/admin/images` |
| Inventory admin | `/admin/locations`, `GET /admin/inventory`, `/admin/inventory/barcode/:code`, `/admin/inventory/movements`, `POST /admin/inventory/receive`, `adjust`, `count`, `transfer` |
| Stores | `GET /stores` (public: shops available for pickup) |
| Shipping | `GET /shipping/serviceability?pincode=` (public) |
| Cart | `GET /cart`, `POST /cart/items`, `PATCH`/`DELETE /cart/items/:variantId`, `DELETE /cart`, `POST /cart/merge` |
| Checkout and orders | `POST /checkout/quote`, `POST /checkout`, `GET /orders`, `GET /orders/:id`, `POST /orders/:id/cancel` (login required) |
| Payments | `POST /orders/:id/pay`, `POST /payments/verify` (login required), `POST /webhooks/razorpay` (Razorpay only, signed) |
| Refunds | `POST /admin/orders/:id/refund` (admin) |
| Test mode | `POST /payments/simulate` (only exists while no Razorpay keys are set) |

Prices are integers in paise (₹1 = 100 paise) and include GST.

**Carts.** A logged-in customer has one cart tied to the account. A guest's cart is created on the first add
and its id is returned as `id`; send it back in the `X-Cart-Id` header. After login, `POST /cart/merge` moves the
guest items into the account cart.

**Checkout.** Prices always come from the database, never from the request. The order is created, stock is
held for 30 minutes and the cart is emptied in one transaction, so double-clicks and simultaneous buyers cannot
oversell. GST is split into CGST + SGST for deliveries inside `SELLER_STATE` (and for store pickup), otherwise
IGST. Delivery is a flat fee, free above a threshold and free for pickup. Cash on delivery is rejected.

## Payments

**How a payment works.** On the order page the customer clicks Pay. The API creates a Razorpay order for the exact
order total and the browser opens Razorpay's payment window. When it succeeds, the browser sends Razorpay's signed
proof to `POST /payments/verify`, and Razorpay also calls our webhook. Both paths run the same idempotent code:
the order becomes **Paid**, the held stock becomes a real sale, and a confirmation email is sent. The webhook is the
source of truth, so an order is still confirmed if the customer closes the tab right after paying.

**Edge cases handled.** Repeated or simultaneous confirmations (no double sale or email). Failed attempts (the order
stays unpaid and can be retried on the same Razorpay order). A payment that arrives after the order was cancelled or
expired: honoured if the stock is still there, otherwise refunded automatically. A duplicate payment for an
already-paid order is refunded. A wrong amount never confirms an order. While a customer is paying, the stock hold
is stretched to about 20 minutes (never beyond 2 hours from the order).

**Refunds.** Admins refund through `POST /admin/orders/:id/refund` (full or partial, optionally restocking the items
on a full refund). Refunds the provider cannot accept straight away stay pending and are retried every 5 minutes;
after 8 failed attempts they are marked FAILED for a person to handle. Refunds made from the Razorpay dashboard are
picked up from the `refund.processed` webhook.

### Test mode (default in development)

With no `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET`, a built-in gateway is used and the Pay button shows "Simulate
successful / failed payment" instead of Razorpay's window. No money moves. **It is switched off in production**: with
`NODE_ENV=production` and no keys, payments are refused rather than faked.

### Going live with Razorpay

1. Create a Razorpay account and generate **test** keys (Dashboard, Account & Settings, API Keys).
2. Put `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` in `apps/api/.env`.
3. Add a webhook (Dashboard, Account & Settings, Webhooks) pointing at `https://<your-api-host>/api/v1/webhooks/razorpay`
   with events **payment.captured**, **payment.failed** and **refund.processed**. Choose a secret and put it in
   `RAZORPAY_WEBHOOK_SECRET`. Webhooks without it are rejected.
4. Razorpay must be able to reach your API, so for local testing expose it with a tunnel (for example ngrok).
5. Make a test payment end to end, then switch to live keys once Razorpay has activated your account.

For order emails set `RESEND_API_KEY` and `MAIL_FROM` (an address on a domain verified in Resend). Without them,
emails are printed in the API log.

## Configuration

See [.env.example](.env.example). The values that matter:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | Token signing. Use long random values in production. |
| `WEB_ORIGIN` | Storefront origin allowed by CORS |
| `SELLER_STATE`, `SELLER_GSTIN` | Decides CGST+SGST versus IGST on invoices |
| `COD_ENABLED` | Reserved. Checkout currently rejects cash on delivery whatever this is set to. |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | Payments. Leave empty in development for test mode. |
| `RESEND_API_KEY`, `MAIL_FROM` | Order and refund emails (otherwise logged, not sent) |
| `SHIPPING_FLAT_PAISE`, `FREE_SHIPPING_ABOVE_PAISE` | Delivery fee and free-delivery threshold (₹50 and ₹999 by default) |
| `ORDER_HOLD_MINUTES` | How long an unpaid order keeps its stock (default 30) |
| `UNSERVICEABLE_PINCODES` | Comma-separated pincodes we do not deliver to |

## Known limitations

- **The Razorpay integration has not been run against Razorpay itself.** It is tested against a fake provider that
  signs and verifies exactly as Razorpay documents (plus unit tests of the request format), but no real keys were
  available while building it. Do a test-key payment, a refund and a webhook delivery before taking real money.
- Emails are sent straight after a payment is confirmed, not from a durable queue: if sending fails it is logged and
  not retried. Refunds, which matter more, are retried.
- A refund sent to Razorpay whose confirmation is lost before we record it could be sent twice by a retry (the
  `refund.processed` webhook reconciles most cases). Check the Razorpay dashboard for any refund marked FAILED here.
- Delivery pincodes are only checked against `UNSERVICEABLE_PINCODES`; real courier serviceability comes with
  the shipping phase. The pincode is not cross-checked against the chosen state.
- Checkout needs an account (guests log in or register first; their cart is kept).
- No SMS or WhatsApp, and no password-reset email yet.
- Product images are saved to `apps/api/uploads/` on local disk. Move them to S3 or R2 before deploying
  to a host that wipes local files.
- There is no admin UI yet; catalog and stock are managed through the API until Phase 6.
- While `pnpm dev:api` runs, `prisma generate` and `pnpm build` can fail with `EPERM` because the running
  server holds Prisma's engine file. Stop the dev server first.
- When running a production build while `next dev` is active, use `NEXT_DIST_DIR=.next-test` so the two
  do not overwrite each other's `.next` folder.
