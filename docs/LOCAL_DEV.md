# Running both halves locally

The connector is two applications that only prove anything together. This is
how to get both up and how to move a change from one into the other. Two
things are version-controlled: this plugin, and the Frappe app `medusync`.
The Medusa project and the bench you test against are yours and disposable.

Written against a Windows + WSL2 setup, because that is the awkward case —
the addressing section is the only part that is. On one Linux or macOS
machine, `localhost` works everywhere and you can skip it.

## The pieces

| Piece | Git |
|---|---|
| Plugin `medusa-plugin-erpnext` (this repo) | `mithtech-is/medusa-erpnextsync`, branch `main` |
| Frappe app `medusync` | `suparikoli/medusync`, branch `master` |
| A Medusa 2.19 project to install the plugin into | yours |
| A Frappe bench with ERPNext v16 and a site | yours |

If the bench belongs to another user, every bench command goes through them:
`wsl -d Ubuntu -u <user> -- bash -lc '…'`, or a script file
(`wsl -d Ubuntu -u <user> -- bash /mnt/c/…/x.sh`), which is the reliable way
to pass anything containing quotes or backticks.

## Ports

| Service | Where | Port |
|---|---|---|
| Postgres (Medusa) | usually a container | 5432, or whatever you mapped |
| Redis (Medusa) | usually a container | 6379, or whatever you mapped |
| MariaDB (Frappe) | the bench's host | 3306 |
| Redis cache/queue (Frappe) | the bench | 13000 / 11000 |
| Frappe web | the bench | 8000 |
| Frappe socketio | the bench | 9000 |
| Medusa API | your machine | 9000 |
| Medusa admin, if served separately | your machine | 7001 |

**Frappe's socketio and Medusa's API both want 9000.** They coexist while
Frappe is inside WSL in NAT mode, because that is a different network
namespace. Put them on one host — mirrored networking, or one Linux box —
and one of them has to move: change `socketio_port` in the bench's
`common_site_config.json`.

## Addressing between Windows and WSL

WSL2 in NAT mode (no `.wslconfig`): Windows → WSL through `127.0.0.1`
(localhost forwarding) or the WSL IP; WSL → Windows through the WSL default
gateway (the vEthernet adapter, e.g. `172.26.48.1`). **The WSL IP changes on
every WSL restart**, so:

```bash
pwsh scripts/dev/resolve-addresses.ps1 -BackendEnv <path-to-your-.env>
```

It writes `ERPNEXT_URL` into the Medusa project's `.env` and the `medusa_url`
of every enabled **Medusync Site**, and prints what it chose. It prefers
`127.0.0.1` for the Frappe side because that survives a WSL restart. Pass
`-MedusaAdminEmail` / `-MedusaAdminPassword` (or set `MEDUSA_ADMIN_EMAIL` /
`MEDUSA_ADMIN_PASSWORD`) while Medusa is up to also update the plugin's
setting row through the admin API. `-NoWrite` just prints.

Windows `netstat` shows `:8000` / `:9000` as LISTENING through `wslrelay`
even when the bench is down. `ss -ltnp` inside WSL is the truth.

## Bring-up (cold)

```bash
# 1. the Medusa datastores
docker start <your postgres> <your redis>

# 2. Frappe (long-lived)
wsl -d Ubuntu -u <user> -- bash -lc 'cd ~/frappe-bench && bench start'

# 3. addresses (Windows + WSL only)
pwsh scripts/dev/resolve-addresses.ps1 -BackendEnv <path>

# 4. Medusa
pnpm exec medusa db:migrate
pnpm dev

# 5. smoke — both directions, they prove different things
#   Medusa admin → ERPNext page → Test connection
#   Frappe desk  → Medusync Settings → Test connection to Medusa
```

## Stopping

```bash
# Windows: the Medusa processes
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'medusa' -and $_.Name -eq 'node.exe' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
# WSL: the bench
wsl -d Ubuntu -u <user> -- bash -lc 'pkill -f "bench start"; pkill -f honcho; pkill -f "frappe serve"; pkill -f "frappe worker"; pkill -f "frappe schedule"; pkill -f "redis-server config/redis_"; pkill -f "redis-server 127.0.0.1:13000"; pkill -f "redis-server 127.0.0.1:11000"'
```

A daemonised redis rewrites its argv to `redis-server 127.0.0.1:PORT`, so the
first `pkill` pattern misses it and honcho then cannot start because the port
is taken. That is what the last two patterns are for.

## Plugin dev loop

A Medusa project consumes a local plugin through Medusa's yalc flow —
`package.json` ends up with
`"medusa-plugin-erpnext": "file:.yalc/medusa-plugin-erpnext"`.

```bash
# in the plugin
npm run typecheck                # tsc, app + specs
npm test                         # vitest
npx medusa plugin:build
npx medusa plugin:publish        # -> the local yalc STORE

# in the Medusa project
npx yalc update medusa-plugin-erpnext   # store -> ./.yalc  (REQUIRED)
pnpm install                            # .yalc -> node_modules
pnpm exec medusa db:migrate             # when the plugin adds migrations
```

**`plugin:publish` alone is not enough.** It writes to the yalc store; the
consumer's `.yalc` copy only moves when `yalc update` runs there. Skip it and
you install the previous build — a module the new code imports is simply
missing at boot. Migrate *after* the update, or the newest migration is not
on disk yet and `db:migrate` reports "already up-to-date".

`npx medusa plugin:develop` watches and republishes on save. If the running
app seems to serve stale plugin code, stop it, re-run update + install, and
restart.

If Medusa runs with `DISABLE_MEDUSA_ADMIN=true` and you serve the admin
bundle separately, a change to the plugin's admin UI needs the bundle rebuilt:
`MEDUSA_BACKEND_URL=http://127.0.0.1:7001 npx medusa build --admin-only`.
`plugin:build` does not touch it.

## Frappe dev loop

```bash
wsl -d Ubuntu -u <user> -- bash -lc 'cd ~/frappe-bench && bench --site <site> migrate'
wsl -d Ubuntu -u <user> -- bash -lc 'cd ~/frappe-bench && bench --site <site> run-tests --app medusync'
```

`hooks.py` changes need a full `bench start` restart. Plain `.py` edits reload
in the web process, but the **worker** can keep a stale module until it is
restarted — which is exactly where a queued delivery runs.

Handler packs are chosen per site in `sites/<site>/site_config.json`:

```json
"medusync_handler_packs": ["commerce"]
```

Absent means `commerce`, which is what a site without an opinion wants.

Each connected Medusa store is a **Medusync Site** record in the Desk holding
that store's URL and its own pair of shared secrets. The plugin's matching
`site_id` is on its settings page, and the two must be equal: every envelope
names its site, and each side uses that to recognise its own change coming
home.

Writing into a WSL app from Windows tools over `\\wsl.localhost\…` fails on
permissions when the files belong to another user. Write to a Windows folder
and copy in with `wsl -u <user> cp …`, or edit inside WSL.
