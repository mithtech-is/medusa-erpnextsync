# Changelog

All notable changes to `@mithtech-medusa/plugin-erpnext`. Versions follow semver; `medusaRange` in
`factory.extension.yaml` is the tested range, not a guess.

## 0.6.0 — 2026-09-29

GST is ERPNext's: India Compliance computes it, and the store charges exactly what ERPNext will
invoice.

- **ERPNext picks the taxes.** Sales Orders and Invoices carry the company address, and their tax
  rows come from ERPNext's own `get_party_details`: India Compliance chooses the In-state or
  Out-state template from the billing, shipping and company addresses. Each line is taxed at its
  Item Tax Template's rate. The Settings taxes template, `withTemplateTaxes` and
  `taxTemplateForSupply` are gone. A push that gets no tax rows fails instead of writing a
  document without GST.
- **Shipping is taxed at the rates of the goods it carries.** Net shipping goes as an `Actual`
  row on the shipping account ahead of the GST rows, which become "On Previous Row Total". ERPNext
  then spreads it over the lines by value and taxes each share at that line's rate, and India
  Compliance adds it to each line's taxable value. Before, shipping including Medusa's GST was an
  untaxed freight row.
- **Discounts sit on the lines they hit.** Each line carries its price, its per-unit share of the
  promotions, and its net rate. There is no document-level discount any more, so shipping is never
  discounted. Pricing rules are ignored on store documents.
- **The store's total is ERPNext's rounded total.** `POST /store/carts/:id/erpnext-rounding` keeps
  one cart credit line (`erpnext-rounding`) at the difference, using ERPNext's own arithmetic
  (`erpnext-arithmetic.ts`: rows rounded separately, shipping spread by value, the grand total
  rounded by the site's System Settings method and the currency's smallest fraction). It refreshes
  the payment collection with it and follows Global Defaults > Disable Rounded Total. It clears the
  line rather than cover a gap over ₹1, and other credit lines (gift cards) come off the rounded
  total unchanged. Store-facing ERPNext reads time out after 5 s.
- **Products carry their GST rate.** The Item pull (webhook and 5-minute pull) resolves the Item
  Tax Template ERPNext would pick (the Item's, else its group's) and records its rate as a product
  rule on the tax region of the company's country, creating a "GST n%" rate when needed.
  `metadata.gst_rate` and `metadata.gst_template` are display copies. An Item with no template is
  charged the region's default rate; a template or group that cannot be read leaves the rate as
  it is.
- **No stock double count.** The level written to Medusa adds back what Medusa still reserves for
  store orders whose Sales Order is submitted and still to deliver (not Closed or Completed), so
  each unit is held once (`sellableQty(bin, safety, heldByStore)`).
- **Delivery Notes ship store orders.** A Delivery Note's ledger entries (the existing Stock Ledger
  Entry webhook) create a Medusa fulfilment for the store order's lines, marked shipped with the
  LR number as tracking. A shipment that fails is retried, and a note is never fulfilled twice. A
  cancelled note becomes a failed event saying to record a return: Medusa does not cancel a
  shipped fulfilment. No new webhook.
- **A re-push refreshes a draft Sales Invoice** instead of stopping at "already exists".
- **Address book changes sync.** Creating or editing a saved address pushes the customer (workflow
  hooks announce `customer.updated`); deleting one disables its ERPNext Address and pushes the
  customer (a middleware on the delete routes). An address's type comes from
  `metadata.address_type`, else its default flags.
- **Discounted shipping reaches ERPNext discounted:** the shipping row is the net after shipping
  promotions, not Medusa's pre-discount `shipping_subtotal`.
- **Pushed Contacts get a person's name** when ERPNext made them without one.
- `GET /store/erpnext/orders/:id/gst` returns ERPNext's GST for a customer's order (the invoice,
  else the order): lines with taxable value and CGST/SGST/IGST, tax rows and rounded total.

## 0.5.6 — 2026-09-28

- **Registered buyers get a B2B invoice.** A customer's GSTIN now reaches the ERPNext Addresses
  that invoices are billed to: a GSTIN typed for an address at checkout (`metadata.gstin`) goes on
  that address, and the customer's own GSTIN goes on their saved addresses in the GSTIN's state
  (`gstinForAddress`; India Compliance refuses a GSTIN from another state). Before, every Address
  was Unregistered, so the Sales Order and Invoice had no billed-to GSTIN.
- **An order without a billing address is billed where it ships.** A checkout that records only
  the shipping address left ERPNext to bill the customer's first saved Address, which could be a
  different one; the shipping Address is now the billing Address too.

## 0.5.5 — 2026-09-28

Found by the production sync test on erp.splendax.com ↔ splendax.com.

- **A disabled Item selected again stays draft.** Republishing a drafted product no longer
  overrides a status the mapping produced from the document (`status <- disabled`); before, a
  disabled Item deselected and selected again went back on sale.
- **An edit made inside the echo window reaches ERPNext.** Within three minutes of an inbound
  write every push for that record was dropped as an echo and never retried, so a person editing
  the customer a minute after ERPNext changed it lost the edit. A push is now an echo only when
  every value it carries is already on the ERPNext document (`pushChangesRemote`).
