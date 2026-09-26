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

**ERPNext → Medusa, catalogue.** Tick **Sync to Medusa** on an Item and it
becomes (or updates) a product here, through the mapping you configured;
untick or delete it and the product goes to **draft**. Two paths carry it:

- **Webhooks**, as the document changes — Frappe core Webhooks that
  *Set up ERPNext* installs.
- **Pull**, every 5 minutes, for ticked rows changed since the last run —
  the safety net for a webhook that could not reach the store.

An hourly reconcile checks every linked document still carries the tick and
drafts the products of those that do not (unticked while the store was
down, trashed, renamed).

**Medusa → ERPNext is paused** in this release. Push mappings are still
evaluated — policy, trigger, allowlist, transform — and the outcome is
logged as `paused`; nothing leaves. Customers and orders over REST are the
next phase, stock and prices the one after.

## Set up ERPNext

One button on the Settings tab (`POST /admin/erpnext/setup`). For every
DocType listed under **Selection** it creates, over REST and idempotently:

| What | Name | Notes |
|---|---|---|
| Custom Field | `<DocType>-medusa_sync` | Check, "Sync to Medusa". Default `0` in **allow** mode, `1` in **deny** mode. |
| Webhook | `Medusa Sync: <DocType> on_update` | Fires when the document is ticked, or was ticked before this save (so an untick arrives once). `on_update` also runs on insert. |
| Webhook | `Medusa Sync: <DocType> on_trash` | Fires when a ticked document is deleted. |

Both webhooks POST `{event, doctype, name, doc}` — the whole document under
`doc` — to `<medusa_public_url>/webhooks/erpnext-inbound`, signed with a
secret the store generates (`X-Frappe-Webhook-Signature`, base64 HMAC-SHA256
of the body), with a `Content-Type: application/json` header row that Frappe
does not add by itself and Medusa needs in order to keep the raw bytes the
signature covers.

The conditions, exactly as installed:

```python
# on_update
doc.get("medusa_sync") or (doc.get_doc_before_save() and doc.get_doc_before_save().get("medusa_sync"))
# on_trash
doc.get("medusa_sync")
```

Allow list or deny list is chosen per DocType when the field is created.
In deny mode the column is created `NOT NULL DEFAULT 1`, so every existing
document is ticked at once. Changing the mode later changes the default for
new documents only; existing ticks stay.

Re-running the button is safe: each item reports created, updated,
unchanged or error. The API user needs **System Manager** (Custom Field
and Webhook are core DocTypes); a 403 says so.

The pull always ANDs `["medusa_sync","=",1]` into the filter of a mapping
on a selection DocType. If the field does not exist yet the query fails and
the pull says "run Set up ERPNext", which beats a page of unselected rows.

## The link table

`erpnext_link` remembers which Medusa record an ERPNext document became:
`(doctype, erpnext_name, medusa_entity) → medusa_id`, with a `state` of
`active` or `drafted`. It is written after every successful upsert, by
webhook or pull, and read whenever a document goes away, so the right
product is drafted even when the mapping's key would no longer find it. A
drafted link that is ticked again republishes the same product rather than
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

### Fixed values

A pair can send a constant instead of reading a store field — for a field
ERPNext requires that the store has no equivalent for, `company` being the
usual one. Use `=` on the row to switch it over, `↩` to switch it back.

The value is chosen from the connected site rather than typed from memory:
a Link offers that site's records, a Select its options, anything else free
text. A row switched to a fixed value and left blank is **not** a source: it
does not count towards required-field coverage, the rehearsal will not pass
on it, it is dropped when the mapping is saved, and it never reaches the
payload.

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
