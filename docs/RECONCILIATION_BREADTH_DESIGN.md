# Reconciliation breadth (Medusa ↔ ERPNext)

Closes audit gap #18 (reconciliation was customer-only, count-based).
Built + verified live on the demo stack, 2026-08-26.

## Before

`countMappingRows` was hard-gated to `medusa_entity === "customer"` and
compared only **row counts**, and the eligibility gate it used
(`metadata.kyc_fully_approved_at`) is a Polemarch concept that is **empty on
this RISITEX site** (0/90 customers) — so the customer reconcile had been
silently comparing an empty set. The hourly cron therefore reconciled nothing
meaningful, and there was no way to see *which* rows diverged.

## After

A generic, **detail-level** reconcile for the three reconcilable entities —
**customer, product, order** — surfaced both on the hourly cron and on-demand
from the admin UI. Report-only; changes nothing on either side.

### Matching (the crux)

Compare the stable Medusa `id` against the ERPNext `medusa_*_id` the mapping
stamps (from the mapping's id pair), **with a natural-key fallback**:

- product: `handle ↔ item_code`
- customer: `email ↔ email_id`
- order: id-pair only (`medusa_order_id` is its one true key)

The fallback is essential: catalogue products pulled ERPNext→Medusa never stamp
their Medusa id back onto the Item, so id-pair-only diffing would report *every*
catalogue product as missing. With the fallback, product `missing_on_frappe`
dropped from ~18 false positives to **1** genuine Medusa-only item.

Per entity the report returns: `medusa_count`, `frappe_count`, `matched`,
`missing_on_frappe` (in Medusa, not in ERPNext — capped id list + count),
`frappe_orphans` (ERPNext docs stamped with a Medusa id Medusa no longer has),
and a `truncated` flag.

### Surfaces

- **Plugin**: `reconcileMapping(mapping, container)` (per entity) and
  `reconcileAll(container)` (loops enabled mappings, one report per reconcilable
  entity; non-reconcilable ones — e.g. the append-only Stock Ledger Entry —
  return `skipped: "not-reconcilable"`, never silently dropped).
- **Admin route**: `GET /admin/erpnext/reconcile?limit=&sample=` → `reconcileAll`.
- **Admin UI**: a **Reconcile** tab on the ERPNext admin page — one "Reconcile
  now" button, a plain per-entity table (counts + In-sync/Drift status), and
  click-to-expand the specific diverging ids. Built for a non-technical admin.
- **Cron**: the hourly `erpnext-reconciliation` job now runs the detailed
  reconcile across all reconcilable entities (not just customer) and writes a
  `reconciliation.drift` sync event (with **capped** id lists, to keep event
  rows small) when drift > 5%.

### Bounds / safety

- Per-side row cap (default 2000, max 10000 via `?limit`) with a `truncated`
  flag — never an unbounded `limit_page_length=0`.
- Per-mapping try/catch — one doctype failure doesn't kill the whole report.
- Embedded id lists capped (100 in the report, 25 in cron event payloads).

## Verified live (E2E)

`reconcileAll` against real demo data, run twice → **identical** (read-only):

| Entity | Medusa | ERPNext | matched | missing_on_frappe | frappe_orphans |
|---|---|---|---|---|---|
| customer | 52 | 83 | 46 | 6 | 15 |
| order | 15 | 19 | 14 | 1 | 3 |
| product | 40 | 44 | 39 | 1 | 4 |

- Customer shows **real numbers** (the dead KYC gate is gone).
- Product `missing_on_frappe` = **1** (natural-key fallback working, not ~18).
- `SAL-ORD-2026-00021` (whose `medusa_order_id = PENDING-RET-TEST-1` is not a
  live Medusa order) correctly appears in order `frappe_orphans`.

## Scope

Report-only for all entities (no auto-recovery beyond the pre-existing,
now-inert customer recovery pass). Inventory is quantity-drift, not presence,
and is intentionally out of scope here.
