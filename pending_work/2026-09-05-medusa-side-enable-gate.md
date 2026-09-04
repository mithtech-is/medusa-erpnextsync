# The enable gate, on the Medusa side of a mapping

**Deferred from:** Phase 4 (the mapping studio)
**Belongs to:** Phase 6, with the rest of the operator-facing work
**Side:** Medusa only. ERPNext already has this.

## What exists

`medusync` gates the transition: switching a **Medusync Mapping** on
requires a rehearsal whose signature matches what the mapping currently
does — DocType, direction, key, field map. A pass survives ticking
Enabled and does not survive somebody adding a field. Only the transition
is gated, so a mapping already running keeps running.

It also refuses a *remote* enable: a mapping arriving from Medusa has its
fields applied and its `enabled` left off, quietly rather than with an
error, because an error would put the sender into a retry loop.

## What is missing here

The mirror. `erpnext_mapping` can be switched on through
`PATCH /admin/erpnext/mappings/:id` with nothing checked, and the pull
cron starts running it on the next tick.

Three pieces:

- **A signature.** The same shape as the ERPNext one, over the fields that
  decide behaviour: `doctype`, `medusa_entity`, `direction`,
  `key_medusa_field`, `key_erpnext_field`, `events`, and the sorted
  `field_mappings`. Not `name`, not `updated_at`, not `version` — version
  changes on every save including one that only ticks Enabled, which is
  precisely the save the gate must allow.
- **Columns:** `tested_signature`, `last_test_at`, `last_test_status`,
  `last_test_report`. One migration.
- **The rule, in the update path:** refuse a false→true transition on
  `enabled` unless the signature matches. `dryRunPush` and `planInbound`
  already produce the report; what is missing is recording it and reading
  it back.

## The decision that has to be made with it

Whether an enable arriving from ERPNext through `mapping.upserted` is
trusted. ERPNext refuses the equivalent, so refusing here is symmetric —
but the two sides then disagree about `enabled` at the same version, and
nothing reconciles that, because the conflict rule only compares versions.

Either accept an incoming enable from a paired mapping (asymmetric, and
means an ERPNext operator can start a Medusa mapping without anyone here
looking), or refuse it and give the mapping-sync protocol a way to say
"applied, except that". The second is more work and more correct. Deciding
this is the first step, not the code.

## Why it was left

Phase 4's job was to make a mapping testable at all, and the ERPNext side
is where mappings are authored on this project today. The Medusa gate is
the same idea a second time, and it depends on a protocol decision that is
better made alongside the Phase 6 backward-compatibility work, where
"never auto-replace an existing mapping" raises the same question.
