# Picking this up on another machine

Written for the version of you that comes back to this in a fortnight, on a
different computer, having forgotten which half lives where.

## What is in git and what is not

| | Where | In git |
|---|---|---|
| This plugin | a Medusa 2.19+ project's plugin folder | ✅ `mithtech-is/medusa-erpnextsync` |
| The Medusa project you test against | wherever you put it | ❌ yours, local only |
| The Frappe bench and its site | wherever you put it | ❌ never was |

The plugin is entirely in git. **Neither stack is.** That is the important
sentence: a new machine has the code and none of the environment, and
rebuilding the environment is most of the work. Nothing of ours is
installed on the bench: what the plugin needs there it creates itself.

## What you can do with only the repos

More than you would expect, and this is the cheapest way back in:

```bash
git clone https://github.com/mithtech-is/medusa-erpnextsync.git
cd medusa-erpnextsync && npm install
npm run typecheck     # tsc, app and specs
npm test              # vitest — no database, no Medusa
```

The pure modules carry the rules worth being sure about — the webhook
signature and plan, the selection filter, the setup builders, the mapping
engine, echo suppression, the circuit breaker, the mapping signature — and
none of them needs a running anything.

## What a full environment needs

**Frappe side.** A bench on Frappe/ERPNext **v16** with a site, its
workers running, and an API key for a user with **System Manager**. That is
all; the field and the webhooks are created by the plugin.

**Medusa side.** Any Medusa 2.19+ project. Locally the plugin is consumed
through Medusa's yalc flow (or a packed tarball):

```bash
# in the plugin
npx medusa plugin:build && npx medusa plugin:publish
# in the Medusa project
npx yalc update @mithtech-medusa/plugin-erpnext   # REQUIRED — publish alone does not move it
pnpm install
pnpm exec medusa db:migrate
```

`yalc update` is the step everyone forgets, and skipping it installs the
previous build so a newly imported module is simply missing at boot.

## Pairing the two

1. **Medusa:** ERPNext page → Settings. ERPNext URL, API key and secret,
   the store's public URL (what ERPNext can reach), the selection DocTypes
   (`Item`, allow list, unless you know otherwise). Save.
2. **Test connection** proves the API key. **Set up ERPNext** creates the
   `medusa_sync` field and the two Webhooks and reports each one.
3. **ERPNext:** set *Sync to Medusa* on one document. **Webhook Request
   Log** shows the delivery; the product appears in Medusa; ERPNext →
   Events shows the row.

Nothing is typed twice: the secret is generated here and written into the
Webhook rows by the setup.

## If the two halves are on different machines or in a VM

The addresses are the fiddly part and are machine-specific. `docs/LOCAL_DEV.md`
covers the WSL⇄Windows case in detail, including why the WSL IP changes on
every restart and the script that rewrites both sides. On a single Linux or
macOS machine none of that applies and `localhost` works.

## Where to start reading

- `docs/OPERATIONS.md` — running it.
- `pending_work/00-QUESTIONS-ANSWER-THESE-FIRST.md` — every open decision.
- `README.md` — what Set up ERPNext creates, the link table, the studio.

## What a fresh install looks like

So that a difference from this is recognised as a difference, not assumed
to be a bug:

- No mappings until **Reseed canonical mappings** or the wizard makes them;
  the shipped defaults arrive **switched off** and stay off until rehearsed.
- No `medusa_sync` field and no Webhooks on ERPNext until **Set up ERPNext**
  runs; the pull of a selection DocType fails until then and says so.
- Empty `erpnext_sync_event` and `erpnext_link`. Both fill from first use;
  the log is pruned on the retention in the settings.
- Pushes paused: every push mapping logs `paused` and sends nothing.
