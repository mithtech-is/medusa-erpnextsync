# Local development stack (Windows + WSL)

How the ERPNext ↔ Medusa connector is developed and exercised locally. Two
things are version-controlled and pushed: this plugin and the Frappe app
`medusync`. Everything else is a disposable harness.

## Where things live

| Piece | Location | Git |
|---|---|---|
| Plugin `medusa-plugin-erpnext` (this repo) | `C:\Users\KillerKoli\Divya\00-medusa\00-medusa\000-medusa-plugins-extensions\medusa-plugin-erpnext-generic` | `mithtech-is/medusa-erpnextsync`, branch `main` |
| Frappe app `medusync` | WSL `/home/divya/frappe-bench/apps/medusync` | `suparikoli/medusync`, branch `master` |
| Medusa sandbox `risitex-mainb2b` | `C:\Users\KillerKoli\Divya\00-medusa\00-medusa\risitex-mainb2b` | local only, **no remote** (see its `SANDBOX.md`) |
| ERPNext bench | WSL `/home/divya/frappe-bench`, site `site1.local`, ERPNext v16 | not git |
| Archived leftovers | `C:\Users\KillerKoli\Divya\00-medusa\00-medusa\_archive\` | — |

The bench belongs to WSL user **divya**; run every bench command as
`wsl -d Ubuntu -u divya -- bash -lc '…'` or via a script file
(`wsl -d Ubuntu -u divya -- bash /mnt/c/…/x.sh`). `bench` lives at
`/home/divya/.local/bin/bench`.

## Services and ports

| Service | Where | Port | Start |
|---|---|---|---|
| Postgres (Medusa) | Docker `risitex-postgres` | 127.0.0.1:5435 | `docker start risitex-postgres` |
| Redis (Medusa) | Docker `risitex-redis` | 127.0.0.1:26379 | `docker start risitex-redis` |
| MariaDB (Frappe) | WSL systemd | 3306 (WSL) | always on |
| Redis cache/queue (Frappe) | WSL bench | 13000 / 11000 (WSL) | part of `bench start` |
| Frappe web | WSL bench | 8000 | `bench start` |
| Frappe socketio | WSL bench | 9000 **inside WSL** | `bench start` |
| Medusa API | Windows | 9000 | `pnpm dev` in `apps/backend` |
| Medusa admin (static + proxy) | Windows | 7001 | `node serve-admin.js` in `apps/backend` |

Never run `pnpm docker:up` in the sandbox (its `infrastructure/docker/.env`
is missing; it would create the wrong containers). Start the two containers by
name.

## Addressing between Windows and WSL

WSL2 is in NAT mode (no `.wslconfig`). Windows → WSL uses the WSL IP (or
`127.0.0.1` through localhost forwarding); WSL → Windows uses the WSL default
gateway (the vEthernet adapter, e.g. `172.26.48.1`). The WSL IP changes on
every WSL restart, so run:

```bash
pwsh scripts/dev/resolve-addresses.ps1
```

It writes `ERPNEXT_URL` into the sandbox backend `.env` and
`Medusync Settings.medusa_url` on the site, and prints what it chose. Pass
`-MedusaAdminEmail`/`-MedusaAdminPassword` (or set `MEDUSA_ADMIN_EMAIL` /
`MEDUSA_ADMIN_PASSWORD`) while Medusa is up to also update the plugin's
setting row through the admin API.

Verified 2026-09-04: from Windows both `http://127.0.0.1:8000` (localhost
forwarding) and `http://<wsl-ip>:8000` reach Frappe; the resolver prefers
`127.0.0.1` because it survives WSL restarts. From WSL, Medusa answers at
`http://172.26.48.1:9000` (the gateway). Windows Firewall already allows
node.exe inbound.

Windows `netstat` can show `:8000`/`:9000` as LISTENING through `wslrelay`
even when the bench is down; `ss -ltnp` inside WSL is the truth.

## Bring-up (cold)

```bash
# 1. datastores
docker start risitex-postgres risitex-redis

# 2. Frappe (long-lived background task)
wsl -d Ubuntu -u divya -- bash -lc 'cd /home/divya/frappe-bench && bench start'

# 3. addresses
pwsh scripts/dev/resolve-addresses.ps1

# 4. Medusa (sandbox)
cd ../../risitex-mainb2b/apps/backend
pnpm exec medusa db:migrate
pnpm dev                       # medusa develop, API on :9000 (admin disabled in .env)
node serve-admin.js            # static admin on http://127.0.0.1:7001/app

# 5. smoke
#   Medusa admin → ERPNext page → Test connection
#   Frappe desk → Medusync Settings → Test connection to Medusa
```

## Stop / clean slate

```bash
# Windows: Medusa processes of the sandbox
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'risitex-mainb2b|medusa-plugin-erpnext' -and $_.Name -eq 'node.exe' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
# WSL: the bench
wsl -d Ubuntu -u divya -- bash -lc 'pkill -f "bench start"; pkill -f honcho; pkill -f "frappe serve"; pkill -f "frappe worker"; pkill -f "frappe schedule"; pkill -f "redis-server config/redis_"; pkill -f "redis-server 127.0.0.1:13000"; pkill -f "redis-server 127.0.0.1:11000"'
# (a daemonized redis rewrites its argv to "redis-server 127.0.0.1:PORT"; honcho cannot start while those ports are taken)
# Docker
docker stop risitex-postgres risitex-redis
```

## Plugin dev loop

The sandbox consumes the plugin through Medusa's yalc flow
(`apps/backend/package.json` → `"medusa-plugin-erpnext": "file:.yalc/medusa-plugin-erpnext"`).

```bash
# in the plugin
npm run typecheck
npx medusa plugin:build
npx medusa plugin:publish        # -> local yalc store
# in risitex-mainb2b
pnpm install                     # copies the published build into node_modules
pnpm --filter @risitex/backend exec medusa db:migrate   # when the plugin adds migrations
```

`npx medusa plugin:develop` in the plugin watches and republishes on save;
`medusa develop` in the sandbox picks it up. If the running app seems to serve
stale plugin code, stop it, `pnpm install` again and restart.

`medusa develop` runs with `DISABLE_MEDUSA_ADMIN=true`; after changing the
plugin's admin UI rebuild the static bundle:
`MEDUSA_BACKEND_URL=http://127.0.0.1:7001 npx medusa build --admin-only`.

## Frappe dev loop

```bash
# edit apps/medusync in WSL (as divya), then
wsl -d Ubuntu -u divya -- bash -lc 'cd /home/divya/frappe-bench && bench --site site1.local migrate'   # after doctype/patch changes
wsl -d Ubuntu -u divya -- bash -lc 'cd /home/divya/frappe-bench && bench --site site1.local run-tests --app medusync'
```

`hooks.py` changes need a full `bench start` restart; plain `.py` edits reload
in the web process but the **worker** may keep a stale module until restarted.

Site-specific behaviour is chosen per site in `sites/site1.local/site_config.json`:

```json
"medusync_handler_packs": ["risitex"]
```

Writing into the WSL app from Windows tools over `\\wsl.localhost\…` fails on
permissions (files belong to `divya`); write to a Windows folder and copy in
with `wsl -u divya cp …`, or edit inside WSL.

## Do not run from the sandbox

`apps/backend/render.yaml`, `infrastructure/server/*`, `infrastructure/postgres/*.ps1`,
`scripts/reset.ps1` — all production-facing. The sandbox has no git remote on
purpose; do not add one.
