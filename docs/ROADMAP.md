# Roadmap – ChromeOS Rclone Extension

This document describes planned features and future improvements for the project.  
As of: 2026-07-29 · Consolidated roadmap & completed milestone tracking.

---

## 🔴 High Priority – Stability & Correctness

### ⚠️ Large Directories – Pagination (partially done)
- **Problem:** `operations/list` loads all entries in one call. For folders with thousands of files, this can exhaust the WASM heap or exceed the SW memory limit.
- **Done (2026-07-19):** Entries are now delivered to the FSP in batches of 1000 via `successCallback(batch, hasMore)`, so the IPC message to the Files app stays bounded.
- **Still open:** The backend fetch itself is still a single `operations/list` call — true backend-side paging would need iterating with `opt: { limit, recurse: false }` and a continuation marker to protect the WASM heap.

---

## 🟡 Medium Priority – Features & UX

### 🔌 Add More Backends
- **Problem:** Currently only `drive`, `onedrive`, `s3`, `dropbox`, `googlecloudstorage`, `googlephotos`, `crypt`, and `memory` are compiled in. WebDAV (Nextcloud/ownCloud), for example, is completely missing.
- **Analysis (verified via source code grep for `net.Dial`/`ssh.NewClient` across all `backend/*` packages in the rclone repo, as of 2026-06-18):** The WASM build only works with backends that exclusively communicate via `net/http` (compatible with the `fetch()` transport patch from `build-wasm.sh`). Backends with custom `net.Dial`/raw TCP code fail like they originally did with `fshttp`.
- **Solution:** Add the following backends simply via `_ "github.com/rclone/rclone/backend/<name>"` import in `src/wasm-bridge/main.go` (no patch needed, pure HTTP/REST) + one wizard schema each in `config-schemas.js`:
  - **Priority 1 (widespread):** `webdav` (Nextcloud/ownCloud), `box`, `pcloud`, `b2` (Backblaze), `swift` (OpenStack), `azureblob`, `azurefiles`
  - **Other REST/HTTPS Backends (work just as well, lower user relevance):** `yandex`, `koofr`, `jottacloud`, `hidrive`, `opendrive`, `premiumizeme`, `putio`, `seafile`, `sharefile`, `sugarsync`, `quatrix`, `zoho`, `oracleobjectstorage`, `qingstor`, `internetarchive`, `netstorage`, `protondrive`, `pikpak`, `pixeldrain`, `gofile`, `filefabric`, `linkbox`, `filescom`, `filelu`, `drime`, `internxt`, `huaweidrive`, `iclouddrive`, `imagekit`, `cloudinary`, `ulozto`, `fichier`, `mailru`, `shade`, `doi`, `http` (generic read-only)
  - **Meta/Overlay Backends (work as soon as the referenced remote works — no custom network code):** `alias`, `union`, `combine`, `chunker`, `compress`, `hasher`, `archive`
- **Intentionally exclude (raw TCP, incompatible with Service Worker WASM):** `sftp` (SSH), `ftp` (Control Channel), `smb` (SMB2), `hdfs` (Hadoop RPC), `storj` (custom DRPC/Satellite protocol via `storj.io/uplink`).
- **Edge cases (extra effort needed):**
  - `mega` — looks like HTTP, but the vendored `go-mega` lib sets `net.DialTimeout` itself in a custom `http.Transport.Dial`. Would need the same Dial nullify patch as `fshttp` in `build-wasm.sh`, otherwise SW crash.
  - `sia` — speaks HTTP, but only with a local `siad` daemon (`127.0.0.1:9980`); useless for ChromeOS end users without a locally running daemon.
  - `cache`, `local` — need real persistent file system access (BoltDB or OS files), which doesn't exist in the Service Worker sandbox.

### 🔐 Encrypted Configuration
- **Problem:** The `rclone.conf` (incl. OAuth tokens and passwords) lies in plaintext in `chrome.storage.local`.
- **Solution:** AES-GCM encryption via `SubtleCrypto` API; Master password entry on first start or unlock; PBKDF2 for key derivation. The WASM core only gets the decrypted config.
- **Design constraint (2026-07-19):** A master password cannot be prompted from the Service Worker — it wakes unattended on FSP requests and must decrypt the config without user interaction, otherwise auto-remount breaks. A device-bound key (non-extractable CryptoKey in IndexedDB) would provide only marginal protection, since it lives on the same disk under the same profile. Real security therefore requires a session-unlock UX (options page decrypts and hands the config to the SW; mounts unavailable until unlocked) — this trade-off must be decided before implementation.

### 🔄 Manual Sync Command
- **Problem:** No manual trigger for sync jobs in the GUI.
- **Solution:** Button in Dashboard → trigger `sync/sync` or `sync/copy` via RC bridge; progress notification during run; cancel button via `core/stop`.

