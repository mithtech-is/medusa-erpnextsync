# medusync ↔ Medusa — remediation change set

Self-contained, PR-ready capture of all connector remediation work
(2026-08-25 → 08-26). Verified live on the demo stack. **Demo sandbox +
medusync only; the real RISITEX repo is untouched. Not pushed anywhere.**

This is captured as its own folder+git repo because the pieces live in three
places that can't be committed together cleanly: the generic plugin folder is
not a git repo, the medusync Frappe app in the WSL bench has no git, and the
`risitex-mainb2b` sandbox repo carries unrelated pre-existing churn.

## Layout
- `docs/` — every design/spec/results/audit doc:
  - `INTEGRATION_AUDIT_REPORT.md` (the full audit + production verdict)
  - `INTEGRATION_AUDIT_REPORT_V2.md` (post-remediation re-audit; verdict
    CONDITIONAL — no CRITICAL blockers remain)
  - Wallet Settlement: `WALLET_SETTLEMENT_SYNC_{DESIGN,PLAN,RESULTS}.md`
  - Inventory: `INVENTORY_SYNC_{DESIGN,PLAN,RESULTS}.md`
  - Critical fixes: `CRITICAL_FIXES_DESIGN.md`
  - Reverse path: `REVERSE_PATH_DESIGN.md`
  - Returns/Refunds: `RETURNS_REFUNDS_DESIGN.md`
  - Pricing/B2B: `PRICING_B2B_DESIGN.md`
- `plugin/` — the changed generic-plugin files (whole copies): `registry.ts`,
  `index.ts`, `admin/routes/erpnext/page.tsx`, and the retry API route
  `api/admin/erpnext/events/[event_id]/retry/route.ts`.
- `sandbox/` — new `wallet_settlement` module, admin API routes, admin page,
  `lib/emit-ws-event.ts`, seed. (Modified in place, described below:
  `medusa-config.ts` — register `wallet_settlement` module + `cookieOptions:
  {secure:false, sameSite:"lax"}`; `src/scripts/seed-erpnext-demo.ts` — `const
  cur: any` type fix.)
- `frappe/` — medusync handlers (`inventory.py`, `sales_financials.py`,
  `reverse.py`, `pricing.py`, patched `mapped.py`), patched `hooks.py`, and the
  setup/seed/patcher scripts (Custom Fields, Property Setter, mappings, pricing).

## What's included (by feature)

**Wallet Settlement two-way sync** — plugin `wallet_settlement` registry entity;
sandbox module+routes+admin page; `mapped.py` cancel-not-delete; `Cancelled`
status Property Setter; Medusync Mapping seed. (Route→ERPNext push is a direct
`pushViaMapping` call — see `WALLET_SETTLEMENT_SYNC_RESULTS.md` for why events
don't fire from a plain route.)

**Inventory (stock-level) sync** — plugin `inventory.level.set` handler
(auto-creates + links an inventory item when missing); medusync
`handlers/risitex/inventory.py` (SLE + Sales Order hooks → `sellable =
actual − reserved − safety`); `inventory_source_warehouse` setting.

**Critical commerce-correctness fixes**
- Fix 1 overselling: sellable push + Sales-Order reservation trigger.
- Fix 2 product sellable: `registry.ts` product upsert makes a published
  simple product with `variant.sku = handle`; inventory handler creates+links
  the inventory item.
- Fix 3 order financials: `augmentSalesDocPayload` (addresses, tax/discount/
  shipping/grand totals, payment ref) + `sales_financials.py::apply_financials`
  (Address docs, tax+shipping charge rows, discount, payment Custom Fields).
- Order fetch: order `fetchById` rewritten to `query.graph` (+ grand total from
  `summary`, financials derived so grand_total always reconciles).

**Reverse path (ERPNext → Medusa order metadata)** — plugin `order.fulfilled` /
`order.tracking` / `order.invoiced` cases + `_mergeOrderMeta`; medusync
`handlers/risitex/reverse.py` (Delivery Note / Shipment / Sales Invoice hooks).

**Returns & Refunds (both directions)** — plugin `order.returned` /
`order.refunded` cases (→ `_mergeOrderMeta`). `reverse.py` return branches:
return Delivery Note (`is_return`) → `order.returned` with **receipt-gated**
stock restore (no double-count); Credit Note Sales Invoice → `order.refunded`
(record-only — the integration moves no money by design). A Medusa-initiated
return request calls `create_pending_return` → a **draft** return DN awaiting
warehouse receipt. (See `RETURNS_REFUNDS_DESIGN.md`.)

**Pricing & B2B (ERPNext → Medusa; ERPNext price always wins)** — plugin
`variant.price.set` (creates + links a price set on first price, else updates;
expired/deleted → clears), `variant.meta.set` (MOQ), `customer.group.set`
(finds/creates group + adds member, idempotent). medusync
`handlers/risitex/pricing.py`: Item Price (selling list only) → `variant.price.set`;
Item `min_order_qty` → `variant.meta.set`; Customer group link →
`customer.group.set`. Setup: `frappe/pricing_setup.sh`,
`frappe/pricing_patch_hooks.py`. (See `PRICING_B2B_DESIGN.md`.)

**Housekeeping** — plugin `retryEvent(eventId, scope?)` fixed both replay
defects: outbound mapped rows replay via `pushViaMapping` (re-runs the mapping
transform, not a stale full-payload `forwardEvent`); inbound rows re-apply via
`dispatchInbound(..., scope)` instead of being mis-pushed outbound. The retry
API route now passes `req.scope`. Duplicate/broken Medusync Mappings removed
(kept a single `Customer ↔ Customer`). Re-audit in
`INTEGRATION_AUDIT_REPORT_V2.md`.

**Ops** — `hooks.py` also comments the Procfile `schedule:` line note; admin
login fixed via `cookieOptions` (see `medusa-config.ts` note above).

## Apply order (fresh env)
1. Plugin: apply the 3 files → build via the `pluginbuild` junction → copy
   `.medusa` into `node_modules/medusa-plugin-erpnext` → `medusa build` → start.
2. Sandbox: add the module/routes/page/lib + the 2 `medusa-config`/seed edits →
   `db:migrate` → build.
3. Frappe: copy the 4 handlers into `handlers/risitex/`; apply `hooks.py`; run
   the setup scripts (Custom Fields, Property Setter, mappings); restart bench
   (Procfile `schedule:` commented).

## Status
All features verified live (see each `*_RESULTS.md` and
`INTEGRATION_AUDIT_REPORT_V2.md`). **Not committed to the real repos, not
pushed.** Returns/Refunds, Pricing/B2B core, and the retry/mapping housekeeping
are now included. Remaining (non-CRITICAL, per V2 audit): advanced/B2B pricing
depth (MRP / wholesale / dealer / tiers / per-group price lists), rich product
attributes, customer address + GSTIN outbound, reconciliation breadth, and the
Medusa-initiated return-request last-mile trigger.