- **Customer pushes leave ERPNext's choices alone.** The Settings customer group and territory,
  and an "Unregistered" GST category, fill a new Customer or a blank field only; they no longer
  overwrite what an ERPNext user set on every save in the store.
- **A customer's email and phone reach ERPNext.** ERPNext keeps `Customer.email_id` and
  `mobile_no` as read-only copies of the primary Contact, so writing them on the Customer was
  undone on save. The push now puts them on the primary Contact first (`primaryContactPatch`).
- **Customers the store creates are selected.** A Customer made by a push (or from a guest order)
  carries `medusa_sync` (`Both`, or `Medusa → ERPNext`), like any other pushed document. Before,
  it was left blank, the hourly reconcile recorded it as unselected, and every later push of that
  customer was refused as `record-direction`. Existing Customers affected: set their Sync to
  Medusa in ERPNext.
- **Guest customers are named after the person.** A guest checkout leaves Medusa a customer with
  only an email; the push now takes the name, phone and company from the order's billing address
  instead of naming the ERPNext Customer after the email address (`withOrderContact`).
- **The taxes template follows the place of supply.** Settings name one template; an order
  shipped to another state was refused by India Compliance ("Cannot charge CGST/SGST for
  inter-state supplies"). The push now uses the company's sibling template whose Tax Category
  matches (inter-state or not, reverse charge or not), comparing the shipping address's GST state
  with the company address's (`taxTemplateForSupply`). A site without those Tax Category fields,
  or with no single match, keeps the Settings template.

## 0.5.4 — 2026-09-27

- On a one-way sync the field pairs show a fixed arrow instead of a three-way choice; switching a
  sync to one-way drops any per-pair direction, which could only have disagreed with it.

## 0.5.3 — 2026-09-27

- **Customers can download ERPNext invoices** is a real switch now: when on, the Sales Invoice PDF
  is fetched from ERPNext when the invoice is raised and refreshed by the hourly reconcile once
  ERPNext submits it (`refreshInvoicePdfs`), kept in the configured invoice storage and served to
  the signed-in customer through the store routes. The read-only "Orders and invoices" summary is
  gone; what an order becomes stays under Pushing to ERPNext. Store-side invoice numbering and
  payment booking are no longer shown, since the REST push does not honour them.
- The "Default phone region" control is gone from Settings: store phone numbers carry their country
  code. The `phone` transform still falls back to IN for a number without one.

## 0.5.2 — 2026-09-27

- **Documents tab**: one row per ERPNext document tied to a store record — DocType, the document
  (linked into ERPNext's desk), the Sync to Medusa direction ERPNext last showed, the Medusa record
  (linked into the admin), active or drafted, last seen; filters by DocType, entity, state and a
  search. `GET /admin/erpnext/links` behind it. Which documents may sync stays an ERPNext-side
  decision (the field on each document); this is the record of what did.

## 0.5.1 — 2026-09-27

- The mapping editor names its two sides: a header row over the field pairs ("Medusa · Customer
  (this store)" / direction / "ERPNext · Customer + Contact (the ERP)"), and the ERPNext side of
  every pair is tinted. The syncs list says "Medusa (store)" and "ERPNext DocType".
- Settings explains what Set up ERPNext installs and why only DocTypes a sync reads from are
  listed, with the sync that reads each one; push-only syncs need nothing installed.

## 0.5.0 — 2026-09-27

- **A sync may span several DocTypes.** A mapping keeps its main DocType and may name secondary
  ones with how each is tied to the main document: a Link field on it (`Sales Invoice.customer`)
  or its Links table (Contact, Address). Each field pair picks the DocType it targets and its
  field list follows. Pushing writes the main document, then finds each linked document through
  the link (or creates it with the link set); pulling lays the linked documents under the main
  one so a pair reads `Contact.first_name`; a change to a linked document in ERPNext comes back
  as a change to the main one (Set up ERPNext adds an `on_update` webhook per secondary
  DocType). The rehearsal checks each DocType's mandatory fields; the editor shows a required
  panel per DocType. Columns `erpnext_mapping.secondary_doctypes` (migration `20260927120450`)
  and `field_mappings[].erpnext_doctype`.
- **Selection moves onto the sync.** Which DocTypes get the `Sync to Medusa` field and webhooks,
  and whether a new document starts blank (allow list) or on Both (deny list), is set on each sync
  in the Mappings editor (`selection_mode`, migration `20260927101530` carries today's modes over).
  Settings shows the derived list read-only; "Add a doctype" is gone. Every save or delete of a
  sync recomputes the list, so Set up ERPNext and the pull filter follow the Mappings page.
- DocType pickers ask ERPNext for up to 5000 DocTypes (was 2000), so a site with many apps shows all
  of them; the Set up ERPNext report is readable in dark mode.
- The mapping editor's "Required in ERPNext" panel no longer lists the mandatory fields the push
  fills itself (a Customer's name and type, a Sales Order's party, dates, currency and lines, the
  terms text from a `tc_name` pair), so it agrees with the rehearsal. `GET /admin/erpnext/doctypes/:name`
  returns them as `filled_by_push`.

## 0.4.0 — 2026-09-27

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
