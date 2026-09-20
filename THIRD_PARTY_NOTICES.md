# Reused open-source components

This application is not affiliated with Instructure, Anthology, PolyU, or OpenAI.

## Names and brand assets

The PolyU name and emblem, including the image assets in `assets/` and `plugins/lms-cli/assets/`, remain the property of their respective rights holders. They are not licensed under this project's MIT license. Their inclusion identifies the intended institution; it does not imply sponsorship, approval, or permission to reuse these marks. The same applies to the Canvas, Blackboard and Codex names. Distributors must independently confirm any required trademark or brand-use permissions.

## Vendored LMS connectors (MIT)

- [xmike04/canvas-student-mcp](https://github.com/xmike04/canvas-student-mcp), v1.3.3, commit `d35bb973c82604f6f16414709b926b892a42558f`. Original license: `vendor/canvas/LICENSE`.
- [felipedias-ie/blackboard-mcp](https://github.com/felipedias-ie/blackboard-mcp), v0.6.0, commit `73fb032e14d3fecce396a5a0bf59404ca62dbe29`. Original license: `vendor/blackboard/LICENSE`.

Sources are pinned in `vendor/`, compiled with the application, and not fetched from a moving branch at runtime. These are community connectors, not institution-certified integrations or a claim of universal maturity. Canvas uses its REST endpoints. Blackboard uses Learn Ultra's internal endpoints, which may change without notice.

Local patches inherited from the earlier deployment: HTTPS / URL-credential rejection, Canvas same-origin pagination and credential isolation on download redirects, HTTP timeouts, bounded Blackboard redirects, explicit read-only environment override, configurable Canvas Keychain service.

Additional patches in this distribution: longer Canvas announcement bodies with update timestamps/source links; preservation of Canvas login User-Agent; chunked Canvas calendar contexts (no silent ten-course cutoff); Blackboard announcement IDs/course source links and bounded-coverage notices; explicit ISO/UTC timestamps. All other endpoint mappings, pagination helpers, parsers and LMS tools are reused. The adapter redirects credential loading/persistence to our cross-platform vault and uses a reviewed read-only tool allowlist. Upstream browser-import/login and raw/write tools are never exposed by the LMS CLI.

## Other dependencies

The official Model Context Protocol TypeScript SDK supplies client/server transports and schemas. Electron and electron-builder supply the authorization app and installers. `@napi-rs/keyring` / keyring-rs supply system credential storage. Commander supplies CLI parsing, Ajv schema validation, Zod data validation, proper-lockfile local write coordination, tough-cookie cookie jars, unpdf document extraction, and ical-generator standards-based calendar serialization.

Exact versions and transitive packages are recorded in `package-lock.json`. Their respective licenses are included by their packages. Electron binaries include Chromium and its notices. Preserve these files when redistributing installers or npm packages.
