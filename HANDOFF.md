# Handoff: medusa-erpnextsync (2026-10-18)

Status: **active**. Written for the move of this SSD to the new Mac mini (paths unchanged).

## What it is

`@mithtech-medusa/plugin-erpnext`: a Medusa v2 plugin that keeps a Medusa store in step with a Frappe/ERPNext v16 site, with ERPNext as the source of truth for catalogue, stock and price. Nothing is installed on ERPNext: inbound uses Frappe core Webhooks plus a `medusa_sync` field (created by the admin action "Set up ERPNext"); outbound pushes go over REST. It replaced the retired Frappe app `medusync` (2026-09-26). It also syncs the customer wallet and the line of credit (Frappe `customer_wallet` and `lending` apps), orders/payments and gateway settlements.

See also `docs/RESUMING-ON-ANOTHER-MACHINE.md`, `docs/LOCAL_DEV.md`, `docs/OPERATIONS.md`.

## Stack and pinned versions

- Medusa v2 plugin. devDependencies `@medusajs/*` `^2.21.0`; peers `^2.19.0`. React `^18.2.0`. TypeScript, vitest, yalc.
- npm with `package-lock.json`.
- **No Node version pinned**: no `.nvmrc`, `.node-version`, `.tool-versions`, `engines` or `packageManager`. Hosts use Node `^20.19.0 || >=22.12.0`.
- Published to the private registry **npm.po5.in** (Verdaccio). Installing/publishing `@mithtech-medusa/*` needs `~/.npmrc` with an npm.po5.in token on the new Mac (the old Mac's `~/.npmrc` set `registry=https://npm.po5.in/`). The token is a secret; recreate it by hand.

## Commands

```bash
npm install
npm run typecheck     # app + specs
npm test              # vitest, no DB or Medusa needed
npm run build         # medusa plugin:build -> .medusa/
npm run dev           # medusa plugin:develop (pushes into a host via yalc)
npm run rehearsal     # live test against an ERPNext site (needs ERPNEXT_* env, see below)
```

The plugin has no dev server of its own. Run a host Medusa (Neutral-Medusa, mithtech-apparel-in or Splendx) to try it; per `Coding/CLAUDE.md` run that host's dev server on the home cluster with `offload run --detach -- <cmd>` when the cluster is reachable.

## Env vars (names only)

Read by the code or declared in `factory.extension.yaml`: `ERPNEXT_URL`, `ERPNEXT_API_KEY`, `ERPNEXT_API_SECRET`, `ERPNEXT_FRAPPE_WEBHOOK_SECRET`, `MEDUSA_BACKEND_URL`, `INVENTORY_LOCATION_ID`, `ERPNEXT_PAUSE_PUSH`. Rehearsal only: `ERPNEXT_TEST_CUSTOMER`. No `.env` file in this repo; values live in the host project's `.env`.

## External services and local data

- ERPNext/Frappe v16 site with an API user (System Manager; Loan Manager for the credit rehearsal). Local test site: `fixerp.localhost` in `Coding/frappe16` (MariaDB dump `_f2c0aed802276022.sql.gz` in `_migration/db-dumps/mariadb/`). Production ERPNext: `erp.splendax.com`.
- No database of its own; it adds tables/migrations to the host Medusa's Postgres.
- Data home: local (no Offload profile).

## Work in progress

Branches (`git branch -vv`):

```
+ feat/gateway-settlements-0.6.5 df5706c (worktree ../.wt-erpnext-0.6.5) release: 0.6.5
+ feat/order-payments-0.6.4      0e93a21 (worktree ../.wt-erpnext-0.6.4) release: 0.6.4
* main                           bff8dd0 [origin/main: ahead 7, behind 9] Merge remote-tracking branch 'origin/main'
  feat/selection-none-0.6.2      a767696 release: 0.6.2
  feat/gst-india-compliance-0.6  a7c163e release: 0.6.1
  fix/sync-hardening-0.5.5       44a7881 [origin/fix/sync-hardening-0.5.5] release: 0.5.6
  feat/stock-and-prices          2238c25 release: 0.4.0
  feat/push-over-rest            4ac3669 manifest: 0.3.0
  feat/frappe-webhooks           acf3d97 [origin/feat/frappe-webhooks] release: 0.2.0
```

Last 5 commits on `main`:

```
bff8dd0 2026-09-29 Merge remote-tracking branch 'origin/main'
d347de2 2026-09-29 release: 0.6.3 — ERPNext invoices for customers on submit
d1aaea8 2026-09-29 feat: customers get ERPNext's submitted invoice at once; drafts are never offered
9a39b8b 2026-09-29 Merge remote-tracking branch 'origin/main'
a767696 2026-09-29 release: 0.6.2 — None in Sync to Medusa, pull status
```

Extra git worktrees (siblings in `Plugins&Extensions/`; do not edit them from here):

- `.wt-erpnext-0.6.4`: branch `feat/order-payments-0.6.4` (0e93a21). Pushed 2026-10-18. Untracked `mithtech-medusa-plugin-erpnext-0.6.4.tgz`.
- `.wt-erpnext-0.6.5`: branch `feat/gateway-settlements-0.6.5` (df5706c). Pushed 2026-10-18. Untracked `mithtech-medusa-plugin-erpnext-0.6.5.tgz`. This commit equals `origin/main` as last fetched.

Git actions on 2026-10-18 (from `_migration/PHASE2-GIT-ACTIONS.md`):

- Pushed `feat/order-payments-0.6.4` and `feat/gateway-settlements-0.6.5`.
- **Push of `main` (+7) rejected**: the remote `main` has newer commits. Needs `git fetch` and a merge or rebase; it was not forced.
- The 7 local-only commits are the wallet and line-of-credit work (`d8aaea9`, `b412e81`, 2026-09-27) plus 5 merge commits. Local `main` lacks 0.6.4 and 0.6.5 (9 commits on `origin/main`), so `package.json` here still reads 0.6.3. Production and npm.po5.in run 0.6.5.

TODO/FIXME/HACK in source: 0. Open design work lives in `pending_work/` (17 topic files, start with `00-QUESTIONS-ANSWER-THESE-FIRST.md`); `pending_work/done/` holds the closed wallet-sync and credit-line files.

Recent Claude sessions (stored under `~/.claude/projects/-Volumes-Extreme-SSD-Coding-00-medusa/`, since they ran from `00-medusa`):

- 2026-10-13 (`e08cf5e2`): finished wallet + credit-line sync; closed both pending_work files into `done/`; rehearsal 5/5 against fixerp, 349 unit tests green. Commit `b412e81` on `main`. Not pushed or published.
- 2026-10-12 (`189df207`): mapping UI and settings work; released 0.5.3/0.5.4 (pushed, on npm.po5.in, Splendx updated). Asked: press "Set up ERPNext" once because Customer sync became two-way.
- 2026-10-12 (`071a00d0`): user asked for per-field sync direction, type coercion, and fixed/default values in the mapper (both directions). A spec was written in the session; check whether it landed before starting it.
- 2026-10-15 Splendx session (`e162b276`): confirmed GitHub `mithtech-is/medusa-erpnextsync` main = v0.6.5 with tags v0.6.0 to v0.6.5, same version on npm.po5.in and in production.
- Plans: `~/.claude/plans/pasted-content-id-8dc1-role-you-purrfect-snowglobe.md` (Phase 1: replace medusync with Frappe core Webhooks + `medusa_sync`). This shipped in 0.2.0.
- Claude memory notes: `~/.claude/projects/-Volumes-Extreme-SSD-Coding-00-medusa/memory/` (`wallet-loc-credit-state.md`, `erpnext-webhooks-phase1-state.md`, `shared-checkouts-multi-session.md`).

## Next steps

1. Recreate `~/.npmrc` with the npm.po5.in token.
2. `git fetch origin`, then merge `origin/main` into `main` (or rebase the two wallet/credit commits onto it). Resolve against 0.6.4/0.6.5, bump the version above 0.6.5, update CHANGELOG ("Unreleased" wallet/credit entry).
3. `npm install && npm run typecheck && npm test`; restore the `fixerp.localhost` site and run `npm run rehearsal`.
4. Push `main`. Then remove the two worktrees once nothing else needs them (`git worktree remove ../.wt-erpnext-0.6.4` and `../.wt-erpnext-0.6.5`).
5. Publish the next release to npm.po5.in and update Splendx and mithtech-apparel-in pins.
6. Pick up `pending_work/00-QUESTIONS-ANSWER-THESE-FIRST.md` and the mapper fixed/default-value request.
