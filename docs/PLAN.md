# KOMA â€“ Delivery Plan

Estimates are for one full-time developer. Status: â˜ todo, âœ… done.

| # | Phase | Scope | Est. |
|---|---|---|---|
| 0 | Setup âœ… (mostly) | Monorepo, Docker Compose, Prisma schema, API + web skeletons, docs. Remaining: run first migration, CI, lint | 2â€“3 d |
| 1 ✅ | Auth & users | Register/login, JWT + refresh cookie, roles (customer/admin/staff), profile, addresses | 1 wk |
| 2 ✅ | Catalog | Categories, products, variants, images upload, listing, filters, search, product page, SEO | 1.5 wk |
| 3 ✅ | Inventory | Locations (shop/warehouse), stock levels, reservation logic, barcode lookup, admin stock adjust | 1 wk |
| 4 | Cart & checkout | Guest + user cart, address, pincode check, order creation, GST breakdown, COD, click & collect | 1.5 wk |
| 5 | Payments | Razorpay order + webhook, expiry job, refunds, confirmation email | 1 wk |
| 6 | Admin panel | Product/order management, status updates, stock, dashboard | 1.5 wk |
| 7 | Shipping | Shiprocket: rates, shipment creation, AWB, tracking updates, GST invoice PDF | 1 wk |
| 8 | Store/POS lite | Staff screen to scan and sell in store, reports covering both channels | 1 wk |
| 9 | Polish | Reviews, coupons, wishlist, WhatsApp/SMS updates, phone OTP login, performance | 1â€“2 wk |
| 10 | Hardening & launch | Tests (unit, API, Playwright checkout), security review, backups, monitoring, deploy | 1.5 wk |

**MVP (can sell online):** phases 0â€“6, about 8â€“9 weeks. Full plan: about 12â€“14 weeks.

## Definition of done per phase
Working feature in the UI, API covered by tests for money/stock logic, migration committed, docs updated.

## Next steps
1. Start Docker Desktop, then `pnpm db:up` and `pnpm db:migrate` to create the tables.
2. Phase 1: auth module.
3. Decide: hosting (suggested: Vercel for web, Railway/Render or AWS Mumbai for API + DB).

## Decisions (confirmed by owner)
- **KOMA replaces billing/POS.** No existing software, so no sync is needed. The shop sells through KOMA,
  which makes Phase 8 (store/POS) more important: GST invoices and stock for walk-in sales live here.
- **GST:** GSTIN is pending; registered state is **Uttarakhand**. Stored as config (`SELLER_STATE`,
  `SELLER_GSTIN`); delivery within Uttarakhand = CGST+SGST, elsewhere = IGST. Until the GSTIN arrives,
  issue order confirmations/receipts only, not tax invoices.
- **Payments:** prepaid only (Razorpay). COD stays in the schema but is disabled by a feature flag;
  an order-value limit and pincode rules will be added when COD is turned on.
- **Shipping:** couriers, provider not chosen yet. Build a `ShippingProvider` interface with a manual
  option first (admin enters courier + AWB); plug in Shiprocket or another aggregator later.

## Still open
- Courier/aggregator choice (before Phase 7).
- GSTIN number (before tax invoices go live).



