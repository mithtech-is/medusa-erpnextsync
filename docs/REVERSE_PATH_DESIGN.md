# Post-order reverse path (ERPNext → Medusa) — design

**Date:** 2026-08-26. Remediates audit #11 (fulfilment), #12 (invoice), #13
(cancellation side-effects). Demo sandbox + medusync only; RISITEX repo untouched.
All state stored on the **Medusa order's metadata** — native Medusa fulfillment
is unsupported here (no inventory/shipping-profiles), consistent with the
existing metadata-based dispatched/delivered lifecycle.

## Flow 1 — Delivery Note → fulfilment
- medusync `handlers/risitex/reverse.py::on_delivery_note` (hooked `Delivery
  Note` on_submit / on_cancel). Resolve the Sales Order via
  `Delivery Note Item.against_sales_order` → `SO.medusa_order_id`. If none, skip.
- Push `order.fulfilled`: `{medusa_order_id, status: "dispatched"|"cancelled",
  items:[{sku:item_code, qty}], lr_no, transporter, vehicle_no, dispatched_at}`.
- Plugin `dispatchInbound` case `order.fulfilled` → merge into
  `order.metadata.erp_fulfillment` + set the storefront-read fulfilment key,
  via `orderModule.updateOrders([{id, metadata}])`.
**Success:** submit a DN for a synced order → the Medusa order's
`metadata.erp_fulfillment.status = "dispatched"` with items + lr_no; cancel the
DN → status "cancelled".

## Flow 2 — Shipment → tracking
- `handlers/risitex/reverse.py::on_shipment` (hooked `Shipment` on_submit /
  on_update_after_submit / on_cancel). Resolve the linked Delivery Note(s)
  (`Shipment Delivery Note` child) → SO → order.
- Push `order.tracking`: `{medusa_order_id, awb_number, carrier, carrier_service,
  tracking_url, tracking_status, delivered: (tracking_status == "Delivered")}`.
- Plugin case `order.tracking` → merge `order.metadata.tracking`; when
  `delivered`, also set the delivered marker.
**Success:** submit a Shipment with AWB/carrier/tracking_url → Medusa order
`metadata.tracking` carries them; set tracking_status Delivered → delivered=true.

## Flow 3 — Sales Invoice → invoice
- `handlers/risitex/reverse.py::on_sales_invoice` (hooked `Sales Invoice`
  on_submit / on_cancel). Resolve SO/order via `SI.medusa_order_id` (SI is
  augmented with it on push) or via `Sales Invoice Item.sales_order`.
- Push `order.invoiced`: `{medusa_order_id, invoice_number, invoice_date,
  grand_total, currency, status: "Paid"|"Unpaid"}` (from `outstanding_amount`).
  **No accounting internals** (no GL/account heads/party ledger).
- Plugin case `order.invoiced` → merge `order.metadata.invoice`.
**Success:** submit a Sales Invoice for a synced order → Medusa order
`metadata.invoice = {number, date, total, status}`; totals match.

## Common
- Resolution chain: DN/Shipment/SI → SO (`against_sales_order` /
  linked DN / `SI.medusa_order_id`) → `SO.medusa_order_id` → Medusa order id.
- Delivered via the same signed `outbound.deliver` pipe + Medusync Log; plugin
  reuses `/webhooks/erpnext-inbound` HMAC/ts/idempotency.
- Metadata merge is additive (never clobber existing order metadata).
- Storefront: align the exact metadata keys with what the storefront already
  reads for dispatched/delivered (check during build) so no storefront change.

## Non-goals (this batch)
Returns, refunds (later batch); native Medusa fulfillment objects; changing the
order-cancel/reserved-release path (already handled by Fix 1).
