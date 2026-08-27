# erpnextsync

The **ERPNext ↔ Medusa** integration change-set for RISITEX — the `medusync`
connector work, captured as a single self-contained repo and verified live,
end-to-end, against real state in both systems.

> This repo is the **change-set of record**, organized by side. It is not an
> installable app on its own: the files live in three real homes (the Frappe
> `medusync` app, the generic Medusa plugin, and the Medusa backend), noted per
> directory below. See [`MANIFEST.md`](MANIFEST.md) for the full per-feature
> breakdown and [`docs/`](docs) for the design + verification docs.

## What it does

Two-way sync between a Frappe/ERPNext site and a Medusa v2 B2B commerce backend,
with **ERPNext as the source of truth** for stock and price:

- **Catalogue** — products published + priced + MOQ; ERPNext Item ⇄ Medusa product.
- **Inventory** — sellable = actual − reserved − safety (no overselling); ERPNext owns stock.
- **Orders** — full financials (addresses, tax, discount, shipping, payment) that reconcile exactly.
- **Fulfilment / tracking / invoice** — ERPNext Delivery Note / Shipment / Sales Invoice → Medusa order metadata.
- **Returns & refunds** — return DN → `order.returned` with receipt-gated stock restore; Credit Note → `order.refunded`; a Medusa-initiated return request creates a **draft** return DN.
- **Customer** — name/email/phone/group, **addresses** (→ linked ERPNext Address docs) and **GSTIN** (from the linked B2B company).
- **B2B pricing** — tier-mapped price lists → `b2b_price_tier` rows, with **quantity ladders** (via `packing_unit`).
- **Product attributes** — `category`→item_group (auto-created), `hsn_code`/`fabric`/`gsm`.
- **Reconciliation** — detail-level drift report (customer/product/order) with an on-demand admin tab.
- **Transport** — HMAC-signed webhooks, replay window, event-id idempotency, direction-aware retry.

## Layout

| Dir | Real home | Contents |
|---|---|---|
| [`frappe/`](frappe) | Frappe `medusync` app (`medusync/handlers/risitex/*`, `hooks.py`, `medusync/__init__.py`) | Inbound upserts, outbound event handlers, setup/seed scripts. Filenames flatten the real tree — see `MANIFEST.md` for the mapping (e.g. `frappe/handlers/risitex__init__.py` = `medusync/handlers/risitex/__init__.py`). |
| [`plugin/`](plugin) | Generic Medusa plugin `medusa-plugin-erpnext` | Module service (`modules/erpnext/`), admin API routes, reconciliation job, admin UI. |
| [`sandbox/`](sandbox) | Medusa backend (`apps/backend/src`) | New `wallet_settlement` module + its API/admin/seed. |
| [`docs/`](docs) | — | Design specs, the integration audit + re-audit, and per-feature results. |

## Status

All features verified live on the demo stack (see `docs/*_RESULTS.md` and
`docs/INTEGRATION_AUDIT_REPORT_V2.md`). Verdict: the core B2B order-to-cash +
returns loop is functional, with named non-critical follow-ups (percentage
Pricing Rules, MRP, richer product attributes) tracked in `MANIFEST.md`.

The real `risitex-mainb2b` application repo was **not** modified by this work.