### 📤 Cross-Remote Copy / Move
- **Problem:** `onCopyEntryRequested` and `onMoveEntryRequested` only work within the same remote. Copying between two mounted remotes (e.g. Drive → S3) fails, as `srcFs` and `dstFs` would be different remotes.
- **Solution:** If `sourcePath.fileSystemId ≠ targetPath.fileSystemId`, issue a `sync/copy` call with correct `srcFs`/`dstFs`; show progress via notification.

### 📁 Upload Queue & Retry
- **Problem:** In case of network interruption during an upload, it fails silently; the user sees no indication and the file is lost.
- **Solution:** Save failed uploads in a persistent queue (`chrome.storage`); automatic retry on next SW start; notification with retry button on repeated error.

### 📡 Network Change Detection
- **Problem:** On network change (WLAN ↔ LTE, VPN), connections are not re-established; the extension returns errors without indicating the reason.
- **Solution:** Monitor `navigator.onLine` event and `chrome.system.network` (if available); on reconnect, set `rcloneConfigured = false` and recheck remotes; show offline notification.

### 🔒 Commercialization & Seamless 1-Click Registration (OAuth Gateway)
- **Problem:** For commercial consumer software, manually generating OAuth tokens via the desktop terminal (`rclone authorize`) and registering custom Google Cloud projects is an insurmountable barrier. Consumers expect a seamless 1-click login. However, directly storing the Google OAuth Client Secret in the extension is an extreme security risk (since any user can unpack the JavaScript binary and extract the secret).
- **Solution (The stateless Serverless OAuth Gateway Architecture):**
  - **1-Click Setup for the Consumer:**
    1. The user clicks a button in the options: **"Connect with Google Drive"** (or Dropbox / OneDrive).
    2. Chrome's native API `chrome.identity.launchWebAuthFlow` opens the official Google consent screen.
    3. The user logs in and clicks "Allow". The login window closes automatically and the drive is immediately ready for use.
  - **The Secure Backend Architecture:**
    - A central, extremely lean server (e.g. a Node.js Express Serverless Function on **Vercel** or **Netlify**) acts as an intermediary.
    - **Flow:** After consent, the login redirects the user to your secure server (`https://auth.your-app.com/callback?code=...`). The server receives the Authorization Code and exchanges it in the background for the real token (including `refresh_token`), using the `client_secret` securely stored in server environment variables.
    - The server finally redirects the user to `https://<your-extension-id>.chromiumapp.org/?token=...`. The extension intercepts this, extracts the token, and saves it.
  - **Operation & Costs (Practically 0 €):**
    - **Stateless & GDPR compliant:** The server stores *no* data. It receives the token JSON from Google and immediately passes it to the Chrome extension via redirect. Thus, there is no user database, no hacking risk for customer data, and GDPR compliance is a breeze.
    - **Costs:** By using **Vercel Hobby Tier** or **AWS Lambda (Free Tier)**, hosting costs (even with tens of thousands of customers) are **0.00 € per month**. The only ongoing costs amount to approx. **10–12 € per year** for the domain (e.g. `auth.your-app.com`) including a free SSL certificate.
  - **License Gate & Monetization:**
    - This authentication server can act as a central payment gate. Upon login, a license check against a billing API (like **Stripe**) can be performed. Only customers with an active subscription receive the token unlocked for the extension by the server.

### 🛡️ Permission Scope Hardening (identified 2026-07-23)
- **Problem:** `manifest.json` requests `host_permissions: ["https://*/*"]` — access to *every* HTTPS host. Because the WASM core does its own `fetch()` for arbitrary rclone remotes, a broad grant is functionally required, but a wildcard is the widest possible surface and can slow Chrome Web Store review / raise user-trust concerns.
- **Data point (2026-09-04):** v0.2.0 passed Chrome Web Store review *with* the wildcard in place and is published. So the wildcard is not a hard blocker for listing; the remaining argument for narrowing is user trust and re-review risk on future submissions, not initial acceptance.
- **Analysis:** The set of hosts actually contacted is bounded by the compiled-in backends (Google, Microsoft Graph, AWS/S3-compatible endpoints, Dropbox, etc.) — except for user-supplied S3/WebDAV/GCS endpoints, which are genuinely arbitrary and cannot be enumerated ahead of time.
- **Solution:** For the fixed OAuth backends, narrow to the concrete API hostnames (e.g. `https://*.googleapis.com/*`, `https://graph.microsoft.com/*`, `https://api.dropboxapi.com/*`, `https://content.dropboxapi.com/*`). For user-defined endpoints, request access on demand via the `optional_host_permissions` + `chrome.permissions.request()` flow when the user saves a remote whose endpoint host isn't already granted. Keep `https://*/*` only as an optional fallback the user can opt into.

---

## 🟢 Low Priority – Quality & Developer Experience

