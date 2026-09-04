# What an order's payment status actually means

**Deferred from:** Phase 3 (order source and payment metadata)
**Belongs to:** whenever somebody decides the question below; no phase depends on it
**Side:** both. This file is the Medusa half; `medusync/pending_work/` holds the
ERPNext half, which is where the figure is computed.

## What ships today

`order.source.set` carries a `payment` object, and the plugin drops it into
the order's metadata under `erp_order.payment`:

```json
{ "method": "cod", "reference": null, "currency": "INR",
  "total": 1000.0, "paid": 750.0, "outstanding": 250.0, "status": "part_paid" }
```

`status` is one of `paid`, `part_paid`, `unpaid`.

## What is wrong with it

The figure is computed from the Sales Order alone: `grand_total` minus
`advance_paid`. That is money received **against the order itself**. An
order settled the ordinary way — Sales Order, then Sales Invoice, then
payment allocated to the invoice — has `advance_paid` of zero, so
`erp_order.payment.status` says `unpaid` for an order that is fully paid.

It is corrected a moment later: `order.invoiced` carries the invoice's own
`Paid` / `Unpaid`, derived from `outstanding_amount`, and lands under
`erp_order` → no, under `invoice`. So the storefront holds two payment
opinions in two metadata keys, and the fresher one is not always the more
correct one.

`erp_payments` is unaffected and is the reliable figure: it accumulates
actual Payment Entry receipts and `erp_payments_total` is what was really
received. A storefront that needs one number should read that.

## What would fix it

Fold the invoice into the status. `payment_of(doc)` would have to consider
the Sales Invoices raised against the order and their `outstanding_amount`,
not just the order's advance.

## The decision that has to be made first

Which document is the payment authority when both exist. Three defensible
answers and they are not equivalent:

- **The invoice, when there is one.** Matches how accounts think. Means the
  status flips to `unpaid` at the moment the invoice is raised and before
  payment lands, which reads as a regression to anyone watching.
- **The sum of Payment Entry receipts against either.** Truest to the money,
  and it is already computed (`erp_payments_total`). Means the status
  ignores credit terms entirely.
- **Both, reported separately.** `ordered_vs_received` and `invoiced_vs_paid`.
  Honest, and pushes the choice onto whoever writes the storefront.

Until that is settled, `payment_of` is documented in the code as
advance-based rather than quietly wrong.
