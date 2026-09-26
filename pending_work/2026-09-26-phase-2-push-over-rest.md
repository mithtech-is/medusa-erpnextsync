# Phase 2 — Medusa → ERPNext over REST

**Status 2026-09-26:** not started. Pushes are paused in 0.2.0 (`src/modules/erpnext/outbound.ts`);
every push mapping is evaluated up to the transport and logged as `paused`. This note records
what Phase 2 has to restore and the seams already prepared for it. Scope it with the user first.

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
