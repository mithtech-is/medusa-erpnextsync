# The circuit breaker and Needs Attention, on this side

**Deferred from:** Phase 6 (backward compatibility and operations)
**Belongs to:** the next block of operations work
**Side:** Medusa only. ERPNext has both.

## What ERPNext has and this side does not

**A per-store circuit breaker.** `Medusync Site` counts consecutive
failures and, past a threshold (default ten), stops attempting deliveries
to that store and lets one through per minute to find out whether it has
come back. One success clears it. Other stores are unaffected, which is
the whole point: without it, one store that is down holds workers on
timeouts and starves the queue for the stores that are up.

This side has the same exposure in the same shape. `forwardEvent` posts to
ERPNext with a timeout, `retry-events` re-posts on a schedule, and a Frappe
site that is down for an afternoon means every one of those attempts waits
out the timeout and fails. Today nothing counts that or stops trying.

**A "Needs Attention" flag on a mapping.** `Medusync Mapping.attention` is
set by two things: an upgrade that would not overwrite an edited default,
and a nightly check that finds a mapping naming a field the DocType no
longer has. The second switches that mapping off — only it — and raises a
Notification Log to the System Managers.

`erpnext_mapping` has neither field nor check.

## What each would take here

**The breaker.** Three columns on `erpnext_setting` (it is per connection,
and there is one connection per Medusa): `consecutive_failures`,
`tripped_at`, `trip_after`. One migration. `forwardEvent` asks before
posting and records both outcomes; `retry-events` lets one row through per
run while tripped. Roughly `medusync/breaker.py`, which is ninety lines
and worth reading first — particularly the two rules that are easy to get
wrong: a rehearsal must never trip it or close it, and a probe must always
be let through, or it never learns the far side came back.

**The drift check.** Harder here than on ERPNext, because the field list
lives on the other machine. `GET /admin/erpnext/doctypes/:name` already
fetches a DocType's fields and the plugin caches them, so the check is: for
each enabled mapping, fetch the doctype schema, compare against the
`erpnext_field` of every field mapping, flag what is missing. The natural
home is the `pull-from-erpnext` job, which already runs on a schedule and
already talks to Frappe. It must never throw — a scheduled job that dies on
one bad mapping stops checking the rest.

## Why it was left

Phase 6's floor was the ERPNext side, where the mappings are authored on
this project and where the operator actually sits. Both of these are the
same idea a second time rather than a new one, and the breaker in
particular is better copied from a version that has tests than written
twice from the description.
