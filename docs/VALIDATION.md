# Validation record — 0.2.0

Performed locally on 2026-09-20, macOS arm64.

Public-release CI: [run 35520037721](https://github.com/zs-andy/polyu-lms-cli/actions/runs/35520037721) passed on macOS, Windows and Ubuntu for the initial source release. It exercises dependency installation, type checking, offline tests, dependency audit, CLI packaging and platform-specific Electron packaging. It does not authenticate against PolyU.

- TypeScript build/type checking: passed.
- Automated tests: **27 passed, 0 failed, 0 skipped**. Includes PolyU-only routing, monochrome authorization-page checks, pure-emblem icon checks, profile validation, encrypted-vault boundaries, stale-session protection, cookie scoping, read-only allowlist, parameter limits, caching/deduplication, partial failures, task correction history, stable ICS UIDs, HTTP credential/redirect guards, real upstream MCP handshakes, CLI exit codes and Electron Node-mode/native-keyring loading.
- `npm audit` including development dependencies: **0 known vulnerabilities** at the time of this run. This is not a comprehensive security certification.
- Plugin manifest and skill validators: passed.
- Initial public source preparation: Gitleaks 8.30.1 found no leaks in the staged source export; README relative links and no-emoji check passed. This is a point-in-time scan, not a guarantee that all possible sensitive data patterns are detectable.
- Clean npm tarball installation outside the source checkout: passed; `lms doctor`, tool discovery, unauthenticated status, and real installed MCP handshake exercised.
- Installed MCP exposes **11 front-door tools** and a reviewed catalog of **55 upstream read tools** (Canvas 29, Blackboard 26). Raw requests and remote mutations are not exposed.
- Electron macOS arm64 application, DMG and ZIP build: passed, with code-signing identity explicitly disabled. Packaged application's Node-mode CLI and native keyring module load: passed (Electron Node v24.21.0). The CLI was also tested on Node v25.7.0.
- The npm tarball and macOS arm64 DMG/ZIP can be built locally. GitHub distribution uses a preview release; no public npm publication or notarization is claimed.

## Not yet verified / final acceptance

- New authorization vault intentionally starts empty. Existing PolyU prototype credentials and study state were not read, migrated or erased. A fresh login is needed once.
- The packaged authorization app was opened and visually checked on macOS arm64. Its own page is monochrome, PolyU-only and free of technical setup details. School SSO/MFA was not completed during verification.
- Windows and Linux CI builds/offline tests passed as linked above. Their installers, OS keychain interactions and actual school SSO have **not been manually accepted on physical Windows/Linux systems**.
- Independent `lms ask` invocation isolation was tested; a full live model-and-school query was **not run**. Use the installed Codex plugin or compatible signed-in Codex CLI for the acceptance cases.
- Other institutions' SSO/Canvas/Blackboard compatibility was not accepted for this release; the user-facing package is intentionally limited to PolyU until separate tenant testing is complete.

Use `ACCEPTANCE.md` for final real-account checks. A fast overview is bounded: it does not prove all historical notifications or linked attachments were read. There is no daily automation or third-party calendar subscription configured by installation.

Public distribution uses the `polyu-lms` GitHub marketplace. Existing users should avoid enabling the old personal development plugin and the public plugin at the same time.
