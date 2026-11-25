# Changelog

All notable changes to `lms-cli` are documented in this file.
Detailed Chinese release notes for published versions live under `docs/releases/`.

## [Unreleased]

### Added
- **Canvas original file downloads** (`lms download` CLI & `lms_download_file` MCP tool): stream original files with size/HTML/PDF checks, CDN credential stripping, atomic no-replace publication, and bounded module/page fallback when Canvas course Files returns 403.
- **Repository automation & community infrastructure**:
  - Added `scripts/check-repo.mjs` (`npm run check:repo`) for version sync, marketplace validation, and relative Markdown link checks.
  - Added `scripts/bump-version.mjs` (`npm run release:bump <X.Y.Z>`) for synchronized version bumps.
  - Enhanced CI with concurrency cancellation, repo hygiene checks, and macOS Electron auth verification.
  - Added CodeQL + dependency review + weekly production `npm audit` workflow (`.github/workflows/security.yml`), automated tag-to-draft release workflow (`.github/workflows/release.yml`), auto-labeler & first-time contributor welcome (`.github/workflows/community.yml`), stale automation, and Dependabot configuration.
  - Added `CODE_OF_CONDUCT.md`, bilingual `README.md` / `README.zh-CN.md`, structured Issue Forms, `docs/COMPATIBILITY.md`, and `docs/ROADMAP.md`.

### Security
- Upgraded `@modelcontextprotocol/sdk` (`1.32.2`), `electron` (`44.11.6`), `zod` (`4.6.7`), and transitive packages to resolve all production `npm audit --omit=dev` advisories (0 vulnerabilities).

## [0.4.7] - 2026-10-04

See [docs/releases/v0.4.7.md](docs/releases/v0.4.7.md).

- Added HTTP `Range` resumable downloads with retries in `lms update`.
- Upgraded `install.sh` to stall-based curl limits (`-C -`, up to 5 attempts) instead of fixed 180s timeout.
- Updated `install.ps1` to resolve the latest stable tag via GitHub redirect headers before falling back to the REST API.

## [0.4.6] - 2026-10-04

See [docs/releases/v0.4.6.md](docs/releases/v0.4.6.md).

- Replaced fixed 180s update download timeout with 60s stall detection and 30-minute total budget.

## [0.4.5] - 2026-10-04

See [docs/releases/v0.4.5.md](docs/releases/v0.4.5.md).

- Added single retry for transient GitHub web lookup resets and quota-free latest-tag lookup in `install.sh`.

## [0.4.4] - 2026-10-03

See [docs/releases/v0.4.4.md](docs/releases/v0.4.4.md).

- Switched default update checks from anonymous GitHub REST API to quota-free GitHub release page redirects with REST fallback.

## [0.4.3] - 2026-10-03

See [docs/releases/v0.4.3.md](docs/releases/v0.4.3.md).

- Added Claude Code plugin and repository marketplace (`plugins/lms-cli-claude/` and `.claude-plugin/marketplace.json`).
- Retried MCP session update checks after transient failures.

## [0.4.2] - 2026-09-29

See [docs/releases/v0.4.2.md](docs/releases/v0.4.2.md).

- Split Blackboard to-do requests into bounded 15-day windows and merged deduplicated results.
- Added experimental opt-in remember-password, automatic login, and local TOTP fill in the isolated authorization window.

## [0.4.1] - 2026-09-21

- Added macOS Developer ID signing and Apple notarization pipeline for standalone CLI and authorization app artifacts.

## [0.4.0] - 2026-09-21

- Multi-school CLI setup (`lms setup`), public Canvas school directory discovery, self-contained standalone bundles, and verified atomic self-updater with rollback.

## [0.2.0] - 2026-09-20

- Initial public preview release (PolyU Canvas & Blackboard read-only CLI, MCP server, and Electron authorization helper).