### 🧹 WASM Memory Management
- **Problem:** The Go WASM heap grows during runtime and is never shrunk (Go's GC does not return memory to the OS). With very long runtimes, this can lead to OOM in the SW.
- **Solution:** Expose `runtime.GC()` via `self.rcValid` after large operations; ability to deliberately restart the SW (all open files must be closed beforehand).

### 🐛 Debug Panel in the Options Page
- **Problem:** Error diagnosis requires opening DevTools; normal users cannot collect logs.
- **Solution:** New "Diagnosis" tab in the options page: shows SW log buffer (last N lines), WASM version info (`core/version`), cache stats (entries in L1/L2), and an "Export Error Report" button.

### 📦 Build Pipeline & Versioning
- **Problem:** The WASM build is a manual process (`build-wasm.sh`); the extension version number in `manifest.json` is maintained manually.
- **Solution:** GitHub Actions Workflow: automatically compile WASM on Git tag, create extension zip, derive `manifest.json` version from tag, and upload as release asset.

### 🧪 Automated Tests (started)
- **Problem:** There are no automated tests for the FSP handler logic or the WASM bridge.
- **Done (2026-07-19):** The pure helpers (`parseIniConfig`, `serializeIniConfig`, `sanitizeTokenValue`, `getParentPath`, `mapErrorToFsp`) were extracted into `src/config-utils.js` and are covered by Node unit tests in `tests/config-utils.test.js` (run with `node --test tests/*.test.js`).
- **Solution:** 
  - Go unit tests for `jsStreamReader` and `fileWriteStream` in the `wasm-bridge` package.
  - Jest tests (Node.js) for `background.js` helper functions (`parseIniConfig`, `sanitizeTokenValue`, cache logic) via mocking of Chrome APIs.
  - Playwright/Puppeteer E2E test against a local Rclone instance (memory backend).

### 🌐 Further Localizations & Globalization Plan (i18n Strategy)
- **Problem:** The extension is currently only available in German and English. To successfully tap into global markets commercially (especially USA, Asia, and Europe), other important languages must be natively supported. Incomplete translations lead to empty UI elements or ugly language mixes.
- **Solution (Detailed Translation Plan):**
  1. **Prioritized Target Languages:**
     * **Europe:** Spanish (`es`), French (`fr`), Italian (`it`), Portuguese (`pt`).
     * **Asia:** Japanese (`ja`), Chinese (Simplified, `zh_CN`), Korean (`ko`).
  2. **i18n Platform Integration (Crowdin / Weblate):**
     * Integration of an open-source or crowdsourcing translation tool like **Crowdin** or **Weblate**.
     * Developers upload the `src/_locales/en/messages.json` as the source file; the community or professional translators maintain the other languages online.
  3. **Automated CI/CD License & Key Check (Linter Script):**
     * Set up a GitHub Actions Node.js pre-commit script that compares the `messages.json` files of all languages.
     * **Goal:** The script immediately reports an error if a key is missing in any language that exists in the default language (`en` / `de`), preventing runtime errors (`undefined` or empty UI labels).
  4. **Dynamic i18n Fallback:**
     * Ensure that the JavaScript (`applyI18n`) automatically falls back to the English translation if translations are missing in a target language (`chrome.i18n.getMessage` does this by default, but it must be robustly secured in the custom code).

### ✅ Stale Testing Documentation & Test Command (identified 2026-07-27 · done 2026-09-04)
- **Problem:**
  - `docs/TESTING.md` still describes the April mock-phase build: mounting shows a single hardcoded `test-file.txt` containing `Hello from Rclone WASM!`. The extension has long since moved past static mock FSP handlers to real rclone-backed CRUD, so the verification steps no longer match actual behavior and can't be followed as a real smoke test.
  - The test command documented in `tests/config-utils.test.js` (`node --test tests/`) and referenced in the README fails with `MODULE_NOT_FOUND` on current Node — `node --test tests/` does not glob `.test.js` files the way `node --test tests/*.test.js` does. Only the latter (also documented in `package.json`-less form in README's project structure table) actually runs the suite.
- **Solution:** Rewrite `docs/TESTING.md` against the current FSP flow (real remote listing/read/write/thumbnails/context menu, not a static dummy file), and correct the test invocation everywhere it's documented (`README.md`, `tests/config-utils.test.js` header comment, `docs/ROADMAP.md`'s own "Automated Tests" section) to `node --test tests/*.test.js`.
- **Done (2026-09-04):** `docs/TESTING.md` rewritten against current behaviour — unit tests, install, real-remote CRUD, the 4 MB buffered/streaming upload split, thumbnails, all four context-menu actions, dashboard health checks including the `invalid_grant` path, and unmount. The stale `node --test tests/` invocation was corrected in `tests/config-utils.test.js`; the README's clone URL still pointed at the pre-rename `chromeos-filesystem-rclone.git` (which does not resolve) and now uses `OmniFiles.git`.
