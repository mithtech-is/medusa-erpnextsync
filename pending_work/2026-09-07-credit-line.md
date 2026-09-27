# Credit line sync

**Status:** decided and built, 2026-09-27. The line of credit is ERPNext's;
the store draws on it at checkout and follows it, and keeps no ledger.
**Side:** both. The ERPNext side is the Frappe `lending` app through
`customer_wallet`; the store side is `@mithtech-medusa/wallet-loc`'s
`providers/wallet-loc-credit`.

## What exists now

**ERPNext.** One `Loan` per customer on the company's *Line of Credit*
product: `maximum_limit_amount` / `available_limit_amount` /
`utilized_limit_amount`, limit changes logged in `Loan Limit Change Log`,
drawdowns as `Loan Disbursement` into the wallet, repayments as `Loan
Repayment` out of it. `idempotency_key` (unique), `origin` and `medusa_id` on
all three. Wrappers where REST cannot be atomic:
`customer_wallet.api.credit.get_credit` / `open_credit_line` /
`set_credit_limit` / `draw` / `repay_from_wallet`.

**Medusa.** The three tables this file mentioned (`credit_line`,
`credit_terms`, `order_credit_line`) are not used and not the model. The store
holds the ids of what it did on the payment session, and a 60 s in-memory
cache of the summary for `GET /store/wallet/credit`. That is all.

## The seam, as built

- **A stable id on each side.** `Loan.medusa_id` = the Medusa customer id
  (stamped by this plugin when a Loan webhook arrives, or by the store when
  it opens nothing — the store never opens lines). `erpnext_link` pairs
  `Loan` ↔ customer (`medusa_entity: credit_line`). Every draw carries the
  store's session key (`<session>:credit`) and `medusa_id`.
- **One document per event.** A draw is a `Loan Disbursement`, a repayment a
  `Loan Repayment`, a limit change a `Loan Limit Change Log` row — all
  ERPNext's. The store adds none.
- **Minor units, explicit currency.** Converted at the REST edge only.
- **An idempotency key per transaction.** `draw` and `repay_from_wallet`
  replay a repeated key (`replayed: true`) and post nothing; the unique
  column refuses a duplicate even through `/api/resource`.
- **Which side originated a movement.** `origin: Medusa` on every draw and
  repayment the store makes; the wallet rows they produce are excluded from
  the `Wallet Transaction` webhook by its condition.

## Decided

### The shape of the ERPNext side (Q1)

> **Answer:** the `lending` app's Loan, through `customer_wallet`. Built.

### Which side owns the balance (Q2)

> **Answer:** ERPNext, entirely. The store reads `available_limit_amount`
> through a cache and lets the draw validate the real limit.

### One entity or two (Q3b)

> **Answer:** Two. A wallet is money held, a credit line is money owed;
> they reconcile differently.

Built as two: the wallet is mirrored row for row
(`2026-09-04-wallet-sync.md`); the credit line is followed, not mirrored —
a `Loan` webhook (`on_update` / `on_submit` / `on_cancel`, customers only)
pairs it and emits `erpnext.credit_line.updated` so the store's cache
refreshes.

## How a checkout draws (for the record)

`wallet-loc-credit` at authorise: wallet part first (promo up to the cap,
then main, all or nothing); the remainder drawn (`draw`), mirrored into the
store wallet (`grant_credit`, paired with ERPNext's `Wallet Deposit` by
`medusa_id`) and debited (`order_debit`, which this plugin pushes as a *Buy
Settlement*). Cancel reverses the wallet part, posts the drawn part back to
the ERPNext wallet first (`api.wallet.credit`, paired), then repays
(`repay_from_wallet`). Refunds credit the wallet; the draw stays owed until
repaid in ERPNext.
