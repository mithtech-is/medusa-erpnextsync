# Setup on a new machine

This folder (`00-medusa/`) is a plain directory, not a git repo. You can copy it
as-is, but a few things must be re-created or fetched on the target machine.

## 0. Before you copy (on the source machine)

- **Don't copy `node_modules`.** The plugin's `node_modules` is ~700 MB and
  contains arch-specific native binaries (`@swc/core`, esbuild) that will not
  work on a different OS/CPU. Delete or exclude it; reinstall on the target.
  Same for any `node_modules` / pnpm store under `risitex-mainb2b`.
- **Commit risitex first.** `risitex-mainb2b` has staged, uncommitted changes
  (the removed vendored erpnext plugin). Commit or stash them so they travel
  cleanly, or re-clone on the target instead of copying.
- **The risitex git worktree won't travel.** `git worktree list` shows one at
  `…/risitex-mainb2b/.claude/worktrees/…` that lives OUTSIDE this folder and is
  already `prunable`. After transfer run `git -C risitex-mainb2b worktree prune`.

## 1. The generic plugin — `000-medusa-plugins&extensions/medusa-plugin-erpnext-generic`

```bash
cd 000-medusa-plugins\&extensions/medusa-plugin-erpnext-generic
npm install          # reproduces node_modules from package-lock.json
npm run typecheck    # tsc --noEmit — should pass clean
npm run build        # medusa plugin:build (optional, produces .medusa/)
```

## 2. The sample store — `risitex-mainb2b`

Mithtech monorepo (turbo + pnpm), git remote `mithtech-is/risitex-mainb2b`.

```bash
cd risitex-mainb2b
git worktree prune           # drop the stale external worktree ref
pnpm install                 # install workspace deps
```

To exercise the plugin here, install it into `apps/backend` and register it in
`apps/backend/medusa-config.ts` under `plugins` (the old vendored copy and its
config block were removed — wire in the generic plugin instead).

## 3. medusync — the Frappe side (NOT in this folder — fetch it)

The ERPNext connector is two halves. The Medusa half is the plugin above; the
Frappe half is the **`medusync`** app, which is a separate repo and must be
installed into a Frappe bench on the target machine.

- Repo: `https://github.com/suparikoli/medusync.git`
- On the source machine it currently sits at `frappe16/apps/medusync`.

Install into an existing Frappe/ERPNext bench:

```bash
cd /path/to/frappe-bench
bench get-app https://github.com/suparikoli/medusync.git
bench --site <your-site> install-app medusync
bench --site <your-site> migrate
bench build
```

Then configure it in the Frappe desk under **Medusync Settings** (Single):
`enabled`, `medusa_url` (the Medusa backend base URL), `inbound_path`
(default `/webhooks/erpnext-inbound`), `inbound_secret`, `outbound_secret`.

### Secret pairing (both sides must match)

| Plugin setting (Medusa) | medusync setting (Frappe) |
|---|---|
| `webhook_secret` | `inbound_secret` |
| `frappe_to_medusa_secret` | `outbound_secret` |
| `frappe_receive_method` = `medusync.api.receive` | (endpoint medusync exposes) |

> **medusync still needs the simplification updates too** — see
> [SIMPLIFICATION_PLAN.md](SIMPLIFICATION_PLAN.md). After installing, either apply
> those changes on the target or `git pull` an updated medusync once the plan is
> executed. Until then the app auto-registers the Polemarch handler pack at
> install (`after_install`); a domain-neutral install is part of the pending work.

## 4. Sanity check the round-trip

With the plugin installed in risitex's backend and medusync installed on a Frappe
site, point `frappe_receive_method`/`erpnext_url` at that site, set the matching
secrets, create a customer in Medusa, and confirm a mapping round-trips both ways
(Medusa→Frappe push, Frappe→Medusa via a Medusync Mapping row).
