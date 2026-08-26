# Wallet Settlement two-way sync — design

**Date:** 2026-08-25
**Scope:** Add `RISITEX Wallet Settlement` (ERPNext) ↔ a new `wallet_settlement`
Medusa module as a first-class, two-way synced entity in the generic medusync
connector. Demo sandbox only (`00-medusa/…/risitex-mainb2b` + the generic
plugin in `000-medusa-plugins&extensions`). **The real RISITEX repo is not
touched.**

## Goal / success criteria

An operator can create, edit, and cancel a wallet settlement on **either**
side and see it reflected on the other within seconds — the same experience
Customers and Items already have. Verified end-to-end:

- Create in Medusa → appears in ERPNext as a `RISITEX Wallet Settlement`.
- Create in ERPNext → appears in Medusa.
- Edit either side (amounts / status) → propagates.
- Cancel/delete either side → the record is **preserved** and marked
  `Cancelled` on both sides (never destroyed).
- All rides on the existing HMAC signing, `ts` replay window, and `event_id`
  idempotency — no new security surface.

## What syncs (agreed scope: "Record + status")

| Field (Medusa) | Field (ERPNext) | Direction | Notes |
|---|---|---|---|
| `settlement_batch_id` | `settlement_batch_id` | both | **Natural key.** ERPNext autonames on it. |
| `period_from` | `period_from` | both | Date (ISO string). |
| `period_to` | `period_to` | both | Date. |
| `total_credits` | `total_credits` | both | Amount in **rupees** (plain number), no paise transform. |
| `total_debits` | `total_debits` | both | Rupees. |
| `net_amount` | `net_amount` | both | Rupees. |
| `currency` | `currency` | both | e.g. `INR`. |
| `status` | `status` | both | `Pending` / `Posted` / `Failed` / **`Cancelled`** (new). |
| `id` (Medusa) | `medusa_settlement_id` | push only | Link-back, like `medusa_customer_id`. |

**Out of scope:** the ERPNext `journal_entry` link and the finance posting
workflow stay ERPNext-only (not synced).

## Decisions

- **Direction:** two-way (parity with Customer/Item).
- **Editable both sides:** finance can originate a settlement in ERPNext; an
  operator can originate one in Medusa via a new admin page.
- **Amounts:** stored in the same unit as ERPNext (rupees) as plain numbers.
  Avoids the paise↔rupees trap that bites order line items. No transform.
- **Safe delete = mark `Cancelled`, never destroy.** Add `Cancelled` to the
  status Select on the ERPNext doctype and to the Medusa enum. A delete/cancel
  on either side sets `status = Cancelled` (and soft-deletes on the Medusa
  side); the row is kept on both sides. Honors the standing safe-delete rule.
- **Key:** `settlement_batch_id` on both sides. Medusa's own `id` is stamped
  into `medusa_settlement_id` on push for the link-back.

## Components (each independently testable)

### 1. Medusa `wallet_settlement` module (sandbox)
`risitex-mainb2b/apps/backend/src/modules/wallet_settlement/`
- `models/wallet-settlement.ts` — `model.define("wallet_settlement", { … })`
  with the fields above; `status` enum incl. `cancelled`.
- `service.ts` — extends the Medusa service factory; **overrides create /
  update / delete to emit `wallet_settlement.created|updated|deleted`** on the
  event bus (core modules emit automatically; a custom module must do this
  itself, or the forward-subscriber has nothing to forward).
- `index.ts` — module export; registered in `medusa-config.ts` modules{}.
- A migration for the table.

### 2. Connector entity (generic plugin)
`…/medusa-plugin-erpnext-generic/src/modules/erpnext/registry.ts`
- One `genericEntity({ key: "wallet_settlement", label: "Wallet Settlement",
  moduleName: "wallet_settlement", modelName: "WalletSettlement",
  events: ["wallet_settlement.created","…updated","…deleted"],
  default_key_path: "settlement_batch_id", paths: […],
  disableByKey: set status="cancelled" (selector form, not array form) })`.
- Added to the exported registry map. No other plugin sync code changes — the
  generic inbound (`_applyInboundViaMappings`) and outbound (`pushViaMapping`)
  paths already handle any registered entity.
- Confirm the forward-subscriber (`subscribers/erpnext-forward.ts`) subscribes
  to the new entity's events (it derives its event list from the registry /
  mappings — verify during implementation).
- Add `wallet_settlement` to the editor's `ENTITY_DOCTYPE_SUGGESTIONS`
  (→ `RISITEX Wallet Settlement`) so the mapping UI auto-shortlists it.

### 3. ERPNext side (Frappe medusync)
- **Custom Field:** add `Cancelled` to `RISITEX Wallet Settlement.status`
  options (via a fixture / `bench` custom-field script — not editing the app's
  own doctype JSON, since it's the `risitex_erp` app).
- **Medusync Mapping** row `Wallet Settlement ↔ Medusa`:
  `document_type = RISITEX Wallet Settlement`, `direction = Both`,
  `key_field = settlement_batch_id`, field map for the synced fields,
  `docevents = after_insert / on_update / on_trash`, `allow_insert/allow_update
  = 1`, `allow_delete = 0` (delete arrives as a cancel, handled in the risitex
  mapped handler).
- The medusync **risitex mapped handler** already does safe-delete
  (cancel/disable); extend it so a delete for this doctype sets
  `status = Cancelled` instead of `frappe.delete_doc`.

### 4. Seeds
- Extend `seed-erpnext-demo.ts` to add the plugin-side mapping.
- A `bench` seed for the Medusync Mapping + the `Cancelled` custom field, so a
  fresh demo has it wired.

## Data flow

**Medusa → ERPNext:** create/edit/cancel a settlement → service emits event →
forward-subscriber → `pushViaMapping` builds the signed envelope → medusync
`receive_mapped` → risitex mapped handler upserts the `RISITEX Wallet
Settlement` by `settlement_batch_id`, stamps `medusa_settlement_id`. Cancel →
handler sets `status = Cancelled`.

**ERPNext → Medusa:** `after_insert`/`on_update`/`on_trash` on the doctype →
medusync `outbound.on_doc_event` (mapping now exists) → signed POST to the
plugin `/webhooks/erpnext-inbound` → `_applyInboundViaMappings` upserts the
Medusa `wallet_settlement` by `settlement_batch_id`. `on_trash`/cancel →
`disableByKey` sets Medusa `status = cancelled` + soft-delete.

## Error handling
- Reuses the connector's existing per-event log + retry (plugin Events tab for
  Medusa→ERPNext; Frappe **Medusync Log** for ERPNext→Medusa).
- Loop prevention: `frappe.flags.medusync_inbound` (Frappe) + `event_id`
  idempotency (Medusa) already cover the round-trip.
- Amount/currency validation: reject non-numeric amounts server-side with a
  clear message rather than a 500.

## Testing (end-to-end, real HMAC)
1. Create in Medusa admin → assert `RISITEX Wallet Settlement` row with matching
   figures + `medusa_settlement_id`.
2. Create in ERPNext → assert Medusa `wallet_settlement` row.
3. Edit amount + status each side → assert propagation.
4. Cancel each side → assert `status = Cancelled` on **both**, row still present.
5. Idempotency: replay one envelope → "already applied", no duplicate.
6. Regression: Customer + Item round-trips still green.

## Non-goals
- No Journal Entry / posting-workflow sync.
- No paise↔rupees conversion (amounts are rupees both sides).
- No changes to the real RISITEX repo; no auto-commit/push (awaiting go-ahead).
