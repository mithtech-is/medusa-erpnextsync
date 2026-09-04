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

## The catalogue, and products created here

ERPNext owns the catalogue. It announces which DocType holds it, so this
plugin searches the right place even on a project that keeps products
somewhere other than `Item`, and it decides per document whether a record
may sync at all.

What may happen when a product is created **in Medusa** is the one
catalogue decision that belongs on this side, because it governs what
leaves Medusa. `medusa_product_policy`:

| Value | Effect |
|---|---|
| `off` | Medusa-created products never reach ERPNext. |
| `link` | **Default.** They reach ERPNext only once attached to an existing Item. |
| `create` | They may create an Item. |

Updates to a product that is already linked always flow: the policy
governs bringing a new product across, not keeping a known one in step.

Attaching a product to the Item that already exists:

```
GET  /admin/erpnext/products/unlinked?search=jeans
POST /admin/erpnext/products/{id}/link   { "item_code": "23435" }
```

Both sides record it — Medusa keeps the item code in
`metadata.erpnext_item_code`, ERPNext gets the Medusa id stamped on the
Item — so later pushes land on that record and reconciliation stops
reporting the pair as two orphans.

## Stock, prices and orders

Everything here is driven from the ERPNext side, which is where the
warehouses, price lists and money actually live.

**Stock.** `inventory.level.set` now carries `location_id` and
`warehouse`. ERPNext keeps the warehouse-to-location map per store, so
each store is told the location *it* knows; the quantity is sellable
stock, already net of what ERPNext has reserved. A location id this store
does not have is refused with a readable reason rather than written to a
level nothing can sell. Without a `location_id` the old behaviour stands:
`INVENTORY_LOCATION_ID`, or the first stock location.

**Prices.** `variant.price.set` and `variant.tier_price.set` are
unchanged on the wire. What changed is upstream: ERPNext decides per store
which price list is a base price and which is a customer tier, so one
store can receive a list as a shelf price while another receives the same
list as a tier.

**Orders.** Two events land in the order's metadata:

| Event | Metadata key | Shape |
|---|---|---|
| `order.source.set` | `erp_order` | replaced: `{ source, sales_order, status, payment }` |
| `order.payment.set` | `erp_payments` | accumulated, keyed by Payment Entry |

`erp_payments` is a map rather than a single object because an order can
be settled by several transfers. Each receipt is filed under the Payment
Entry that produced it, so a re-send overwrites only its own entry, and
`erp_payments_total` holds what has actually been received — a cancelled
receipt stays visible but stops counting. See `order-payments.ts`.

Money is never turned into a Medusa payment record. ERPNext is the
accounting authority in this setup, and a payment nothing captured would
put a figure in the storefront ledger that no statement backs.

For the order's own provenance, the `order` entity now exposes
`source` (its sales channel name, or `web`), so a mapping can carry it
into `Sales Order.medusa_order_source` and ERPNext can report it back.

## Rehearsing a mapping

A mapping is a small program somebody wrote in a form. These answer what
it would do, without doing it:

```
GET  /admin/erpnext/studio/sample?entity=product[&id=prod_123]
POST /admin/erpnext/mappings/{id}/dry-run     { "record_id": "prod_123" }   # optional
POST /admin/erpnext/studio/plan-inbound       { "event": "...", "data": {} }
```

The sample is a real record when you name one, and one built from the
entity's own declared paths when you do not � which is what a brand-new
mapping needs, since there is usually nothing to point at yet. `dry-run`
no longer requires `record_id`: without it the push is rehearsed against
that sample. `plan-inbound` reports which enabled mapping would take an
ERPNext event, the entity and key it would land on, the payload it would
write, and the fields the mapping dropped for want of a source value.

Everything here asks the same code the real paths ask. The inbound plan
and the real inbound apply share their candidate selection and their
transform, so a rehearsal cannot quietly drift from what actually happens.

### Test traffic

ERPNext can send a real signed request carrying `dry_run`. It passes the
signature check, the replay window and the echo test exactly as any
request does, and then stops before the write: the response is the plan.
That is the only check that proves the shared secret, the network and this
side's own verdict at once, which between them are most of the reasons a
sync fails in practice.

The `erpnext_sync_event` row it leaves is marked `is_test`, and everything
that reads the table skips marked rows. Otherwise the retry job would
re-send a fabricated payload for real, and a rehearsed success would let
`skip_unchanged` suppress a genuine push as a duplicate � both invisible
from either end. They are pruned after a day whatever retention says.

`pending_work/` records what is still missing on this side: the enable
gate, which ERPNext already has.

## Hard reset

A reset throws away configuration somebody spent a week getting right, so
the question worth answering is not what it does but who may ask. Nobody,
alone: each system generates a secret and shows it once, and each has to
be handed the other's.

```
POST /admin/erpnext/reset/request        { "site_id": "default" }   -> the secret, once
POST /admin/erpnext/reset/confirm        { "id": "...", "secret": "<ERPNext's>" }
GET  /admin/erpnext/reset/{id}                                       -> where it stands
POST /admin/erpnext/reset/{id}/perform                               -> only when both proved
```

The secret is 32 random bytes, lives three minutes, works once, and is
stored only as a SHA-256. `reset.verify` arriving from ERPNext is answered
before anything else looks at it, and its audit row is written with the
body redacted whatever the payload-logging setting says. A secret that
reaches a log has a much longer life than three minutes.

A wrong secret does not spend the request: a typo, or anyone who can reach
the endpoint, must not cost the operator the three minutes and the trip.
A refusal answers 200, because it is a fact about the secret rather than a
transport failure, and telling the sender to retry would hand an attacker
unlimited attempts inside the window.

| | |
|---|---|
| **Keeps** | every product, customer and order, and every ERPNext id on them |
| | the connection settings and both secrets |
| **Switches off** | every mapping |
| **Clears** | `erpnext_sync_event`, in full |

This side has no shipped mapping set of its own. Mappings here are the far
side's copies, and ERPNext restores its defaults and pushes them over when
somebody enables one � so "restore defaults" here is exactly "switch
everything off and wait", which is what the reset does.

The four rules that make the secret worth anything � long enough,
short-lived, single use, compared without leaking how far the comparison
got � live in `src/modules/erpnext/reset.ts` with no database in sight, so
they can be tested exactly. `medusync/reset.py` is the mirror; the hash
has to agree or no handshake can complete.

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
