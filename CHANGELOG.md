# Changelog

All notable changes to `@mithtech-medusa/plugin-erpnext`. Versions follow semver; `medusaRange` in
`factory.extension.yaml` is the tested range, not a guess.

## 0.1.1 — 2026-09-21

- Verified against Medusa 2.21.0 (install, `plugin:build`, test suite, `tsc --noEmit`).
  Dev `@medusajs/*` ranges raised to `^2.21.0` (the version tested against); peer ranges and `medusaRange` stay `^2.19.0` because the
  extension uses no 2.20/2.21-only API and declares no store-route `allowed` field lists
  (the 2.21 strict allow-list change does not affect it, though the plugin does serve store routes).
- A fixed value is chosen from the connected site in the mapping editor, not only in the guided
  wizard: a Link or Select offers that site's own records, a pair can be turned into a fixed value
  and back, and a saved value the site no longer has stays selected and says so.
- A fixed value left blank no longer counts as a source. Turning a row into a fixed value and not
  saying what to send used to satisfy the mandatory-field warnings and the rehearsal that gates
  switching a mapping on, then write an empty string over the field on the first real record. It is
  now flagged in the editor, dropped on save, left out of the payload, and reported in the skipped
  fields.
- The wizard and the editor share one fixed-value control and one options reader, so a reply for a
  doctype that has since been changed away from is discarded rather than shown under the new one.
- Renamed to `@mithtech-medusa/plugin-erpnext`. 0.1.0 was published under the old name.

## 0.1.0

- Initial extraction and publish to Verdaccio (`npm.po5.in`).
