# KOMA – Architecture

Single-seller e-commerce for physical products in India, tied to an existing physical store.
Modular monolith: one NestJS API with clear module boundaries, so modules can be split out later
(multi-vendor, separate inventory service) without a rewrite.

## Stack
| Layer | Choice |
|---|---|
| Storefront | Next.js 15 (React, TypeScript) |
| Admin | Next.js route group `/admin` (later) |
| API | NestJS 11, REST under `/api/v1` |
| DB | PostgreSQL 16 + Prisma 6 |
| Cache/queues | Redis 7 (+ BullMQ) |
| Payments | Razorpay (UPI, cards, netbanking, wallets) + Cash on Delivery |
| Shipping | Courier via a `ShippingProvider` interface; manual AWB entry first, aggregator (e.g. Shiprocket) once chosen |
| Messaging | Email (Resend/SES) + WhatsApp/SMS order updates (later) |
| Media | S3-compatible storage + CDN |

## Diagram
```
 Browser ──► CDN ──► Next.js storefront ─┐
 Admin   ───────────────────────────────┤
                                         ▼
                              NestJS API (/api/v1)
   Auth · Catalog · Inventory · Cart · Checkout · Orders · Payments · Shipping · Admin
        │          │           │                │            │
    PostgreSQL   Redis      S3/R2          BullMQ jobs   Razorpay / Shiprocket
```

## India-specific decisions
- **Money** is stored as integer paise. Prices are GST-inclusive; each product carries `hsnCode` and
  `gstRate`, and order items snapshot them so GST invoices stay correct after later edits.
  Intra-state (CGST+SGST) vs inter-state (IGST) is decided from the shop's state vs the delivery state.
- **Payments:** Razorpay order is created server-side; the browser pays; the **webhook** is the source
  of truth for `PAID`. Webhooks verify the signature and are deduplicated via `WebhookEvent`.
- **COD:** disabled for now (prepaid only, behind a feature flag). When enabled, order goes `PENDING → PACKED` without a payment capture; COD limits and a pincode
  serviceability check are applied at checkout.
- **Addresses:** 6-digit pincode, state required; serviceability looked up from the shipping provider.
- **Login:** email + password first; phone OTP is a planned addition (common in India).

## Physical store integration (the "digital store" side)
- One **Inventory**: `StockLevel` per variant per `Location` (shop or warehouse), with `onHand` and
  `reserved`. Online orders reserve stock; in-store sales decrement `onHand`.
- Variants carry the **same barcode/SKU as the shop**, so staff can scan to adjust stock.
- **Click & collect:** `fulfilment = STORE_PICKUP` with a `pickupLocationId`; status `READY_FOR_PICKUP`.
- `Order.channel` (`ONLINE` / `STORE`) lets a simple POS screen (later phase) record walk-in sales in
  the same system, so stock and sales reports cover both.

## Checkout flow
1. Validate cart against live prices and stock (server-side prices only).
2. In one DB transaction: create the order as `PENDING`, snapshot items and address, reserve stock.
3. Online: create Razorpay order → client pays → webhook `payment.captured` → order `PAID`.
   COD: order confirmed directly.
4. Background jobs: confirmation email/WhatsApp, GST invoice PDF, courier shipment creation.
5. Unpaid online orders expire after 30 minutes and release reserved stock.

## Repo layout
```
apps/api      NestJS backend + Prisma schema (prisma/schema.prisma)
apps/web      Next.js storefront
packages/     shared code (types/validation) when needed
docs/         this file and PLAN.md
docker-compose.yml   Postgres + Redis for local dev
```

## Security & operations
Argon2/bcrypt hashing, validation on every DTO, Helmet, CORS allow-list, rate limiting, Prisma
parameterised queries, card data never touches our servers (Razorpay Checkout). Daily DB backups,
Sentry for errors, structured logs, health endpoint at `/api/v1/health`.
DPDP Act: collect minimal personal data, support account deletion/export.
