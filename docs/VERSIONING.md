# Versioning System

This project follows [Semantic Versioning 2.0.0](https://semver.org/).

## Structure: `MAJOR.MINOR.PATCH`

1.  **MAJOR**: Breaking changes to the internal architecture, configuration format, or WASM bridge that require user intervention or manual config migration.
2.  **MINOR**: New features, new rclone backends, or significant UI improvements (e.g., the Configuration Wizard).
3.  **PATCH**: Bug fixes, performance optimizations, and minor UI tweaks.

## Management Workflow

### 1. Update `manifest.json`
The `version` field in `src/manifest.json` is the single source of truth for the browser.
```json
"version": "0.2.0"
```

### 2. Update `CHANGELOG.md`
When a significant milestone is reached, the version should be noted in the session header or a dedicated version block.

### 3. Build Artifacts
Zip files created for testing should ideally follow the pattern:
`chromeos-rclone-v[VERSION]-[TIMESTAMP].zip`
Example: `chromeos-rclone-v0.2.0-20260419-1515.zip`

## Current Version State (as of 2026-09-04)
- **Current Version**: `0.3.0`
- **Reason**: First-run experience (Onboarding Plan phase 3) — settings page opens on install, Guided Setup is the single add route and the landing tab when no remotes exist, provider picker grouped by setup effort. Plus two Dashboard bug fixes (hardcoded English, misleading empty state) and HTML escaping for config data on the options page.

### Previous
- `0.2.0` (2026-04-19) — Major UI overhaul (Wizard), added multiple backends (Dropbox, GCS, SMB, Crypt), and critical performance optimizations (Lazy Creation/Debouncing).
