# medusa-plugin-erpnext (erpnextsync)

The **Medusa side** of the RISITEX ERPNext ↔ Medusa integration: a generic
Medusa v2 plugin that syncs a Medusa B2B commerce backend with a Frappe/ERPNext
site, with **ERPNext as the source of truth** for stock and price.

- **This repo** = the installable Medusa plugin (`src/`, `package.json`, …).
- **ERPNext side** = the Frappe `medusync` app, published separately at
  [`suparikoli/medusync`](https://github.com/suparikoli/medusync).

## Install

```bash
npm install
npx medusa plugin:build
```

Then register it in the Medusa backend's `medusa-config.ts`:

```ts
plugins: [{ resolve: "medusa-plugin-erpnext", options: {} }]
```

Connection (ERPNext URL, HMAC secrets, API key/secret, enable) is configured at
runtime from the admin **ERPNext** page (or `erpnext_setting` row + env
fallback); doctype mappings live in `erpnext_mapping` rows.

## What it does

Two-way, mapping-driven sync with signed webhooks (HMAC + replay window +
event-id idempotency + direction-aware retry):

- **Catalogue** — Medusa product ⇄ ERPNext Item (published + priced + MOQ), plus
  `metadata.category`→item_group and `hsn_code`/`fabric`/`gsm`.
- **Inventory** — sellable = actual − reserved − safety (no overselling).
- **Orders** — full financials (addresses, tax, discount, shipping, payment) that reconcile exactly.
- **Fulfilment / tracking / invoice / returns / refunds** — ERPNext docs → Medusa order metadata; Medusa-initiated return → a **draft** return DN.
- **Customer** — group, **addresses** (→ linked ERPNext Address docs) and **GSTIN**.
- **B2B pricing** — tier-mapped price lists → `b2b_price_tier` rows with **quantity ladders**.
- **Reconciliation** — detail-level drift report (customer/product/order) with an on-demand admin tab.

## Wire contract (v2)

Both sides speak one envelope, defined in `src/modules/erpnext/envelope.ts`
and mirrored by `medusync/envelope.py`. Change them together.

```jsonc
{
  "v": 2,
  "kind": "event" | "mapped" | "mapping",   // what the body holds
  "event": "customer.updated",
  "event_id": "...",                        // idempotency key
  "id": "...",                              // v1 alias, still sent
  "ts": 1788474641,                         // inside the signature
  "origin": {
    "system": "medusa" | "erpnext",
    "site_id": "default",
    "correlation_id": "...",                // survives a causal chain
    "echo_of": "erpnext:default"            // set only on a return trip
  },
  "data": { }                               // kind=event
}
```

A body with no `v` is read as v1 and still applies, so the two apps can be
upgraded one at a time.

**Sites.** One ERPNext can serve several Medusa stores. Each store is a
Medusync Site record on the ERPNext side with its own URL and its own pair of
shared secrets; this plugin's `site_id` setting must equal that record's Site
ID. Inbound requests are attributed to a site by their signature, not by
anything the caller claims.

**Loop prevention.** An inbound write records which Medusa record it touched.
The event that write emits reaches the forward subscriber in a later request,
where no in-memory flag survives, so the push looks that record up, finds it
was caused by ERPNext, and stamps `echo_of`. The far side drops what it
recognises as its own. Both directions are symmetric.

**Mapping configuration is synchronised.** A mapping is one configuration
living in two systems, paired by `mapping_uid` and ordered by `version`. A
save on either side sends `mapping.upserted`; the higher version wins, and
ERPNext wins a tie because ERPNext owns which documents may sync at all. A
delete disables the far copy rather than destroying it.

**Per-field direction** is `push`, `pull`, `both` or `none`. `none` is
Don't Sync: the pair stays documented in the mapping but moves in neither
direction, which is how "images flow ERPNext to Medusa but never back" and
"internal cost never leaves" are expressed.

## Develop

```bash
npm run typecheck   # tsc over the plugin and its specs
npm test            # vitest: envelope, mapping engine, conflict rule
```

## Layout

| Path | What |
|---|---|
| `src/modules/erpnext/` | The plugin module service — inbound dispatch, mapping engine, push/pull, reconcile, tier pricing. |
| `src/api/admin/erpnext/` | Admin API routes — settings, mappings, pull/push, events/retry, reconcile, orders/request-return. |
| `src/admin/routes/erpnext/` | Admin UI (Settings / Mappings / Pull / Events / **Reconcile** tabs). |
| `src/jobs/` | Cron jobs (hourly reconciliation + retry sweep). |
| `docs/` | Design specs, the integration audit + re-audit, per-feature results. |
| `backend/` | A Medusa **backend** module used alongside the plugin: `wallet_settlement` (its module + admin/API/seed). Not part of the plugin package itself — kept here so the connector's backend-side additions aren't lost. |
| `MANIFEST.md` | Per-feature change log for the whole remediation effort. |

## Status

All features verified live, end-to-end, against real state in both systems (see
`docs/*_RESULTS.md` and `docs/INTEGRATION_AUDIT_REPORT_V2.md`). Named
non-critical follow-ups (percentage Pricing Rules, MRP, richer product
attributes) are tracked in `MANIFEST.md`.
