# Changelog

All notable changes to `@mithtech-medusa/plugin-erpnext`. Versions follow semver; `medusaRange` in
`factory.extension.yaml` is the tested range, not a guess.

## 0.4.0 — unreleased

**Stock and prices, ERPNext → Medusa.** ERPNext owns both; nothing is written back.

- A store may sell what is on hand at its one warehouse less what Sales Orders already promise
  less a safety buffer (the Item's own `safety_stock` when set, else Settings), written to the
  store's stock location. It moves on a Stock Ledger Entry at the warehouse and on a Sales Order
  submit or cancel; the level is read from the Bin afterwards, never from the event.
- A selling price on the store's price list (Settings → selling price list, else Selling
  Settings) becomes the variant's base price in that currency; a trashed price removes it.
  Quantity tiers (`packing_unit` > 1), customer-specific prices, buying prices and prices not
  valid today are left alone.
- Only an Item that moves ERPNext → Medusa or Both moves its stock and price; a product linked
  by hand counts as allowed. The variant is the linked product's variant whose SKU is the Item
  code, else its only variant, else any variant with that SKU.
- Set up ERPNext adds the Webhooks once the switches are on (`Stock Ledger Entry after_insert`
  at the warehouse, `Sales Order on_submit` / `on_cancel`, `Item Price on_update` / `on_trash`
  on the list). The hourly reconcile and every catalogue pull re-read the linked Items' Bins and
  prices in a few reads; `POST /admin/erpnext/stock-prices/refresh` does it on demand.
- Settings: "Move stock levels", "Move selling prices", ERPNext warehouse, Medusa stock location
  id, safety stock (migration `20260927013045`), and a *Refresh stock and prices now* button.
- A retried stock or price row is replayed through the same planner; the studio's plan-inbound
  says what a stock or price event would move.
- Docs: `docs/DECOMMISSION-MEDUSYNC.md` (Phase 4, per site) and `docs/PRODUCTION-CHECKLIST.md`.

## 0.3.0 — 2026-09-26

**Medusa → ERPNext is back, over plain Frappe REST.** Nothing is installed on ERPNext.

- Push mappings write with the API key: `POST /api/resource/<doctype>` to create, `PUT` to
  update, matched through `erpnext_link`, then the mapping's key. `allow_create` /
  `allow_update` are enforced here. A document created on a selection DocType is stamped
  `Medusa → ERPNext` (or `Both` for a two-way mapping).
- **Customers** become Customers (name, type, email, phone, GST fields when the site has them,
  customer group and territory from Settings) with their addresses — and the company's
  GST-registered billing address — as linked **Address** documents.
- **Orders** become a draft **Sales Order** (lines by the product's link or the SKU, the
  customer, both addresses, the order number as PO number, shipping as an "Actual" charge on the
  configured account, a discount on the grand total) and, once paid in full, a draft
  **Sales Invoice** made from it; `order.payment_captured` is raised from `payment.captured`.
  The invoice is recorded in `erpnext_invoice`. A cancelled order deletes its draft documents or
  cancels submitted ones; a deleted customer or product is disabled, never deleted.
- Settings → Pushing to ERPNext: Company, selling price list, customer group, territory,
  shipping account, taxes template, and what an order becomes (Sales Order, plus a Sales
  Invoice once paid, or the invoice only).
- Echo suppression both ways: a document the API user last wrote is not applied back from a
  webhook or a pull; a push is not sent for a record an inbound write touched moments ago.
- `ERPNEXT_PAUSE_PUSH=true` pauses pushes without touching the mappings.
- Money is in the currency's major unit (Medusa 2); the old ÷100 is gone.
- Presets: customers keyed `email ↔ email_id`; orders keyed `display_id ↔ po_no` and
  listening to `order.payment_captured`; the `medusa_*_id` pairs are gone.
- The push rehearsal reads the site's Property Setters as well as its Custom Fields, so a
  standard field the site made mandatory is named before the first write fails; it no longer
  asks for fields the push fills itself (a Customer's name and type, a Sales Order's party,
  dates, currency and lines, the Settings-backed company, customer group and territory).
- An order whose customer mapping push fails stops with that error instead of falling
  through to a bare Customer create.
