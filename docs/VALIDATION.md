# Validation record — lms-cli

## 0.3.0 multi-school preview — 2026-09-21

Local environment: macOS arm64, Node.js v25.7.0. Tests use synthetic profiles and isolated temporary state; no real school credentials or course records were read.

Cross-platform CI: [run 35522170197](https://github.com/zs-andy/lms-cli/actions/runs/35522170197) passed on macOS, Windows and Ubuntu for multi-school source commit `6561965`. All three jobs completed dependency installation, type checking, automated tests, production dependency audit, CLI packaging, app/installer packaging and artifact upload. These artifacts are CI builds, not a published Release or real-school acceptance.

- TypeScript type checking and build: passed.
- Automated tests: **36 passed, 0 failed, 0 skipped**. New coverage includes custom school setup, Canvas-only/Blackboard-only profiles, preserving the active profile, CLI/MCP profile creation and selection, 0.2.0 PolyU profile compatibility, tenant/origin-isolated connection caches, custom-host Cookie scoping, fresh reauthorization, scoped connection checks and safe dynamic school selection.
- Real Chromium/Electron authorization-page smoke test: passed with synthetic schools. Checked school switching, configured-platform filtering, correct login arguments, locked profile, empty state, hostile labels rendered as text and viewport fit. The rendered page was visually inspected; no school SSO was attempted.
- Plugin manifest and query Skill validation: passed. App, package, plugin and marketplace use `lms-cli`; the school emblem is replaced by an original neutral icon.
- CLI tarball build and package-content inspection: passed. No credentials, backup directories, node_modules or old school emblems are bundled.
- Clean tarball installation outside the source checkout: passed; custom-school initialization, `doctor`, 15-tool MCP handshake and real upstream schema discovery worked without credentials.
- macOS arm64 unpacked app build: passed with signing explicitly disabled. Its display name is `lms-cli`; the packaged Node-mode CLI and native-keyring module load passed. No new DMG/ZIP release, signing or notarization is claimed by this local check.
- Production dependency audit (`npm audit --omit=dev`): **0 known vulnerabilities** at verification time. This is not an independent security audit.
- Public MCP exposes **15 front-door tools**, including explicit local profile setup/selection and bounded live identity/course-list checks. Remote writes and raw requests remain denied.

### Limits of this validation

- This change does not certify any additional real institution. Schools' SSO/MFA, embedded-browser policies, feature permissions, Blackboard versions and special deployment paths need institution-specific acceptance.
- `lms check` verifies identity and course-list endpoints only; it cannot certify announcements, assignments, grades, files or every course.
- macOS local tests are not physical Windows/Linux acceptance. CI/offline packaging is separate from live school and OS-keychain acceptance.
- Version 0.3.0 source/package preparation is not a public npm publication, signed/notarized installer, release tag or published GitHub Release. Historical 0.2.0 artifacts must not be represented as multi-school builds.

See [SCHOOLS.md](SCHOOLS.md) and [ACCEPTANCE.md](ACCEPTANCE.md) for the remaining live checks.

## Historical record — 0.2.0 (PolyU-only release)

The following record describes the old release, not the current multi-school UI or compatibility promise.

Performed locally on 2026-09-20, macOS arm64.

Public-release CI: [run 35520037721](https://github.com/zs-andy/lms-cli/actions/runs/35520037721) passed on macOS, Windows and Ubuntu for the initial source release. It exercises dependency installation, type checking, offline tests, dependency audit, CLI packaging and platform-specific Electron packaging. It does not authenticate against PolyU.

- TypeScript build/type checking: passed.
- Automated tests: **27 passed, 0 failed, 0 skipped**. Includes PolyU-only routing, monochrome authorization-page checks, pure-emblem icon checks, profile validation, encrypted-vault boundaries, stale-session protection, cookie scoping, read-only allowlist, parameter limits, caching/deduplication, partial failures, task correction history, stable ICS UIDs, HTTP credential/redirect guards, real upstream MCP handshakes, CLI exit codes and Electron Node-mode/native-keyring loading.
- `npm audit` including development dependencies: **0 known vulnerabilities** at the time of this run. This is not a comprehensive security certification.
- Plugin manifest and skill validators: passed.
- Initial public source preparation: Gitleaks 8.30.1 found no leaks in the staged source export; README relative links and no-emoji check passed. This is a point-in-time scan, not a guarantee that all possible sensitive data patterns are detectable.
- Clean npm tarball installation outside the source checkout: passed; `lms doctor`, tool discovery, unauthenticated status, and real installed MCP handshake exercised.
- Installed MCP exposes **11 front-door tools** and a reviewed catalog of **55 upstream read tools** (Canvas 29, Blackboard 26). Raw requests and remote mutations are not exposed.
- Electron macOS arm64 application, DMG and ZIP build: passed, with code-signing identity explicitly disabled. Packaged application's Node-mode CLI and native keyring module load: passed (Electron Node v24.21.0). The CLI was also tested on Node v25.7.0.
- The npm tarball and macOS arm64 DMG/ZIP can be built locally. GitHub distribution uses a preview release; no public npm publication or notarization is claimed.

### Historical 0.2.0 unverified items / final acceptance

- New authorization vault intentionally starts empty. Existing PolyU prototype credentials and study state were not read, migrated or erased. A fresh login is needed once.
- The packaged authorization app was opened and visually checked on macOS arm64. Its own page is monochrome, PolyU-only and free of technical setup details. School SSO/MFA was not completed during verification.
- Windows and Linux CI builds/offline tests passed as linked above. Their installers, OS keychain interactions and actual school SSO have **not been manually accepted on physical Windows/Linux systems**.
- Independent `lms ask` invocation isolation was tested; a full live model-and-school query was **not run**. Use the installed Codex plugin or compatible signed-in Codex CLI for the acceptance cases.
- Other institutions' SSO/Canvas/Blackboard compatibility was not accepted for this release; the user-facing package is intentionally limited to PolyU until separate tenant testing is complete.

Use `ACCEPTANCE.md` for final real-account checks. A fast overview is bounded: it does not prove all historical notifications or linked attachments were read. There is no daily automation or third-party calendar subscription configured by installation.

The historical 0.2.0 distribution used the `polyu-lms` GitHub marketplace. Current multi-school source uses `lms-cli`; see the README migration instructions and avoid enabling multiple copies of the plugin.
