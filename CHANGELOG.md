# Changelog

All notable changes to `@mithtech-medusa/plugin-erpnext`. Versions follow semver; `medusaRange` in
`factory.extension.yaml` is the tested range, not a guess.

## Unreleased

- Verified against Medusa 2.21.0 (install, `plugin:build`, test suite, `tsc --noEmit`).
  Dev `@medusajs/*` ranges raised to `^2.21.0` (the version tested against); peer ranges and `medusaRange` stay `^2.19.0` because the
  extension uses no 2.20/2.21-only API and declares no store-route `allowed` field lists
  (the 2.21 strict allow-list change does not affect it, though the plugin does serve store routes).
- A fixed value is chosen from the connected site in the mapping editor, not only in the guided
  wizard: a Link or Select offers that site's own records, a pair can be turned into a fixed value
  and back, and a saved value the site no longer has stays selected and says so.

## 0.1.1

- Renamed to `@mithtech-medusa/plugin-erpnext`. Not yet published to Verdaccio (`npm.po5.in`).

## 0.1.0

- Initial extraction and publish to Verdaccio (`npm.po5.in`).