- The retry job replays `failed` and stale `pending` rows only, and marks an older failed
  push row `superseded` when a newer row exists for the same record and mapping. Push rows
  carry `entity_ref`.
- An event with no push mapping is logged and skipped (`no-mapping`), not reported as paused.
- A write waits up to 90 s for ERPNext's answer (reads keep the configured timeout).
- The Sales Invoice is built like the Sales Order and names the draft order's rows
  (`sales_order` / `so_detail`) line by line, since ERPNext's `make_sales_invoice` maps only a
  submitted order; a submitted order still goes through `make_sales_invoice`. Both documents get
  the taxes template's rows expanded ahead of the shipping charge and the Terms and Conditions
  text rendered from a `tc_name` pair, as ERPNext's form does. The rehearsal of an order mapping
  also checks the invoice's mandatory fields when Settings want one.
- A failed or empty Country read is no longer cached; delivery is promised a week from now when
  the order is older than today.
- A product counts as linked when `erpnext_link` says so, not only by the older metadata key. A
  retry row from before `entity_ref` existed still names its record through its payload.
- Known gaps, said so in Settings: store-side invoice numbering and "record payments" are read
  but not honoured by the REST push (ERPNext names its own invoices; a Payment Entry needs a
  submitted invoice, and documents stay drafts).

## 0.2.0 — 2026-09-26

**Breaking: the `medusync` Frappe app is no longer used.** ERPNext → Medusa runs on Frappe core
Webhooks and a `medusa_sync` Check field; nothing is installed on ERPNext.

- **Set up ERPNext** (Settings tab, `POST /admin/erpnext/setup`) creates the `<DocType>-medusa_sync`
  Custom Field — a Select: blank / ERPNext → Medusa / Medusa → ERPNext / Both — and two Webhooks
  (`on_update`, `on_trash`) per selection DocType, over REST, idempotently, signed with a secret the
  store generates. Allow list (default blank) or deny list (default Both) per DocType.
- **Per-record direction.** A document moves only the way its field says and never wider than its
  mapping allows. `POST /webhooks/erpnext-inbound` verifies `X-Frappe-Webhook-Signature` over the
  raw body and applies `{event, doctype, name, doc}` through the enabled pull mappings: ERPNext →
  Medusa or Both → upsert, blank or trashed → product to draft, selected again → republished; a
  Medusa → ERPNext document is never drafted. A push reads the direction ERPNext last showed
  (kept on the link) and skips `record-direction` for anything but Medusa → ERPNext or Both.
- The pull ANDs `["medusa_sync","in",["ERPNext → Medusa","Both"]]` into every mapping on a
  selection DocType. The `on_update` webhook also fires on any change of the field, so the link
  always holds the direction ERPNext last showed; a document that was Medusa-owned and is now
  unselected is left alone. A delivery already applied, or still being applied, is not applied
  twice; the retry job replays only failed inbound rows and refuses a body a later delivery for
  the same document has superseded.
- New `erpnext_link` table maps `(doctype, name, entity) → medusa_id` with the document's last
  direction; an hourly reconcile drafts the products of linked documents that no longer move
  ERPNext → Medusa.
- **Field types and conversion.** Auto-map reads both sides' types and sets `transform_push` /
  `transform_pull` when a safe conversion exists (text ↔ number, 1/0 ↔ true/false, dates); lossy
  or ambiguous pairs are flagged for review with the suggestion, never converted silently. The
  mapper row warns on any type mismatch. A transform that cannot coerce skips the field
  (`skippedFields` + `failures`) and never writes null. New transforms: `map:a=b,c=d` (reversed on
  the way back when shared), `phone[:REGION]` (E.164 via libphonenumber-js; "Default phone region"
  setting), `decimal:N`, `check`, `text`, `parse_json`, `datetime_frappe`; naive Frappe datetimes
  are read and written in the ERPNext site's timezone (`System Settings.time_zone`, cached).
- **Fixed and default values, either side.** Per pair and per direction a value comes from the
  source field, a fixed value (`constant` out, new `constant_pull` in — e.g. every pulled product
  published, in a sales channel, on a shipping profile) or a default when the source is empty
  (`default_push` / `default_pull`, `default` for both). The mapper offers all three with a value
  picker: ERPNext Link/Select values as before, and `GET /admin/erpnext/medusa-entities/:entity/options`
  for product status, sales channels, shipping profiles, collections and types. Coverage of
  required fields counts fixed and default values per direction.
