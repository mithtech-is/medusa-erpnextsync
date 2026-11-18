# medusa-erpnextsync: handoff

Updated 2026-11-19.

## What it is

`@mithtech-medusa/plugin-erpnext`: a Medusa v2 plugin that keeps a Medusa store in step with a Frappe/ERPNext v16 site.
ERPNext is the source of truth for catalogue, stock and price.
Inbound uses Frappe core Webhooks plus a `medusa_sync` field. Outbound pushes use REST.

## State

- Default branch: `main` (v0.7.2, in sync with `origin/main`).
- Work on `wip`. Ship with `git ship`.
- Gate: `npm run typecheck`, then `npm test`. Run `npm run rehearsal` against an ERPNext site when the change touches sync.
- Deploy: publish to the private registry npm.po5.in (Verdaccio). Needs a yes per release.
- Last notable work (`git log main`):
  - `cea753d` GrowthBook rollout wave 1 merged.
  - `081c907` / `e1c40b2` release 0.7.2 (sync audit fixes).
  - `1c77c10` release 0.7.0: Item Group tree as categories, wallet sync.
  - `df5706c` release 0.6.5: gateway settlements booked in ERPNext.
  - `0e93a21` release 0.6.4: orders and payments booked in ERPNext.
- Done since the old handoff: the 0.6.4 and 0.6.5 branches and the wallet and credit-line work are on `main`. The old `main` push rejection is resolved. The two `.wt-erpnext-*` worktrees are gone.

## Open work

- Pending design work: 17 topic files in `pending_work/`. Start with `pending_work/00-QUESTIONS-ANSWER-THESE-FIRST.md`. Do not implement a topic while its question has no answer.
- Order payment status (`pending_work/2026-09-05-order-payment-status.md`): question Q8 is open. An order paid through a Sales Invoice reads `unpaid` today. Use `erp_payments_total` meanwhile.
- Payments and settlements: check that npm.po5.in serves 0.7.2 and that Splendx and mithtech-apparel-in pin it. Publish the next release only after a yes.
- Local setup on a new Mac: recreate `~/.npmrc` with the npm.po5.in token by hand. Never commit the token.
- Rehearsal site: `fixerp.localhost` in `Coding/frappe16`. Restore it from its dump before `npm run rehearsal`.

## Env vars (names only)

`ERPNEXT_URL`, `ERPNEXT_API_KEY`, `ERPNEXT_API_SECRET`, `ERPNEXT_FRAPPE_WEBHOOK_SECRET`, `MEDUSA_BACKEND_URL`, `INVENTORY_LOCATION_ID`, `ERPNEXT_PAUSE_PUSH`.
Rehearsal only: `ERPNEXT_TEST_CUSTOMER`. Values live in the host project's `.env`.

## Read next

- `README.md`: install, sync setup, mapping rehearsal, layout.
- `pending_work/README.md` and `pending_work/00-QUESTIONS-ANSWER-THESE-FIRST.md`.
- `pending_work/done/`: closed wallet-sync and credit-line topics.
- `CHANGELOG.md`: release history.
- `docs/` (`OPERATIONS.md`, `LOCAL_DEV.md`, `RESUMING-ON-ANOTHER-MACHINE.md`).
