# Phase 2 — Medusa → ERPNext over REST

**Status 2026-09-26 (evening):** built on `feat/push-over-rest` — generic REST push, Customer +
Address, Sales Order + Sales Invoice on capture, cancel/disable, echo suppression, the
`payment.captured` subscriber. Left for later: Payment Entry per captured payment
(`record_payments`), the store's own invoice numbering (Frappe ignores a name on insert for a
naming-series DocType; needs a custom field or a server hook), stub Items for unlinked lines,
and the open question below.

## What medusync used to do that has to come back

- Customers: Customer upsert, Address docs (billing, shipping; disabled when they disappear),
  GSTIN when the Address has the field, Contact for the phone.
- Orders: Sales Order with child `items` (stub Items when missing), delivery date, taxes and
  shipping as "Actual" charges, discounts; optional submit; Sales Invoice when the store's
  `order_document` says so; the store's own invoice numbering (`invoice_numbering = store`,
  `allocateStoreInvoiceNumber` still exists) and `send_invoice_to_store`.
- Payments: one Payment Entry per captured store payment (`record_payments`), idempotent by
  payment id — see `2026-09-14-store-payments-and-gateway-settlement.md`.
- Return requests from Medusa (`order.return_requested`) → a draft return Delivery Note.

## Seams already in place

- `pushViaMapping` keeps its pre-flight: product policy, the record-direction gate
  (`pushAllowedByRecord` on the link's `remote_direction`), trigger, allowlist, transform,
  skip-unchanged hash. Only the transport half stops (`OUTBOUND_PAUSED`).
- `erpnext_link` maps Medusa ids to ERPNext names both ways; `remote_direction` says whether
  the document may be pushed. `linkProductToItem` records it; `isLinked` still reads
  `metadata.erpnext_item_code` and should move to the link table.
- `augmentCustomerPayload` / `augmentSalesDocPayload` / `SALES_DOCTYPES` still build the
  child-items payload shape medusync accepted; REST needs Frappe's own `items` rows instead.
- `checkMappingDrift` keeps the `medusa_*_id` link keys in `alwaysValid` because the shipped
  push presets still map `id → medusa_customer_id` and friends. Decide: create those fields on
  ERPNext in Set up ERPNext, or drop the pairs from the presets and rely on the link table.
- A push that creates a document in ERPNext must set its `medusa_sync` to `Medusa → ERPNext`
  (or `Both`) — a fixed value on the push side of the mapping — or the document will read as
  not selected and the next push is refused.
- Echo suppression (`echo.ts`, `entity_ref`) is still recorded on inbound rows so a push can
  recognise its own change coming home; the `on_update` webhook now fires on any change of the
  field, so a REST write that also changes `medusa_sync` bounces once (logged and skipped).

## Transport

Plain Frappe REST with the API key: `POST /api/resource/<doctype>` to create,
`PUT /api/resource/<doctype>/<name>` to update, keyed through the link table, then by the
mapping's key field. Frappe validates and answers with `_server_messages`;
`frappe-client.ts` already turns those into readable errors. Submit with
`frappe.client.submit`. Rate: one document per call, sequential per mapping, the circuit
breaker (`breaker.ts`) around the connection.

## Decisions (user, 2026-09-26)

1. An order becomes a **Sales Order, and a Sales Invoice when payment is captured**, honouring
   the store's invoice numbering settings.
2. Documents are created as **drafts**; an ERPNext user submits them. A setting may enable
   auto-submit later.
3. Customers are matched **by email, then remembered in `erpnext_link`**; no custom field on
   Customer.
4. Open: should a push create an Item under `medusa_product_policy = create`, now that nothing
   on ERPNext validates it beyond Frappe's own rules?

## Local e2e, 2026-09-26 evening (fixerp + Splendx worktree, plugin 0.3.0-dev5)

Verified: a customer mapping with fixed values (`source`, `account_manager`,
`default_currency`, `market_segment`, `industry` — fixerp Property Setters) and Settings
customer group / territory creates Customer `CRN-01622` with its Shipping Address;
the rehearsal now refuses to pass while those fields are unmapped; the order mapping takes
fixed values for fixerp's `custom_sales_type` / `custom_sub`; `payment.captured` re-enters
as `order.payment_captured` (row written, push attempted); the Customer POST takes ~28 s and
a Sales Order POST 17–50 s on fixerp, inside the 90 s write timeout.

**Blocked:** every Sales Order / Sales Invoice write on fixerp answers
`HTTP 403 … Server Scripts are disabled`: fixerp has *Sales Order Before Save* and *Sales
Invoice Before Save* Server Scripts and the local bench has no `server_script_enabled` in
`sites/common_site_config.json` (Frappe 16 ignores the site-level key; a web-worker reload
is needed after setting it because the common config is cached per process). Enabling it is
the user's call — it enables scripts for all five sites on that bench. Until then the SO / SI
/ cancel paths are exercised only up to ERPNext's validation.

Side effect to decide on: with Stock Settings → *Auto Insert Item Price If Missing* on
(fixerp: on), the first Sales Order for an Item with no Standard Selling price records the
store's rate as an Item Price. Phase 3 (prices) should own that; until then the setting
decides.

## Local e2e, 2026-09-26 night — complete (plugin 0.3.0-dev6)

The user enabled server scripts bench-wide (`bench set-config -g server_script_enabled true`,
web workers reloaded). Then, on fixerp: order #2 → Sales Order `SAL-ORD-2026-00271` (draft,
GST rows from "Output GST In-state - FIPL", shipping as an Actual charge on "Freight and
Forwarding Charges - FIPL", terms rendered from "Sales Invoice Terms & Condition", grand total
18,218.02 = the store's total) and, the payment being captured, Sales Invoice `FI-SER-27-0125`
(draft, lines naming the draft order's rows, `debit_to` filled by ERPNext, recorded in
`erpnext_invoice`); order #1 → Customer `CRN-01623` + Sales Order `SAL-ORD-2026-00272`, then
cancelled in Medusa → the draft was deleted on fixerp and the link dropped. Found and fixed on
the way: `make_sales_invoice` needs a submitted order; a taxes template only expands on a new
document with no tax rows; `terms` is never rendered from `tc_name` over REST; a failed Country
read was cached for a day; a PUT that replaces `items` regenerates the child rows (harmless on
a draft). Left on fixerp: two Customers, one Address, one SO, one SI, one Standard Selling Item
Price (1,499) on "UPS INPUT PANEL -INDOOR-CU BUSBAR".
