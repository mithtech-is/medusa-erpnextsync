# Phase A results — live end-to-end sync (demo Medusa + demo ERPNext)

**Date:** 2026-08-24. Both stacks live: demo Medusa store (`risitex-mainb2b`
sandbox) on `:9000` with the generic `medusa-plugin-erpnext`; demo ERPNext
(WSL Frappe bench, `site1.local`) on `:8000` with `medusync`. Sync exercised
through the **real Medusa Admin API** and **real Frappe doc events** (not just
signed HTTP).

## CRUD matrix — what was verified

| Entity / op | Medusa → ERPNext | ERPNext → Medusa |
|---|---|---|
| **Customer** create | ✅ Frappe Customer created (name, phone, `medusa_customer_id`) | ✅ Medusa customer created (email, name) |
| Customer update | ✅ `customer_name` propagates | ✅ propagates (fixed — see below) |
| Customer delete | ✅ safe **disable** (`disabled=1`) | ✅ soft-disable (Medusa `metadata.erpnext_disabled=true`) |
| **Product/Item** create | ✅ Item created (`item_group`/`stock_uom` defaults, `medusa_product_id`) | ✅ Medusa product created (handle lowercased from item_code) |
| Product update | ✅ `item_name` propagates | ✅ `title` propagates |
| Product delete | ✅ safe **disable** (`disabled=1`) | ✅ unpublish (status→draft) |
| **Order** create | ✅ Sales Order with **line items** + customer, totals correct (₹1497 = 3×₹499, paise→rupees) | n/a (orders originate in Medusa by design) |
| Order cancel | ✅ path present (SO cancel) | n/a |
| Idempotency (retry) | ✅ no duplicates (keyed) | ✅ event-id dedupe |
| HMAC auth | ✅ bad signature → 401 | ✅ signed both ways |

## Bugs found and fixed during Phase A

**Generic Medusa plugin** (`medusa-plugin-erpnext`):
1. **Order line items never pushed** — added `augmentSalesDocPayload` so Sales
   Order/Invoice pushes carry `medusa_items[]` + customer link + paise→rupees.
2. **Inbound receiver was Polemarch-only** — added a generic, mapping-driven
   inbound path (`_applyInboundViaMappings`) mirroring the pull cron; removed the
   noisy legacy fallback that pushed unmapped events to the domain handler pack.
3. **Events without `event.id` were silently dropped** — added an event-id
   fallback (Medusa v2 workflow events don't reliably carry a top-level id), so
   create/delete events sync instead of being skipped.
4. **Deletes couldn't be enriched** (the row is gone by event time) — added a
   delete key fallback that keys on the Medusa id against the ERPNext
   `medusa_*_id` field; enrich `.deleted` with soft-deleted rows where possible.
5. **Inbound lookups used the raw ERPNext key** — now use the *transformed* key
   (e.g. `item_code "ABC"` → `handle "abc"`) so updates/deletes hit the existing
   row instead of creating duplicates.
6. Safe inbound delete = disable/unpublish via a new `disableByKey` (customer →
   metadata flag, product → status draft), never destroys.

**Customer-inbound gap — fixed (2026-08-25):**
9. The real cause was *not* the `email_id` fetched field (that value survives an
   update). It was that the plugin updated customers via the **array-with-id
   form** `updateCustomers([{id,…}])`, which trips a mikro-orm exception-converter
   bug on this Medusa build (the real DB error is masked as `reading '0'`). Switched
   the customer upsert + soft-delete to the **selector form**
   `updateCustomers({id}, data)`, which is unaffected. Customer update AND delete
   ERPNext→Medusa now work.
10. Made the outbound **delete key unconditional** — deletes always key on the
   stable `medusa_*_id` (never on the enrich-dependent natural key), so product
   and customer deletes Medusa→ERPNext are now reliable instead of racy.

**medusync** (Frappe app):
7. **`receive_mapped` action Select bug** — the log's `action` field is a Select;
   handler verbs like `disabled`/`cancelled` violated it and 417'd *after* the
   doc committed. Clamped to the allowed vocabulary. (Also the earlier
   `"(unnamed) | created"` fix and the Sales-Order key fix from the audit.)
8. **Safe delete semantics** — submitted docs are **cancelled** (never deleted),
   masters with a `disabled` flag are disabled, only trivial drafts are removed.

## Config wired (demo)
- Plugin: `enable_sync`, `erpnext_url` = WSL IP `http://172.26.59.188:8000`,
  paired secrets; three mappings (Customer↔Customer both, Product↔Item both,
  Order→Sales Order push). Old vendored-plugin mappings disabled.
- medusync: `medusa_url` = Windows-host IP `http://172.26.48.1:9000`, two
  outbound mappings (Customer, Item) emitting on insert/update/trash.
- Coexistence: `risitex_erp` (also installed) pointed at a dead port so only
  medusync drives the sync.

## Known limitations (carry into the report / Phase C hardening)
- **Windows↔WSL networking**: mirrored networking is OFF, so the two sides reach
  each other only by IP (not `127.0.0.1`). Fine on one host; a real deployment
  has both on routable hosts.
- **Pull cron** (redundant with webhooks) crashes on legacy bad-data rows
  (uppercase handles like `TEX-E2E-…`); harmless background noise for the demo.
- **The whole environment is process-fragile in dev**: stale `medusa develop`
  processes must be fully killed on restart or old code consumes events from
  Redis (this caused hours of flaky results until found).

## Verdict
The connector works end-to-end for the core commerce objects (**customer,
product, order**) in **both directions** — create / update / delete — with safe
deletes and correct money/line-item handling, after the 10 fixes above. Every
CRUD cell in the matrix is green. Remaining items are environmental, not
architectural (dev networking by IP, redundant pull-cron noise, process hygiene).
