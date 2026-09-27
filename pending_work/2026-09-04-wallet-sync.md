# Wallet sync

**Status:** decided and built, 2026-09-27 (`src/modules/erpnext/wallet-sync.ts`,
the wallet methods on the module service, `src/subscribers/wallet-forward.ts`,
`src/jobs/push-wallet-transactions.ts`, `rehearsal/wallet-credit.fixerp.spec.ts`).
**Side:** both. The ERPNext side is the `customer_wallet` Frappe app
(`frappe16/apps/customer_wallet`); the store side is `@mithtech-medusa/wallet-loc`.

## What exists now

**ERPNext.** `customer_wallet`: `Wallet` (`WAL-<customer>`, balances derived),
`Wallet Transaction` (append-only, submittable, reversal by compensating row,
`idempotency_key` unique), `Wallet Deposit` / `Wallet Withdrawal` (wallet leg +
Journal Entry, idempotent on the bank reference). Every one carries `origin`
(ERPNext / Medusa) and `medusa_id`. Wallet-leg-only writes for a connector:
`customer_wallet.api.wallet.credit` / `debit` / `reverse` (operator-only,
idempotent, 120/min). `Customer.wallet_balance_paise` is gone.

**Medusa.** `@mithtech-medusa/wallet-loc`: two-bucket ledger (`main`, `promo`),
`wallet_transaction` rows with a unique `idempotency_key`, `metadata`, the
service's `credit` / `debit` / `reverseDebit` / `freezeWallet`, events on the bus.

**The connector.** What this file asked for, the applications supplied, so the
seam is exactly the list below.

## The seam, as built

- **A stable id on each side, and a field to record the other's.**
  `erpnext_link` pairs the Wallet (`WAL-<customer>` ↔ the Medusa wallet id,
  also stamped on `Wallet.medusa_id`) and every row (`Wallet Transaction`
  name ↔ the Medusa row's key). ERPNext rows carry `medusa_id = <Medusa row id>`.
- **One document per movement, not a balance somebody edits.** Every
  main-bucket Medusa row becomes one `Wallet Transaction`; every ERPNext row
  becomes one Medusa row. Balances are never written.
- **Amounts in minor units with an explicit currency.** Minor units inside
  the plugin; converted to two-decimal rupees at the REST edge only
  (`majorToMinor` / `minorToMajor`). One currency per wallet on both sides.
- **An idempotency key per transaction.** Outbound: `medusa:<row key>` (or
  `medusa:wt:<row id>`); ERPNext replays a repeated key without posting.
  Inbound: `erpnext:wt:<name>`; the wallet replays it without posting.
- **A reversal that references what it reverses.** ERPNext's `Reversal` rows
  carry `reverses`; Medusa's carry `metadata.reversal_of`. Outbound reversals
  are posted as Adjustments with the reference in the remarks; inbound
  reversals land as `refund` credits with `metadata.reverses`.
- **Which side originated a movement.** `origin` on every ERPNext row; the
  webhooks are conditioned on `doc.origin != "Medusa"`, so no echo leaves
  ERPNext. A Medusa row written by an inbound apply is keyed `erpnext:` and
  linked at once, so no echo leaves Medusa.

## Decided

### What the ERPNext side of the wallet is (Q1)

> **Answer:** the `customer_wallet` app, as above. Built; the connector maps
> ERPNext transaction types to Medusa kinds and back (`wallet-sync.ts`).

### Which side owns the balance (Q2)

> **Answer:** Both with time stamp and if that doesn't resolve the conflict
> ERPNext's data takes precedence.

Applied as: each side appends its own rows in time order and the pairs decide
what has already travelled. The hourly reconcile compares the store's main
balance with `Wallet.balance_available`, allowing for rows still to push
(`lagging`); anything else is `drift`, reported on the Events tab as
`wallet.drift`, and **ERPNext's figure is the one to keep** — the correction
is an Adjustment posted in ERPNext, which then syncs down. The connector never
writes a balance to match.

### The leftover `Customer.wallet_balance_paise` (Q3)

> **Answer:** If anything exists, it will be related to the old work; remove
> it from both Medusa and ERPNext.

Nothing carries it any more: no Custom Field on fixerp, nothing in this
plugin or the wallet plugin reads it.

### One entity or two (Q3b)

> **Answer:** 2 in both the cases. In ERPNext let's have a setting called
> Wallet-LOC-balancer.

Two: the wallet is a ledger on both sides; the credit line is ERPNext's alone
(`2026-09-07-credit-line.md`). The balancer is the company's *Wallet Credit
Clearing* account in `customer_wallet`: the Loan's disbursement and repayment
account, mirrored into the wallet and netting to zero after every draw and
repayment — no separate setting was needed.

## Not synced, on purpose

- The **promo** bucket: store marketing credit, not money.
- The mirror of a **credit-line draw or repayment**: ERPNext posts that row
  itself (`Wallet Deposit` / `Wallet Withdrawal`, mode *Credit Line*) and pairs
  it by `medusa_id`.
- `Reservation` / `Reservation Release`: ERPNext's reserved bucket has no store
  counterpart, so they land as a debit and a credit of the available balance.
