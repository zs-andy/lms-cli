# Validation record — lms-cli

## 0.4.0 CLI installation, discovery and updates — historical baseline, 2026-09-21

Environment: macOS arm64, Node.js v25.7.0. Tests used temporary state and synthetic profiles; no school credentials or course data were accessed.

- Full TypeScript check and build: passed. This supersedes the full-worktree type-check failure in the historical refactor record below.
- Automated tests: **74 passed, 0 failed, 0 skipped**. Coverage includes public directory boundaries, search timeouts/limits, explicit terminal selection, setup idempotency, multi-account defaults, CLI/MCP discovery, update checks, successful upgrade transactions, checksum and runtime-verification failure, untrusted redirects and rollback.
- Self-contained macOS arm64 CLI bundle: built with checksum-verified official Node and a prepared Electron authorization runtime. Relative framework links are preserved, and all archive entries pass the updater's extraction policy.
- Clean standalone installation: passed with no system Node in PATH and isolated home, school-state and Codex directories. Verified native module loading, no-login setup, offline school search, **17-tool MCP discovery**, real Codex local-plugin registration, repeat registration, rollback and reinstall. No graphical windows were opened.
- Interactive terminal setup: searched the local Chinese school alias, displayed the selected platform URLs/timezone, required explicit confirmation and returned profile-specific continuation commands without login windows.
- Live public Canvas directory search: name search returned institution domains including CityU and PolyU. No returned school domain was contacted and no configuration was saved.
- Public update check: returned `no-release` for the stable channel. Online installer downloads and a real published-version upgrade require matching stable Release assets; mocked-download transaction tests passed locally.
- Production dependency audit: **0 known vulnerabilities** at verification time.
- Agent skill and plugin validators: passed. POSIX installer/launcher syntax, package-content dry run and relative documentation links passed.
- Historical 0.4.0 inspection: the bundled upstream Electron runtime had an ad-hoc linker signature and was not suitable for the stable channel. The signed 0.4.1 process and results are recorded below.

The historical 0.4.0 record did not publish a stable release. Current signed-release validation is recorded below; cross-platform CI, physical Windows/Linux checks and permitted school SSO/MFA remain separate acceptance items. See [ACCEPTANCE.md](ACCEPTANCE.md) and [RELEASING.md](RELEASING.md).

## 0.4.1 signed macOS release candidate — 2026-09-21

Environment: macOS arm64, Node.js v25.7.0, Developer ID Application `Si Yi Lyu (N9DDMY3PQ3)`. No school credentials or course data were accessed.

- TypeScript build and automated tests: **77 passed, 0 failed, 0 skipped**.
- macOS standalone CLI: Node 24.20.0, Electron 44.4.3, native `.node` modules and Electron Framework/Helper code were signed with the same Developer ID identity, Hardened Runtime and Apple timestamps. The archive passed strict signature verification and updater archive checks.
- Apple notarization: standalone CLI submission `b353078c-0c9e-4396-8c0d-16e9cca2842c` returned **Accepted**. SHA-256: `fa18bb3b3c1d8d855638b6f2a1599c4babc5c7dc37efc0f03691cd7a7ebef9d2`.
- Authorization App: signed DMG and ZIP built from the same source. DMG notarization submission `54da178f-b185-4f91-8b06-107c3c18a924` returned **Accepted**; the ticket was stapled and validated with `xcrun stapler validate`, `spctl` and `codesign --verify --deep --strict`.
- The Apple notarization profile is stored in the local Keychain as `lms-cli`; no password or private key is stored in the repository.

The 0.4.1 signed artifacts are ready for a new stable Release after cross-platform assets and release metadata are attached. The existing v0.4.0 preview assets were not overwritten.

## Platform extension refactor — local working tree, 2026-09-21

Environment: macOS arm64, Node.js v25.7.0. This record is local verification, not a new CI run, release or additional institution certification.

- Changed CLI, MCP, worker, authorization and template entry points and their dependency graphs: TypeScript compilation passed.
- Offline tests (`node --import tsx --test test/*.test.ts`): **45 passed, 0 failed, 0 skipped**. Includes all previous checks plus registry ownership/validation, lazy runtime imports, environment cleanup, old vault-path compatibility and a synthetic third-platform registration in an isolated copy. The third-platform test verifies config, CLI, MCP schema, login metadata, source-isolated vault storage and nine overview calls with at most three concurrent reads, without editing core.
- Browser-based authorization-page check at a temporary loopback URL, 1280 × 720: passed using synthetic schools and a mock login bridge. Single/dual-platform selection and the submitted `exchange / blackboard` arguments were verified. No school login, remote content or real credentials were used. The rendered application had no errors or horizontal overflow.
- Package-content dry run (`npm pack --dry-run --ignore-scripts`): platform runtimes and extension docs included; no vault/profile files or node_modules included. This is not a clean installation or installer-build check.
- Relative links in README, CONTRIBUTING and the two new architecture/extension guides: **24 checked**.
- Historical full-worktree check: blocked by `src/updates.ts:77` (`TS2339`, `release.assets.find`) at this checkpoint. The complete 0.4.0 check above supersedes that result.

Not verified here: real-school SSO/MFA, additional platforms, physical Windows/Linux systems, mobile UI, new signed installers or fresh cross-platform CI. The records below describe earlier commits and must not be interpreted as CI results for this refactor.

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
