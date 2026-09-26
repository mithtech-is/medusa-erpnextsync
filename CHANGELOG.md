# Changelog

All notable changes to `@mithtech-medusa/plugin-erpnext`. Versions follow semver; `medusaRange` in
`factory.extension.yaml` is the tested range, not a guess.

## 0.2.0 — unreleased

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
  selection DocType.
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
