# Package Manager Manifests (Homebrew / Scoop / Winget)

`lms-cli` generates deterministic package manager manifests directly from each release's verified `SHA256SUMS.txt` and standalone GitHub Release archives via `scripts/generate-package-manifests.mjs`.

## Generating Manifests from a Release

```sh
npm run pack:manifests -- \
  --version 0.4.7 \
  --checksums /path/to/SHA256SUMS.txt \
  --out ./release-manifests
```

Generated output layout:

```text
release-manifests/
├── homebrew/Formula/lms-cli.rb
├── scoop/bucket/lms-cli.json
└── winget/manifests/z/zs-andy/lms-cli/<version>/
    ├── zs-andy.lms-cli.yaml
    ├── zs-andy.lms-cli.locale.en-US.yaml
    └── zs-andy.lms-cli.installer.yaml
```

The release workflow (`.github/workflows/release.yml`) runs this generator automatically when preparing a draft GitHub Release and attaches `lms-cli.rb`, `lms-cli.json`, and `lms-cli-<version>-package-manifests.tar.gz` alongside `SHA256SUMS.txt`.

## Package Manager Behavior with `lms update`

When `lms-cli` is installed via Homebrew, Scoop, or Winget:

- The wrapper sets `LMS_INSTALL_MANAGER` (`homebrew`, `scoop`, or `winget`) and `LMS_INSTALL_LAUNCHER` (pointing to the package manager's stable launcher path so MCP / Codex configs survive upgrades).
- `lms-cli` also recognizes Homebrew Cellar (`/Cellar/lms-cli/`), Scoop (`/scoop/apps/lms-cli/`), and Winget (`/WinGet/Packages/zs-andy.lms-cli`) installation paths automatically.
- `lms doctor` reports `"installation": "homebrew" | "scoop" | "winget"` and includes the matching `upgradeCommand`.
- `lms update` and `lms update --rollback` never overwrite package-manager-managed files; instead they instruct the user to run:
  - Homebrew: `brew upgrade lms-cli`
  - Scoop: `scoop update lms-cli`
  - Winget: `winget upgrade --id zs-andy.lms-cli`

School profiles, encrypted sessions, and local tasks stay in the user's application-data directory (`LMS_HOME`), completely separate from package manager directories.