- **Pushes to ERPNext are paused.** Push mappings are evaluated and logged as `paused`; the
  subscriber returns early; the retry job leaves outbound rows alone. Phase 2 restores them over
  REST.
- Settings: `frappe_to_medusa_secret` becomes `frappe_webhook_secret` (value kept);
  `medusa_public_url`, `sync_doctypes`, `erpnext_setup_at/report` added; `site_id`,
  `frappe_receive_method`, `webhook_secret`, `products_doctype` dropped (`products_doctype`
  backfills the first `sync_doctypes` entry, allow mode). Mapping `site_id`, `source_of_truth`,
  `last_synced_at` and event `origin`, `correlation_id`, `site_id` dropped. `erpnext_reset_request`
  dropped. (`Migration20260926143017`.)
- Removed routes: `webhooks/erpnext-describe`, `admin/erpnext/reset/*`,
  `admin/erpnext/mappings/sync-now`, `admin/erpnext/orders/{id}/request-return`.
  `studio/plan-inbound` now takes a webhook-shaped body.
- Env: `ERPNEXT_WEBHOOK_SECRET`, `ERPNEXT_FRAPPE_TO_MEDUSA_SECRET`, `ERPNEXT_RECEIVE_METHOD`,
  `ERPNEXT_SITE_ID` are no longer read; `ERPNEXT_FRAPPE_WEBHOOK_SECRET` and `MEDUSA_BACKEND_URL`
  are fallbacks for the new settings.
- Fixed: "pull now (full)" never cleared the watermark; an inbound trash of a handle-keyed
  product never matched (`disableByKey` with the raw item code); `products/unlinked` filtered on a
  field a vanilla ERPNext does not have.
- Dropped with medusync, consciously: the envelope and its replay window, the two-sided hard
  reset, mapping-config sync, the describe channel, the `dry_run` test traffic, the handler-pack
  events (stock, prices, fulfilment, returns, invoices, payments) and the return-request route.
  Stock and prices return in Phase 3; orders, customers, invoices and payments in Phase 2.

## 0.1.2 — 2026-09-23

- A link key is no longer mistaken for a missing field. The Frappe app moved the Medusa ids off
  Customer, Item and the sales doctypes into `Medusync Link` (patch v1_7) and kept the names as keys
  into that table, so a field map naming `medusa_product_id` is correct. `checkMappingDrift` was
  checking them against live doctype meta, finding them gone, and switching the mapping off — on
  sites where nothing was misconfigured. Seen on a live catalogue: "Item no longer has:
  medusa_product_id", mapping disabled, inbound events accepted and silently taken by nothing.

## 0.1.1 — 2026-09-21

- Verified against Medusa 2.21.0 (install, `plugin:build`, test suite, `tsc --noEmit`).
  Dev `@medusajs/*` ranges raised to `^2.21.0` (the version tested against); peer ranges and `medusaRange` stay `^2.19.0` because the
  extension uses no 2.20/2.21-only API and declares no store-route `allowed` field lists
  (the 2.21 strict allow-list change does not affect it, though the plugin does serve store routes).
- A fixed value is chosen from the connected site in the mapping editor, not only in the guided
  wizard: a Link or Select offers that site's own records, a pair can be turned into a fixed value
  and back, and a saved value the site no longer has stays selected and says so.
- A fixed value left blank no longer counts as a source. Turning a row into a fixed value and not
  saying what to send used to satisfy the mandatory-field warnings and the rehearsal that gates
  switching a mapping on, then write an empty string over the field on the first real record. It is
  now flagged in the editor, dropped on save, left out of the payload, and reported in the skipped
  fields.
- The wizard and the editor share one fixed-value control and one options reader, so a reply for a
  doctype that has since been changed away from is discarded rather than shown under the new one.
- Renamed to `@mithtech-medusa/plugin-erpnext`. 0.1.0 was published under the old name.

## 0.1.0

- Initial extraction and publish to Verdaccio (`npm.po5.in`).
