# Returns + Refunds — design

**Date:** 2026-08-26. Remediates audit #14 (returns) + #15 (refunds).
Both directions; refund is **record-only** (no money moved by the integration).
Demo sandbox + medusync only; RISITEX repo untouched. Stored on order metadata.

## Part A — ERPNext → Medusa (return receipt + refund)
Extends the existing reverse hooks (`handlers/risitex/reverse.py`).
- **`on_delivery_note`**: when `doc.is_return` → push **`order.returned`**
  `{status: "received"|"cancelled", items:[{sku,qty(abs)}], return_against,
  received_at}` (instead of `order.fulfilled`). Resolve order via the return
  DN's `return_against` → original DN → `against_sales_order` → SO →
  `medusa_order_id` (fallback: the return DN item `against_sales_order`).
  **Stock restore is automatic** — submitting the return DN increments
  `Bin.actual_qty`, and the existing inventory SLE hook re-pushes sellable. So
  stock is only restored on receipt (submit), never on the pending request.
- **`on_sales_invoice`**: when `doc.is_return` (Credit Note) → push
  **`order.refunded`** `{credit_note: name, amount: abs(grand_total),
  date, currency, status: "Credited", reason}` (instead of `order.invoiced`).
  Record only.
- **Plugin** `dispatchInbound`: new cases `order.returned` → merge
  `order.metadata.return`, `order.refunded` → merge `order.metadata.refund`
  (via `_mergeOrderMeta`).

## Part B — Medusa → ERPNext (customer return request → pending, gated)
- **Forward-subscriber**: subscribe to the Medusa return-requested event
  (verify exact name at build: `order.return_requested` / `return.created`) →
  push **`return.requested`** `{medusa_order_id, items:[{sku, qty, reason}]}`.
- **medusync** new handler (dispatched from `receive`/`receive_mapped` or a
  dedicated whitelisted method) `create_pending_return`: resolve the SO by
  `medusa_order_id` and the latest submitted Delivery Note for it; create a
  **DRAFT return Delivery Note** (`is_return=1`, `return_against` = that DN,
  negative qty for the returned skus). **Draft → zero stock impact** (the gate).
  Ops reviews and **submits on physical receipt**, which fires Part A's
  `on_delivery_note` → `order.returned` + stock restore.
- **Plugin**: emit `return.requested` on the Medusa return event; sign+push via
  the existing pipe.

## Metadata shape (on the Medusa order)
- `metadata.return = {status, items, return_against, received_at}`
- `metadata.refund = {credit_note, amount, date, currency, status, reason}`

## Gating & safety
- Stock restored ONLY when the return DN is submitted (receipt), never on
  request (draft). Satisfies "do not restore stock until ERPNext confirms
  receipt/acceptance."
- Refund is a Credit Note (accounting doc) + metadata; the integration never
  initiates a payment reversal. Finance issues the actual refund.
- Idempotent: return DN / credit note names are unique → event_id dedup; the
  pending-return create is keyed so a replayed request doesn't duplicate the DN.

## Non-goals
No automated payment-gateway refund; no partial-return proration UI; no
inspection-workflow doctype (acceptance = submitting the return DN).
