# @mithtech-medusa/plugin-erpnext (erpnextsync)

A Medusa v2 plugin that keeps a Medusa store in step with a Frappe/ERPNext
site, with **ERPNext as the source of truth** for the catalogue, stock and
price.

Nothing is installed on ERPNext. The plugin uses what Frappe already has —
core **Webhooks**, a **Custom Field** and the REST API — and creates the
two things it needs over REST from one admin button.

## Install

```bash
npm install
npx medusa plugin:build
```

Then register it in the Medusa backend's `medusa-config.ts`:

```ts
plugins: [{ resolve: "@mithtech-medusa/plugin-erpnext", options: {} }]
```

Connection (ERPNext URL, API key/secret, the store's public URL) is
configured at runtime from the admin **ERPNext** page, with env fallbacks
(`ERPNEXT_URL`, `ERPNEXT_API_KEY`, `ERPNEXT_API_SECRET`,
`ERPNEXT_FRAPPE_WEBHOOK_SECRET`, `MEDUSA_BACKEND_URL`). Doctype mappings live
in `erpnext_mapping` rows and are edited on the same page.

## What it does today

**ERPNext → Medusa, catalogue.** Set **Sync to Medusa** on an Item to
*ERPNext → Medusa* or *Both* and it becomes (or updates) a product here,
through the mapping you configured; clear it or delete the Item and the
product goes to **draft**. Two paths carry it:

- **Webhooks**, as the document changes — Frappe core Webhooks that
  *Set up ERPNext* installs.
- **Pull**, every 5 minutes, for selected rows changed since the last run —
  the safety net for a webhook that could not reach the store.

An hourly reconcile checks every linked document still moves ERPNext →
Medusa and drafts the products of those that do not (deselected while the
store was down, trashed, renamed); a document that became Medusa → ERPNext
is left alone.

**Medusa → ERPNext, over plain Frappe REST.** A push mapping writes with
the API key: a document is found through the link table, then by the
mapping's key, and created or updated as the mapping allows. Two doctypes
get more than a flat document:

- **Customer**: name, type, email, phone, GST fields when the site has
  them, customer group and territory from Settings, and the customer's
  addresses (plus the company's GST-registered billing address) as linked
  **Address** documents.
- **Sales Order**: one line per order line (the product's link, else its
  SKU), the customer, both addresses, the order number as PO number,
  shipping as an "Actual" charge on the configured account, a discount on
  the grand total; and once the order is paid in full a draft **Sales
  Invoice** made from it. Everything is created as a draft; an ERPNext
  user submits.

A cancelled order deletes its draft documents (or cancels submitted
ones); a deleted customer or product is disabled, never deleted.
`ERPNEXT_PAUSE_PUSH=true` pauses pushes without touching the mappings.
Stock and prices are the next phase.

## Set up ERPNext

One button on the Settings tab (`POST /admin/erpnext/setup`). For every
DocType listed under **Selection** it creates, over REST and idempotently:

| What | Name | Notes |
|---|---|---|
| Custom Field | `<DocType>-medusa_sync` | Select, "Sync to Medusa": blank / `ERPNext → Medusa` / `Medusa → ERPNext` / `Both`. Default blank in **allow** mode, `Both` in **deny** mode. |
| Webhook | `Medusa Sync: <DocType> on_update` | Fires when the document moves ERPNext → Medusa (that value or Both), or did before this save, so a deselection arrives once. `on_update` also runs on insert. |
| Webhook | `Medusa Sync: <DocType> on_trash` | Fires when a document moving ERPNext → Medusa is deleted. |

Both webhooks POST `{event, doctype, name, doc}` — the whole document under
`doc` — to `<medusa_public_url>/webhooks/erpnext-inbound`, signed with a
secret the store generates (`X-Frappe-Webhook-Signature`, base64 HMAC-SHA256
of the body), with a `Content-Type: application/json` header row that Frappe
does not add by itself and Medusa needs in order to keep the raw bytes the
signature covers.

The conditions, exactly as installed:

```python
# on_update — moves ERPNext → Medusa now or did before this save, or the field changed at all
doc.get("medusa_sync") in ("ERPNext → Medusa", "Both") or (doc.get_doc_before_save() and (doc.get_doc_before_save().get("medusa_sync") in ("ERPNext → Medusa", "Both") or doc.get("medusa_sync") != doc.get_doc_before_save().get("medusa_sync")))
# on_trash
doc.get("medusa_sync") in ("ERPNext → Medusa", "Both")
```

A change of the field is delivered even between `Medusa → ERPNext` and
blank, so the link always holds the direction ERPNext last showed; such a
delivery is logged and skipped, never applied.

**A document only narrows its mapping.** A pull-only mapping never pushes
a `Both` document; a two-way mapping never pushes an `ERPNext → Medusa`
one. The link table remembers the value ERPNext last showed for each
document, and a push reads it before leaving: `ERPNext → Medusa` or blank
means the push is skipped as `record-direction`. A `Medusa → ERPNext`
document is Medusa's own: whatever ERPNext does to its copy, the product
here is left alone.

Allow list or deny list is chosen per DocType when the field is created.
In deny mode the column is created with default `Both`, so every existing
document is selected at once. Changing the mode later changes the default
for new documents only; existing values stay.

Re-running the button is safe: each item reports created, updated,
unchanged or error. The API user needs **System Manager** (Custom Field
and Webhook are core DocTypes); a 403 says so.

The pull always ANDs `["medusa_sync","in",["ERPNext → Medusa","Both"]]`
into the filter of a mapping on a selection DocType. If the field does not exist yet the query fails and
the pull says "run Set up ERPNext", which beats a page of unselected rows.

## The link table

`erpnext_link` remembers which Medusa record an ERPNext document became:
`(doctype, erpnext_name, medusa_entity) → medusa_id`, with a `state` of
`active` or `drafted` and the `remote_direction` ERPNext last showed. It is written after every successful upsert, by
webhook or pull, and read whenever a document goes away, so the right
product is drafted even when the mapping's key would no longer find it. A
drafted link that is selected again republishes the same product rather than
making a twin.

## The catalogue, and products created here

ERPNext owns the catalogue. What may happen when a product is created **in
Medusa** is the one catalogue decision that belongs on this side, because
it governs what leaves Medusa. `medusa_product_policy`:

| Value | Effect |
|---|---|
| `off` | Medusa-created products never reach ERPNext. |
| `link` | **Default.** They reach ERPNext only once attached to an existing Item. |
| `create` | They may create an Item. |

Attaching a product to the Item that already exists:

```
GET  /admin/erpnext/products/unlinked?search=jeans
POST /admin/erpnext/products/{id}/link   { "item_code": "23435" }
```

Medusa keeps the item code in `metadata.erpnext_item_code` and the link
table keeps the pair. Nothing is written to ERPNext.

## Rehearsing a mapping

A mapping is a small program somebody wrote in a form. These answer what
it would do, without doing it:

```
GET  /admin/erpnext/studio/sample?entity=product[&id=prod_123]
POST /admin/erpnext/mappings/{id}/dry-run     { "record_id": "prod_123" }   # optional
POST /admin/erpnext/studio/plan-inbound       { "event": "on_update", "doctype": "Item",
                                                "name": "SKU-1", "doc": { ... } }
```

`plan-inbound` takes exactly what a Frappe Webhook sends and reports, per
enabled mapping for that DocType, whether the document would be upserted,
drafted or skipped, the key it would land on, the payload it would write
and the fields dropped for want of a source value. It asks the same code
the real inbound path asks.

### Where a value comes from, per direction

Each pair, in each direction it flows, takes its value from one of:

- the **source field** — today's behaviour;
- a **fixed value** — always this, ignoring any source. `constant` on the
  way out (`Item.item_group`, `company`), `constant_pull` on the way in
  (every pulled product `status = published`, `metadata.source = erpnext`,
  a sales channel, a shipping profile);
- a **default** — used only when the source is empty. `default_push`,
  `default_pull`, or `default` for both.

The mapper offers the three per direction. Values are chosen from the
connected system rather than typed from memory: for an ERPNext target a
Link offers that site's records and a Select its options; for a Medusa
target the product status, the store's sales channels, shipping profiles,
collections and types are listed; anything else is free text. A fixed value
left blank is **not** a source: it does not count towards required-field
coverage, the rehearsal will not pass on it, it is dropped when the mapping
is saved, and it never reaches the payload. Fixed and default values do
count, in the direction they are set for.

### Types and transforms

Auto-map reads both sides' field types and sets a transform when a safe
conversion exists (text ↔ number, 1/0 ↔ true/false, dates); a lossy or
ambiguous pair (text into an Int, a list into text) is flagged with the
suggestion and left to you. The pair row shows the same warning whenever
the two types disagree and no transform is set.

A pair may carry `transform_push` and `transform_pull`; `transform` is the
fallback for both. A transform that cannot coerce a value **skips the
field** — it appears in `skippedFields`, with the reason in `failures` —
and never writes null over the target.

| Transform | Does |
|---|---|
| `text`, `number`, `integer`, `decimal:N`, `boolean`, `check` | coerce; `check` is 1/0 for a Frappe Check |
| `map:a=b,c=d` | translate values; the shared `transform` runs it in reverse on pull |
| `phone`, `phone:GB` | E.164 via libphonenumber; the settings' default region for a bare number |
| `date_iso`, `date_yyyy_mm_dd`, `datetime_frappe` | naive Frappe values are read and written in the ERPNext site's timezone |
| `json`, `parse_json`, `split:,`, `join:,`, `prefix:`, `suffix:`, `slice:` | shape |

## Develop

```bash
npm run typecheck   # tsc over the plugin and its specs
npm test            # vitest: webhook signature and plan, selection, setup, mapping engine …
npm run build       # medusa plugin:build
```

Never name a route folder `test`, `unit-tests` or `integration-tests`: the
plugin build drops it silently. `route-folders.spec.ts` guards this.

## Layout

| Path | What |
|---|---|
| `src/modules/erpnext/` | The module service, the mapping engine, the entity registry, and the pure rules: `frappe-webhook.ts` (signature, body, plan), `selection.ts`, `erpnext-setup.ts`, `pair-identity.ts`, `outbound.ts`. |
| `src/api/webhooks/erpnext-inbound/` | Where the Frappe Webhooks deliver. |
| `src/api/admin/erpnext/` | Admin API — settings, setup, mappings, pull/push, events/retry, reconcile, products link. |
| `src/admin/routes/erpnext/` | Admin UI (Settings / Mappings / Pull / Events / Reconcile tabs). |
| `src/jobs/` | Pull every 5 min, retry every 5 min, hourly reconciliation, nightly prune. |
| `docs/` | Operations, local development, resuming on another machine. |
| `pending_work/` | What is still to decide or build, one file per topic. |

## Status

Phase 1 (catalogue, ERPNext → Medusa over core Webhooks) is built and
verified locally against a Frappe 16 bench. See `CHANGELOG.md`.
