# Wallet / store-credit sync (Medusa side) — deferred 2026-09-04

**Requirement.** Wallet transactions sync bidirectionally by default: ERPNext
wallet changes → Medusa, Medusa wallet changes → ERPNext. Fields: Customer,
Wallet ID, Currency, Balance, Transaction Type, Amount, Reference Type/ID,
Notes, Timestamp. Events: Deposit/Credit, Withdrawal/Debit, Payment, Refund,
Reversal.

**Why deferred.** The local sandbox has no wallet of its own any more: the
demo `wallet_settlement` module was removed from `risitex-mainb2b` and the
matching ERPNext doctype (`RISITEX Wallet Settlement`, from the uninstalled
`risitex_erp` app) is gone. Building the generic contract against nothing
real would only produce untested code.

**What exists today (keep as reference, do not ship as-is).**
- `src/modules/erpnext/registry.ts` still declares a `wallet_settlement`
  entity (RISITEX-specific; remove in the Phase 1 generic cleanup).
- `dispatchInbound` in `src/modules/erpnext/index.ts` carries Polemarch
  wallet handlers (`wallet.deposit.received`, `wallet.withdrawal.posted`,
  `wallet.*.canceled`) that resolve a `cashfree_wallet` module without
  guarding for its absence.
- `backend/` (in this repo) holds the sandbox `wallet_settlement` module,
  admin page, routes and seed that mirrored `RISITEX Wallet Settlement`
  two-way. `docs/WALLET_SETTLEMENT_SYNC_DESIGN.md` documents that design.

**Target design (Phase 3 slot).**
- A generic, opt-in `wallet_transaction` registry entity with a small
  adapter interface (`list`, `fetchById`, `apply`) that a project implements
  for its own wallet module; the plugin ships no concrete wallet.
- Mapping rows decide direction per site and per field like every other
  entity; amounts in minor units with an explicit currency.
- Idempotency on the wallet transaction id; reversals reference the original.

**Dependencies.** Phase 1 (envelope v2, mapping model v2, handler packs as
opt-in plugins). A sandbox wallet implementation to test against.
