# The mapping studio has no page on this side

**Deferred from:** Phase 4 (the mapping studio)
**Belongs to:** Phase 6, with the rest of the operator-facing work
**Side:** Medusa only. ERPNext has its studio on the mapping form.

## What exists

Routes, and nothing that calls them:

```
GET  /admin/erpnext/studio/sample?entity=product[&id=prod_123]
POST /admin/erpnext/studio/plan-inbound   { "event": "...", "data": {} }
POST /admin/erpnext/mappings/{id}/dry-run { "record_id": "prod_123" }  # optional
```

The existing admin page has a **Test** button on the mapping editor. It
still does only what it did before Phase 4: a push dry-run against a real
record whose id the operator has to know and paste. It cannot show a
sample, cannot rehearse the pull direction, and cannot rehearse a mapping
for an entity with no records yet — which is the common case for a mapping
somebody is in the middle of writing.

## What is missing

- **A sample panel.** Call `studio/sample` for the mapping's entity, show
  the JSON, and let the operator click a path to fill a field-map row. The
  route already returns a real record when given an id and a placeholder
  record built from the entity's declared paths when not.
- **Test with no record id.** `dry-run` already accepts an omitted
  `record_id`; the button still requires one.
- **A pull rehearsal.** `studio/plan-inbound` reports which mapping would
  take an ERPNext event, the entity and key it would land on, the payload,
  and the fields dropped for want of a source value. Nothing shows it.
- **Somewhere to see test traffic.** `erpnext_sync_event` rows are marked
  `is_test`; the events list has no filter for them, so a rehearsal and a
  real delivery look identical in the admin.

## Why it was left

Mappings on this project are authored on the ERPNext side, where the studio
does have a form. Building the second UI before anybody has used the first
one would be guessing at what the panel should show.

The routes were built anyway rather than deferred with the page, because
they are what the ERPNext side's remote rehearsal talks to, and because a
UI written against routes that already work is a smaller job than both at
once.
