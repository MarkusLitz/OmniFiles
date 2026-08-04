# Changelog – ChromeOS Rclone Extension

This document maintains a chronological record of all development steps.

---

## 2026-04-13 07:17 – Session 1 (Conversation ab0fbe03)

### Phase 1: WASM Tooling
- Created: `src/wasm-bridge/main.go` – Go/WASM Bridge exposing Rclone's RC API to JavaScript via `syscall/js`
- Created: `build-wasm.sh` – Build script for compiling the WASM binary (`GOOS=js GOARCH=wasm`)
- Created: `docs/WASM_BUILD.md` – Build documentation
- Updated: `src/wasm_exec.js` – JavaScript glue for the Go WASM runtime

### Phase 2: Extension Architecture
- Created: `src/manifest.json` (MV3) – Permissions: `fileSystemProvider`, `storage`, `unlimitedStorage`, etc.
- Created: `src/background.js` – MV3 Service Worker skeleton; loads WASM and waits for initialization via `self.rcValid` Promise

### Phase 3: Configuration UI
- Created: `src/options.html` – Configuration page for pasting the `rclone.conf`
- Created: `src/options.js` – Saves `rclone.conf` content in `chrome.storage.local`

---

## 2026-04-13 10:39 – Session 2 (Conversation c820977f – this session)

### Context Clarification
- Project contexts (`chromeos-filesystem-rclone` vs. `Dark Tunes`) were clearly separated

### Phase 4.2: Mount Logic (`background.js`)
- Implemented: `configureRclone()` – Reads `rclone.conf` from storage and waits for WASM readiness
- Implemented: `onMountRequested` – Calls `chrome.fileSystemProvider.mount()` and saves mount info
- Implemented: `onUnmountRequested` – Cleans up mount from storage

### Phase 4.3 (Mocks): File System Callbacks
- Implemented: `onGetMetadataRequested` – Static response for `/` and `/test-file.txt`
- Implemented: `onReadDirectoryRequested` – Statically returns a dummy file `test-file.txt`
- Implemented: `onOpenFileRequested`, `onReadFileRequested`, `onCloseFileRequested` – Reading dummy data ("Hello from Rclone WASM!")

### Documentation
- Created: `docs/TESTING.md` – Step-by-step guide for testing on the Chromebook

### Test Build Infrastructure
- Created: `test_builds/` directory (added to `.gitignore`)
- Established convention: Build files always with timestamp `chromeos-rclone-extension-YYYYMMDD-HHMMSS.zip`
- First build generated: `test_builds/chromeos-rclone-extension-20260413-124427.zip`

---

## 2026-04-13 11:13 – Project Planning & Roadmap

### Documentation
- Created: `implementation_plan.md` (Artifact) – Complete roadmap plan (Phases 1–6)
- Created: `task.md` (Artifact) – Living task list updated with every step

---

## 2026-04-13 12:36 – Phase 4.1: Configuration Injection Logic

### `background.js`
- Implemented: `parseIniConfig()` – JavaScript INI parser for `rclone.conf` in INI format
- Implemented: `configureRclone()` now uses `parseIniConfig()` and calls `self.rc('config/create', ...)` for each remote so the WASM core knows the remotes
- `configureRclone()` now returns `Object.keys(parsedConf)`, allowing the mount handler to use the name of the first remote as `activeRemote`

### Test Build
- Generated: `test_builds/chromeos-rclone-extension-20260413-124427.zip` (first version)
- Generated: `test_builds/chromeos-rclone-extension-20260413-124427v2.zip` (after Chromebook test feedback)

---

## 2026-04-13 13:38 – Phase 4.3: Real RC Calls

### `background.js`
- Refactored: `onGetMetadataRequested` – Now uses `self.rc('operations/stat', { fs, remote })` instead of mock data
- Refactored: `onReadDirectoryRequested` – Now uses `self.rc('operations/list', { fs, remote, opt })` instead of mock data
- Introduced: `activeRemote` – Variable dynamically set during the mount process from the first entry of the parsed config; eliminates all hardcoded remote names
- Mount display name now includes the remote name: e.g. `Rclone Mount (gdrive:)`

### Test Build
- Generated: `test_builds/chromeos-rclone-extension-20260413-134018.zip`
- Generated: `test_builds/chromeos-rclone-extension-20260413-141928.zip`

---

## 2026-04-13 14:22 – Changelog & Traffic Test Preparation

### Documentation
- Created: `docs/CHANGELOG.md` (this file) – Chronological log of all development steps

### Next Steps
- Live traffic test with Google Drive `rclone.conf` planned
- Observing CORS behavior of the WASM backend in the browser context
- Phase 5 (Networking & Caching) is up next

## 2026-04-13 14:24 – Integrity Build
- New build created: `test_builds/chromeos-rclone-extension-20260413-142450.zip` (now also includes the `docs/` folder)

## 2026-04-13 15:27 – Phase 5.1: Networking Debugging
- Expanded permissions in `manifest.json` (`host_permissions`: `https://*/*`) to allow real cloud traffic.
- Added verbose logging in `background.js` for `operations/list` and `operations/stat`.
- New build created: `test_builds/chromeos-rclone-extension-20260413-152742.zip`

## 2026-04-13 15:32 – Fix: RC Config Payload Structure
- Error analysis of Chromebook logs: `config/create` failed because Rclone explicitly expects the parameters in a `"parameters"` object.
- Update `background.js`: Corrected payload structure so `type` is on top-level and all other fields are passed in `parameters: {}`.
- This fix resolves the *"didn't find section in config file"* error, as remotes are now correctly registered in WASM memory.
- New build created: `test_builds/chromeos-rclone-extension-20260413-153158.zip`


## 2026-04-13 17:42 – Fix: Service Worker Wakeup Lifecycle
- Identified the issue where MV3 Service Workers lost the configuration state of Rclone upon *waking up*.
- New logic: `configureRclone()` checks the state and, if necessary, pushes the config into the WASM module again *before* file operations are performed.
- Implemented metadata cleanup (`onGetMetadataRequested`) to prevent ChromeOS warnings about unrequested/incorrect data types.
- New build created: `test_builds/chromeos-rclone-extension-20260413-174250.zip`

---

## 2026-04-13 17:47 – Fix: OAuth Deadlock in WASM (Critical!)

### Cause
- `config/create` RC command triggers the interactive OAuth wizard
- In WASM: attempts to start a local HTTP server + open browser → **Goroutine Deadlock** → Go program crashes
- All subsequent RC calls fail with *"Go program has already exited"*

### Solution: `configInject` Bridge Function
- **New in `main.go`**: Function `configInjectCallback()` – writes configuration key-values directly via `config.FileSetValue()` into the in-memory store
- Completely bypasses the interactive OAuth flow, since tokens are already contained in the `rclone.conf`
- Registered as `self.configInject(name, params)` on the global JS object

### Changes
- `src/wasm-bridge/main.go`: Import of `fs/config`, new `configInjectCallback` function, global registration
- `src/background.js`: `self.rc('config/create', ...)` replaced by `self.configInject(remoteName, remoteConfig)`
- `src/rclone.wasm`: Recompiled with the updated bridge

### Test Build
- Generated: `test_builds/chromeos-rclone-extension-20260413-174754.zip`

---

## 2026-04-13 17:55 – Fix: activeRemote Bug & Token Sanitization

### Bug Fix: activeRemote Assignment
- Bug fix: `configureRclone()` now returns a string. The mount handler falsely treated this as an array, leading to incorrect remote names (e.g. `"z:"` instead of `"ziraInfo:"`).
- Corrected: The mount handler now directly uses the module-wide `activeRemote` string set by `configureRclone()`.

### Robustness: OAuth Token Sanitization
- Problem: When copying `rclone.conf` into textareas, colons in JSON timestamps ("expiry") could be replaced by spaces. This led to parsing errors in the Rclone core.
- Implemented: `sanitizeTokenValue()` in `background.js` automatically identifies and repairs these corrupt timestamps before injection into the WASM core.

### Test Build
- Generated: `test_builds/chromeos-rclone-extension-20260413-175556.zip`

---

## 2026-04-13 18:05 – Fix: WASM HTTP Transport (DNS/TCP Blocker)

### Cause
- Go's `fs/fshttp` sets `DialContext` to `http.Transport` → mandatory TCP/DNS path
- In Chrome Extension Service Workers, Go's WASM fake DNS resolver ([::1]:53) cannot write UDP packets
- Error: `dial tcp: lookup www.googleapis.com on [::1]:53: write: Connection reset by peer`

### Solution: Build Tag-specific HTTP Transport
- **`build-wasm.sh`** automatically patches `fs/fshttp/` during build:
  - Moves `NewTransportCustom` + `NewTransport` from `http.go` → `transport_notjs.go` (`//go:build !js`)
  - Adds `transport_js.go` (`//go:build js && wasm`) with `DialContext = nil` and `DialTLSContext = nil`
  - Go WASM thereby natively uses `fetch()` for all HTTP/HTTPS calls – no TCP/DNS needed

### Test Build
- Recompiled: `src/rclone.wasm`
- Generated: `test_builds/chromeos-rclone-extension-20260413-180554.zip`

---

## 2026-04-13 18:31 – Fix: TLSClientConfig nil pointer in WASM Transport

### Cause
- The newly injected js/wasm HTTP transport in `transport_js.go` omitted the initialization of `t.TLSClientConfig`.
- The method `RoundTrip` in `fs/fshttp/http.go` calls `isCertificateExpired(t.TLSClientConfig)`.
- Because `t.TLSClientConfig` was now `nil` in the WASM build, `len(cc.Certificates)` caused an "invalid memory address or nil pointer dereference" (Panic/Segfault) in the WASM module during evaluation, crashing the Go process.

### Solution
- **`build-wasm.sh`** now adds the initialization of `TLSClientConfig` to the injected `transport_js.go` (including import of `crypto/tls`), analogous to the non-js implementation.
- Idempotency was also added to the script (`git restore fs/fshttp/http.go`) so it survives consecutive builds cleanly.

### Test Build
- Recompiled: `src/rclone.wasm`
- Generated: `test_builds/chromeos-rclone-extension-20260413-183112.zip`

---

## 2026-04-13 18:44 – Fix: Go WASM Fetch Deadlock (rcCallback)

### Cause
- The call to `operations/list` froze with the message `fatal error: all goroutines are asleep - deadlock!`.
- **Problem:** The function `rcCallback` exported in `main.go` was called synchronously in JavaScript. However, Rclone internally started a network request (`fetch()` via `net/http.(*Transport).RoundTrip`), which parked the executing goroutine in the background until the promise resolved. Since the JavaScript Event Loop was completely blocked by the synchronous call of `rcCallback`, the `fetch()` promise could never resolve. Go detected this (all goroutines asleep) and crashed with a deadlock.

### Solution
- The `rcCallback` WASM bridge in `src/wasm-bridge/main.go` was radically rewritten. It now **immediately** returns a classic `Promise` to JavaScript.
- The execution of the Rclone API calls (which touch the network) is moved to an asynchronous Go goroutine (`go func()`). As soon as it's finished, the JS callbacks `resolve` or `reject` are called.
- The JavaScript caller in `background.js` already uses `await self.rc(...)`, which perfectly correlates with the new Promise-based API and no longer blocks the main Event Loop.

### Expected Result
- The mount call to the Google Drive directory no longer blocks, and `operations/list` can successfully stream the file data via the fetch wrapper.

### Test Build
- Recompiled: `src/rclone.wasm`
- Generated: `test_builds/chromeos-rclone-extension-20260413-184446.zip`

---

## 2026-04-13 19:06 – Feature: Ranged File Reading (Streaming)

### Changes
- **Go WASM Bridge (`main.go`):** Implemented new function `fileRead`. This uses `fs.RangeOption` to specifically request byte ranges (streaming) and transfers data via `js.CopyBytesToJS` losslessly and without Base64 overhead as `Uint8Array`.
- **Background Script (`background.js`):** Mock handlers replaced by real logic.
  - `onOpenFileRequested`: Validates file existence via Stat.
  - `onReadFileRequested`: Uses asynchronous `fileRead` streams.
  - `onCloseFileRequested`: State cleanup.

### Test Build
- Recompiled: `src/rclone.wasm`
- Generated: `test_builds/chromeos-rclone-extension-20260413-190621.zip`

---

## 2026-04-13 22:04 – Fix: Metadata Flooding & Timeout

### Cause
- ChromeOS Files app requested metadata for all files in parallel.
- The handler returned all fields (name, size, date) unprompted, leading to `InvalidStateError` and redundant network requests (Stat flood).

### Solution
- **`background.js`:** `onGetMetadataRequested` was optimized to only populate fields that were explicitly requested in `options`. This prevents validation errors in the ChromeOS File Manager and drastically reduces network load.

### Test Build
- Generated: `test_builds/chromeos-rclone-extension-20260413-220403.zip`

---

## 2026-04-18 16:41 – Feature: Full Write Access (CRUD)

### Changes
- **Go WASM Bridge (`main.go`):**
  - Implemented: `fileWrite` – Uses `operations.Rcat` to upload binary data from JavaScript losslessly.
  - Fix: Local function `time()` renamed to `jsTime()` to avoid collision with the `time` package.
- **Background Script (`background.js`):**
  - Implemented: `onCreateDirectoryRequested` (mkdir), `onDeleteEntryRequested` (purge/deletefile), `onMoveEntryRequested` (move/movefile).
  - Implemented: **File writing via buffering** – Since cloud backends usually don't support partial write operations, changes are buffered in RAM (`Uint8Array`) and only uploaded fully upon closing (`onCloseFileRequested`).
  - Optimization: `onOpenFileRequested` preloads existing files into RAM only up to a size of 50 MB to prevent crashes.

### Known Limitations
- **RAM Limit:** Since uploads are buffered in RAM, very large files (e.g. > 500 MB, depending on Chromebook model) can crash the Service Worker. Real chunked streaming will provide a remedy later.

### Test Build
- Recompiled: `src/rclone.wasm`
- Generated: `test_builds/chromeos-rclone-extension-20260418-164132.zip`

---

## 2026-04-18 16:47 – Feature: Multi-Remote Support

### Changes
- **Service Worker (`background.js`):**
  - Parallel Mounting: `onMountRequested` iterates through all remotes found in the configuration and mounts them individually. For instance, if you have 3 Drives in `rclone.conf`, 3 Drives now appear in parallel!
  - Dynamic Callback Routing: Each FileSystemProvider callback now dynamically extracts the remote name from `options.fileSystemId` and routes requests to the corresponding remote in the Rclone WASM core.
  - Global variable `activeRemote` eliminated - this prevents state conflicts (race conditions) during file operations across multiple remotes.
- **Config UI (`options.html`):**
  - Description text updated.

### Test Build
- Generated: `test_builds/chromeos-rclone-extension-20260418-164756.zip`

---

## 2026-04-18 16:53 – Feature: Metadata Pre-Caching

### Changes
- **Service Worker (`background.js`):**
  - Implemented: `statCache` – A memory-based metadata cache (60 seconds TTL).
  - Implemented: **Pre-Populating Strategy** – Upon calling `onReadDirectoryRequested`, the Service Worker iterates over the list of files from the Rclone core and immediately inserts every reported file into the `statCache`.
  - Implemented: If ChromeOS subsequently initiates `onGetMetadataRequested` for these newly read files, the result is now served from the cache in < 1ms ("Cache Hit") instead of querying Google Drive via the Rclone API. This fixes the known timeouts.
  - Implemented: **Cache Invalidation** – Every write operation (`onCreateDirectoryRequested`, `onDeleteEntryRequested`, `onMoveEntryRequested`, `onCreateFileRequested`, successful upload in `onCloseFileRequested`) triggers `invalidateCache()` for the affected path and the parent directory to prevent data shadows.

### Test Build
- Generated: `test_builds/chromeos-rclone-extension-20260418-165339.zip`

---

## 2026-04-18 17:01 – Feature: Thumbnail Generation (Grid View)

### Changes
- **Service Worker (`background.js`):**
  - Implemented: `generateThumbnail()` uses native browser APIs (`OffscreenCanvas` & `createImageBitmap`) to generate thumbnails resource-efficiently in the background process.
  - Implemented: `onGetMetadataRequested` now responds to `options.thumbnail == true`. 
  - Logic: For known image formats (`isImageFile()`) under 20 MB, the entire file is loaded into the Service Worker via `fileRead()` (WASM stream), proportionally scaled to max. 320x320, and appended as a `base64` Data URI to the result.
  - Caching: Generated thumbnails are stored in the existing `statCache` so that repeated ChromeOS requests don't trigger new image downloads.
- **Cleanup:** Old `fetch-thumbnail.js` mock script removed, since native on-the-fly generation now works.

### Test Build
- Generated: `test_builds/chromeos-rclone-extension-20260418-170239.zip`

---

## 2026-04-18 17:09 – Feature: Upload Progress Indicator

### Changes
- **WASM Bridge (`main.go`):**
  - Implemented: Custom `io.Reader` wrapper (`progressReader`) to monitor the data flow from RAM into the Rclone network channel.
  - Implemented: The asynchronous JS interface `fileWrite` now optionally accepts a JS callback as the fourth argument, to which the Go process passes status updates (loaded bytes vs. total bytes) in millisecond intervals.
- **Service Worker (`background.js`):**
  - Implemented: When `onCloseFileRequested` triggers for a file > 100 KB, the extension creates a visible `chrome.notifications` of type `progress` (with a ChromeOS loading bar).
  - Implemented: The Go callback updates the bar in real time until it reaches 100%, after which the info stays for another 3 seconds before fading.
  - Error handling: If the request crashes (e.g. connection loss), the loading bar is converted into an error notification.

### Test Build
- Generated: `test_builds/chromeos-rclone-extension-20260418-170926.zip`


---

## 2026-04-19 13:30 – Session 7fa22525: Stability & API Compliance (v0.2.0-pre)

### Bug Fixes (Critical)
- **Mount Timeout Fix**: `onMountRequested` now calls `successCallback` immediately/synchronously. This prevents ChromeOS from aborting the mount due to a timeout or reporting "No matching signature" errors.
- **API Compatibility**: `notifyChange` now sends the `changeType` property both at the root level and within the `changes` array, resolving incompatibilities between different ChromeOS versions.
- **EOF Handling**: A bug in `onReadFileRequested` was fixed where requests at the end of the file led to an HTTP 416 error. We now signal EOF correctly via an empty buffer.
- **WASM Bridge Fix**: Correction of the argument count for `fileWrite` in the WASM module to resolve a fatal `TypeError` during uploads.

---

## 2026-04-19 14:10 – Session 7fa22525: UI Overhaul & Configuration Wizard (v0.2.0-pre)

### Modern Design & UX
- **Tabbed Interface**: The configuration page (`options.html`) has been completely redesigned. It now offers tabs for "Manage", "Add New", and "Advanced".
- **Configuration Wizard**: A new schema-based wizard allows the creation of remotes without manual INI knowledge.
- **New Provider Schemas**: Added support for Dropbox, Google Cloud Storage (GCS), SMB/CIFS, and Crypt (Encryption).
- **Remote Selection**: A dynamic dropdown menu was implemented for overlay remotes like `crypt`, which automatically lists existing remotes.

### Branding & Clean-up
- **Custom Logo**: The project now uses the new "Multi-Hub" logo. Icons have been optimized for all required sizes (16px to 128px) and converted into the correct PNG format.
- **Manifest Cleanup**: Removed old test code (`filterdemo.wasm`), redundant permissions, and commented-out sections.

---

## 2026-04-19 15:08 – Session 7fa22525: Performance Optimization (v0.2.0)

### "Copy Turbo" for Directories
- **Lazy File Creation (Virtual Files)**: File creation is now delayed. When copying many small files, the initial network requests for 0-byte files are omitted. The actual upload only occurs upon file closure.
- **Synthetic Metadata**: Requests for metadata for "virtual" files not yet uploaded are immediately answered from memory, massively reducing network overhead.
- **Notification Debouncing (Throttling)**: Notifications about file changes are now buffered for 200ms. Instead of hundreds of individual events, the extension only sends one combined update per directory to the system. This prevents the Files app from freezing during large copy operations.
- **API Guarding**: All API listeners were equipped with safety checks (`registerListener`) to prevent crashes in browser versions lacking specific events.

---

## 2026-04-22 13:51 – Session (Current Session)

### Feature: Support for More Backends
- **WASM Bridge (`main.go`)**: Added imports for `crypt`, `onedrive`, `s3`, `ftp`, `sftp`, `dropbox`, `googlecloudstorage` (GCS), and `smb`.
- **Fix**: Corrected import path for GCS from `gcs` to `googlecloudstorage`.

### Build System & Compatibility
- **`build-wasm.sh`**: 
  - Made `sed` commands macOS compatible (`sed -i ''`).
  - Changed Go tarball to `darwin-arm64` to be executable on Apple Silicon Macs.
- **Result**: Successful build of `rclone.wasm` with all new providers (size increased from ~42MB to ~76MB).

### Feature: Syntax Highlighting & Connection Test
- **GUI (`options.html` & `options.js`)**:
  - Implemented syntax highlighting for the raw config editor in the "Advanced" tab (INI format).
  - Added "Test Connection" button.
- **Background Script (`background.js`)**:
  - Added message listener for `testConnection`.
  - Uses `operations/list` via WASM to test the configuration live.

### Feature: UI/UX Optimizations
- **GUI (`options.js` & `config-schemas.js`)**:
  - Marked `WebDAV` as unsupported (since not compiled into WASM).
  - Dropdown in the wizard now shows `(Not supported)` for WebDAV and greys it out.
- **GUI (`options.html` & `options.js`)**:
  - Status messages now fade in and out smoothly (using CSS transitions for `max-height` and `opacity`).

### Feature: Visual Redesign
- **GUI (`options.html`)**:
  - Integrated *Inter* font via Google Fonts.
  - Switched color palette to a modern Indigo/Slate scheme.
  - Modernized layout with softer shadows, larger corner radii, and improved input focus rings.
  - Added micro-animations (fade-in for tabs, hover effects for buttons).

### Feature: Guided Setup
- **GUI (`options.html` & `options.js`)**:
  - Added new "Guided Setup" tab with a step-by-step wizard (Stepper).
  - Guides the user through Name/Type, Credentials, Options, and Connection Test.
  - Uses existing schemas from `config-schemas.js` for dynamic field generation.

### Bug Fixes
- **GUI (`options.html`)**:
  - Corrected missing closing `</div>` for the Guided Setup Tab that made the Advanced Tab invisible.
  - Removed transparency of the textarea in the Advanced Tab as it led to rendering issues.

---

## 2026-05-04 22:34 – Session (Current Session)

### Feature: Config Import/Export
- **GUI (`options.html` & `options.js`)**:
  - Added "Export Config" and "Import Config" buttons in the Advanced Tab.
  - Export downloads the current configuration as `rclone.conf`.
  - Import allows loading a local file into the editor.

### Feature: Real Dark Mode
- **GUI (`options.html` & `options.js`)**:
  - Implemented full Dark Mode.
  - Added CSS variables for dark theme.
  - Added toggle button in the sidebar.
  - Saves the preference and respects the system theme.

### Feature: Background Connection Test
- **Manifest (`manifest.json`)**: Added `"alarms"` permission.
- **Background Script (`background.js`)**:
  - Set up periodic alarm (every 5 minutes).
  - Checks reachability of remotes via `operations/list` and stores status.
- **GUI (`options.html` & `options.js`)**:
  - Added status dots (Online/Offline/Unknown) in the list of remotes.

### Feature: Mount Dashboard
- **GUI (`options.html` & `options.js`)**:
  - Added new "Dashboard" tab as the home page.
  - Displays active mounts, storage usage (via `operations/about`), and active uploads.
- **Background Script (`background.js`)**:
  - Message handler `getDashboardData` provides data for the dashboard.

---

## 2026-05-13 – Session: Write-Streaming, IndexedDB-Cache, Right-Click Actions, i18n (Conversation 7588a026)

### Feature: Real Write-Streaming (Chunked Uploads)

**Problem:** Files > 50 MB exceeded the RAM limit of the Service Worker during buffer-based uploads.

- **WASM Bridge (`src/wasm-bridge/main.go`)**:
  - Exported new function `fileWriteStream`: receives a JavaScript `ReadableStream` and feeds its chunks via `jsStreamReader` (custom `io.Reader`) directly into `operations.Rcat`.
  - Full RAM buffering no longer necessary – chunks are forwarded directly to Rclone.
  - `jsStreamReader.Read()` blocks synchronously on JS promise resolution via `jsAwait()`.
- **Background Script (`background.js`)**:
  - Introduced hybrid upload model: Files < 4 MB continue using the buffer path, larger files are streamed via `TransformStream` + `fileWriteStream`.
  - `pendingChunks` queue (map by byte offset) ensures correct order during asynchronous `onWriteFileRequested` calls.
  - Upload progress notifications for both paths (Stream: finalization notification; Buffer: percentage progress).
- **WASM Binary**: Recompiled (`rclone.wasm`, ~73 MB).

### Feature: Persistent Metadata Cache (IndexedDB)

**Problem:** Upon restarting the Service Worker, the RAM cache was lost, leading to redundant network requests.

- **Background Script (`background.js`)**:
  - **L1 Cache (RAM):** `statCache` map with 5-minute TTL (unchanged, fastest access).
  - **L2 Cache (IndexedDB):** New database `rclone-stat-cache`, store `entries` – survives SW restarts, 24-hour hard TTL.
  - Singleton connection pattern (`_idbPromise`) prevents redundant `indexedDB.open()` calls.
  - `cacheGet()`: Checks L1 → L2 → Network; on L2 hit, the entry is promoted to L1.
  - `cacheSet()`: Write-through to both layers (IDB write errors are fire-and-forget).
  - `invalidateCache()`: Deletes entry from RAM map and IDB store.
  - Startup Cleanup: Removes IDB entries older than 24h at SW start (fire-and-forget).
  - Thumbnails are also stored persistently in IDB (no re-download needed).

### Feature: Right-Click Actions (Context Menu / FSP Context Menu)

**Problem:** Rclone functions like link generation were not directly accessible from the ChromeOS file manager.

- **Manifest (`manifest.json`)**: Added `"tabs"` and `"notifications"` permissions.
- **Background Script (`background.js`)**:
  - `onGetActionsRequested` listener: Returns context-sensitive list of 4 actions:
    - `rclone_copy_link` — only for single files (folders hidden).
    - `rclone_copy_path` — always visible (including multi-selection).
    - `rclone_file_info` — only for single selection.
    - `rclone_cache_refresh` — always visible.
  - `onExecuteActionRequested` listener implements all four actions:
    - **🔗 Copy Link:** `operations/publiclink` (7 days validity) → Notification with URL + "Open in Browser" button; URL saved in `chrome.storage.local` (`lastGeneratedLink`).
    - **📋 Copy Path:** Formats Rclone path (`remote:path`) → Notification + opens options page; path in `chrome.storage.local` (`lastCopiedPath`).
    - **ℹ️ File Details:** `operations/stat` → Notification with Name, Type, Size, Modification Date, MIME type.
    - **🔄 Clear Cache:** `invalidateCache()` for all selected paths (L1 + IDB); forces re-listing.
- **Options Page (`options.html` & `options.js`)**:
  - New sidebar tab **🔗 Quick Access** (`tab-clipboard`).
  - Shows last generated link and last copied path with timestamp.
  - "Copy to Clipboard" button via `navigator.clipboard.writeText()`.
  - "Open in Browser" button opens URL in new tab.
  - Auto-updates on tab switch; manual refresh button.

### Feature: Clean Localization (i18n)

**Problem:** The UI was an inconsistent mix of German and English with no clean separation.

- **New Files:**
  - `src/_locales/de/messages.json` — ~85 message keys in German (default language).
  - `src/_locales/en/messages.json` — all keys in English (automatic fallback).
- **Manifest (`manifest.json`)**:
  - Added `"default_locale": "de"`.
  - Switched `name` and `description` to `__MSG_ext_name__` / `__MSG_ext_desc__`.
- **Background Script (`background.js`)**:
  - Added `msg(key, ...subs)` shorthand helper (`chrome.i18n.getMessage`) at file top.
  - Replaced all notification titles/texts, context menu action titles, and error texts with `msg()` calls.
  - `toLocaleString()` without hardcoded language (removed `'de-DE'`) — now uses system language.
- **Options Page (`options.html`)**:
  - Added `data-i18n="key"` to all translatable text elements (headings, descriptions, labels, buttons, stepper steps, clipboard tab).
  - Added `data-i18n-placeholder="key"` to input fields with localized placeholder texts.
- **Options Script (`options.js`)**:
  - Added `i18n(key, ...subs)` helper function.
  - `applyI18n()` function: Iterates over all `[data-i18n]` and `[data-i18n-placeholder]` elements at page load and sets `textContent` or `placeholder`.
  - Sets `document.title` dynamically via `i18n('page_title')`.
  - Replaced all hardcoded status messages, confirmation dialogs, dashboard labels, dark mode button text with `i18n()` calls.
  - `applyI18n()` is also called again upon tab switch (not necessary, but defensive measure).

---

## 2026-05-14 – Session: Google Photos, SW Stability & UI Improvements (Conversation 2f069806)

### Feature: Google Photos Support
- **WASM Bridge (`src/wasm-bridge/main.go`)**: Added backend `googlephotos` to Go imports.
- **Build System (`build-wasm.sh`)**: Optimized script for Linux (x86_64) (sed compatibility, path detection). Recompiled WASM binary (~78 MB).
- **Configuration (`src/config-schemas.js`)**: Added detailed schema for Google Photos (options for "Include Archived", "Read-Only", "Scopes").

### Stability: Service Worker Keep-Alive (Upload Protection)
- **Problem**: Long uploads were aborted after 5 minutes by the Chrome Service Worker timeout.
- **Solution (`src/background.js`)**: Implementation of a heartbeat mechanism via `chrome.alarms`. 
- An alarm (`uploadKeepAlive`) fires every 20 seconds during an active upload to keep the worker awake.
- `startKeepAlive()` and `stopKeepAlive()` precisely control the process at the start and end of every write operation.

### UI/UX & Management
- **Bug Fix (`src/options.js`)**: Fixed `ReferenceError` ("Cannot access 'i18n' before initialization") upon page load.
- **Feature: Edit Button**: Added an **"Edit"** button in the "Your Remotes" list. It automatically populates the wizard form with the remote's existing data.
- **Feature: Scope Selection**: Google Drive now supports selecting the access scope (Full Access vs. Read-Only) directly in the GUI.
- **Bug Fix (Wizard)**: Fixed a bug in the wizard's save process (`name` variable undefined).
- **Localization**: Added new message keys (`btn_edit`) for German and English.

---

## 2026-05-14 – Roadmap Documentation

### Project Planning
- **`docs/roadmap.md`**: Complete roadmap consolidated from `roadmap.md` and `TODO.md`.
  - High Priority: FSP Error Code Mapping, SW Lifecycle/Auto-Remount, OAuth Token Refresh, Pagination of large directories.
  - Medium Priority: WebDAV Support, Encrypted Configuration, Sync Command, Download Progress, Cross-Remote Copy, Upload Queue, Network Change Detection.
  - Low Priority: WASM Memory Management, Debug Panel, Build Pipeline, Automated Tests, further localizations.

---

## 2026-05-17 – Session: Google Photos Removal, Auto-Obscure, Dashboard Fix

### Removal: Google Photos Backend
- **Background**: Google restricted the Photos Library API to `photoslibrary.readonly.appcreateddata` – rclone can only see content it uploaded itself, not the user's photo library. This is a Google API policy change and cannot be bypassed.
- **`src/wasm-bridge/main.go`**: Removed import `_ "github.com/rclone/rclone/backend/googlephotos"`.
- **`src/config-schemas.js`**: Completely removed `googlephotos` entry.
- **`src/rclone.wasm`**: Recompiled without Google Photos (~73 MB, previously ~75 MB).

### Feature: Automatic Password Encryption (Auto-Obscure)
**Problem:** Passwords for SFTP, FTP, SMB, and Crypt had to be manually encrypted with `rclone obscure` – an unreasonable step for end users.

- **`src/config-schemas.js`**: Marked password fields for FTP (`pass`), SFTP (`pass`), SMB (`pass`), and Crypt (`password`, `password2`) with `needsObscure: true`; simplified labels/placeholders.
- **`src/options.js`**:
  - Defined `_OBSCURE_KEY` (32-byte AES-CTR key, identical to rclone's Go implementation) as constant.
  - `rcloneObscure(plaintext)` – encrypts a plaintext password via WebCrypto AES-CTR + random 16-byte IV, Base64url-encoded (no padding). Generates the same format as `rclone obscure`.
  - `rcloneReveal(obscured)` – decodes a stored obscure password back to plaintext (for populating the edit form).
  - `collectFields(idPrefix, providerDef)` – async helper function: reads all form fields, calls `rcloneObscure()` for `needsObscure` fields.
  - Switched `guidedSaveBtn`, `guidedTestBtn`, `wizardSaveBtn` click handlers to `async`; field collection changed to `await collectFields(...)`.
  - Switched `editRemote()` to `async`; populates `needsObscure` fields via `await rcloneReveal(value)` with the plaintext password.

### Bug Fix: Dashboard Shows No Storage Info for Unlimited Accounts
**Problem:** Google Workspace accounts with unlimited storage return `total: 0` in `operations/about`. The condition `item.quota.total > 0` didn't trigger, showing "N/A" all the time.

- **`src/background.js`**: Added debug log for `operations/about` response per remote (`JSON.stringify`).
- **`src/options.js`** (`renderDashboard`): New branch `else if (item.quota && item.quota.used > 0)` – shows text `X used (unlimited)` instead of "N/A" when `total === 0`. `total: 0` is the canonical rclone signal for unlimited storage (mirrors `storageQuota.limit = 0` of the Google Drive API).


---

## 2026-05-17 – Rebranding: ChromeOS Rclone → OmniFiles

### Renaming of All User-Facing Texts
- **`src/_locales/de/messages.json`** & **`src/_locales/en/messages.json`**: Changed `ext_name`, `ext_desc`, `wizard_desc`, `advanced_desc`, `page_title`, `notif_path_title` to "OmniFiles".
- **`src/options.html`**: Changed `<title>` and sidebar title `<div class="sidebar-title">` to "OmniFiles".
- **`src/background.js`**: Updated mount display name (`OmniFiles (remoteName)`) and error message for missing configuration.
- **`src/options.js`**: Changed export filename from `rclone.conf` to `omnifiles.conf`.
- Internal identifiers (variable names, console logs, WASM bridge, action IDs) intentionally left unchanged.

---

## 2026-05-17 – Feature: System-Controlled Dark Mode (3-State Toggle)

**Problem:** Once a user interacted with the Dark Mode button, the system setting was permanently overridden and never followed again.

### Changes
- **`src/options.js`** (`initDarkMode`, `applyDarkMode`):
  - New 3-state cycle: **Auto → Dark → Light → Auto**.
  - In **Auto** mode, the page live-follows `prefers-color-scheme` of the system — even on changes while the page is open.
  - `darkModeBtn.dataset.mode` saves the current state (`'auto'`/`'dark'`/`'light'`); the `matchMedia` listener only acts when the mode is `'auto'`.
  - Migration of old boolean values from `chrome.storage.local` (`true` → `'dark'`, `false` → `'light'`, `undefined` → `'auto'`).
- **`src/_locales/de/messages.json`** & **`src/_locales/en/messages.json`**:
  - New key `btn_auto_mode` ("🌗 Auto").
  - `btn_dark_mode` and `btn_light_mode` now show the **current** state with an icon (🌙 / ☀️), not the target action.

---

## 2026-06-01 – Session: Performance, SFTP Diagnosis & Upload Diagnosis

### Fix: SW Cold Start Delay (10–20s First Operation)
**Problem:** After waking up the Service Worker, the first file operation (e.g., opening a folder) took 10–20 seconds, as the Google Drive backend was only initialized on the first real FSP request (OAuth state, Root Folder ID caching).

- **`src/background.js`** (`self.rcValid.then()`):
  - After successful WASM initialization, `configureRclone()` is proactively called if mounts are already saved in `chrome.storage.local`.
  - For each configured remote, a fire-and-forget `operations/stat` call is immediately dispatched (on the root directory `""`).
  - This warms up the Drive backend (OAuth token check, Root Folder ID lookup) before the user opens a file – the first real FSP request thus hits an already initialized backend.

### Diagnosis: SFTP / TCP Limitations in WASM Sandbox
- **Finding:** Go WASM (`GOOS=js GOARCH=wasm`) doesn't support raw TCP connections. `wasm_exec.js` contains no TCP polyfills, and `chrome.sockets` is not declared in the extension manifest.
- DNS resolution of `penguin.linux.test` fails in the WASM context.
- SFTP connections to external hosts (even on local net) are therefore fundamentally impossible – only loopback (`127.0.0.1`) might be reachable via WASM-internal mechanisms.
- **Consequence:** SFTP remains unsupported in the current WASM architecture. Noted in the roadmap.

### Fix: Metadata Injection after mkdir / move / copy (Stat Flood after notify)
**Problem:** After `operations/mkdir` and `sync/move`, the extension sends `notifyChange()` to ChromeOS. This triggered `INVALID_OPERATION` callbacks, prompting ChromeOS to issue 3× `onGetMetadataRequested` for the affected paths – each a separate network call (~11s for Google Drive). Creating two folders cost ~50s.

- **`src/background.js`** – `onCreateDirectoryRequested`:
  - Instead of `invalidateCache()` for the new directory path: immediate `cacheSet()` with a synthetic `item` (`{ IsDir: true, Name, Size: -1, ModTime: now }`).
  - Only the parent directory listing is removed from the cache (so `readdir` fetches fresh data on the next call).
  - ChromeOS re-stats on the new folder are now served from the cache (<1 ms instead of ~11s).
- **`src/background.js`** – `onMoveEntryRequested`:
  - Pre-stat result (`statRes.item`) is written into the cache entry of the target path after the move (with updated `Name`).
  - Source is completely invalidated; only target parent listing is deleted.
- **`src/background.js`** – `onCopyEntryRequested`:
  - Same pattern as Move: Target entry injected from pre-stat data into cache, target parent listing deleted.
  - Fallback to full `invalidateCache()` if no pre-stat is available.

### Diagnosis: Failed Upload of Large File (Google Drive Rate Limit)
- **Finding:** Upload of `obsidian_1.9.14_amd64.deb` (~86.5 MB) to `gdrive:encryptedDir/` failed at `onCloseFileRequested`:
  ```
  googleapi: Error 403: Quota exceeded for quota metric 'Queries' and limit
  'Queries per minute' … reason: RATE_LIMIT_EXCEEDED
  ```
- All write chunks (0–86,502,322 bytes) were successfully received; the error only occurred at final stream finalization.
- **Cause:** The project uses Rclone's default OAuth credentials (`project_number:202264815644`), which share a common quota of 840,000 queries/minute across all Rclone users.
- **Workaround:** Enter own Google Drive API credentials (`client_id` + `client_secret`) in the remote settings. Noted in UI help and roadmap.

### Fix: Directory Listing Cache (FSP Timeout Dialog)
**Problem:** `onReadDirectoryRequested` had no own cache – every folder open triggered a network request. On slow connections or after SW restart, this exceeded the FSP timeout (~10–15s), causing ChromeOS to show the "Operation is taking longer than expected" dialog.

- **`src/background.js`** – `onReadDirectoryRequested`:
  - Cache key format: `'__listing__:' + remote + directoryPath` — distinctly separated from Stat entries.
  - On cache hit, the saved item list is immediately returned (entries are reconstructed on-the-fly with the current `options` flags).
  - On cache miss: Network request as before, then `listRes.list` (raw rclone items) is saved under the listing key. TTL: 5 minutes (identical to Stat cache).
- **`src/background.js`** – `invalidateCache()`:
  - Now additionally deletes `'__listing__:' + key` for the entry itself and the parent directory — so write operations (delete, move, copy) are immediately visible in the listing.
- **`src/background.js`** – `onCreateDirectoryRequested`, `onMoveEntryRequested`, `onCopyEntryRequested`:
  - The manual cache deletions (bypassing `invalidateCache` to enable stat injection) now also delete the `__listing__` key of the affected parent directory.

### Fix: New Remote Appears Immediately in Files Explorer (Auto-Mount)
**Problem:** After adding a remote via wizard or advanced editor, the extension had to be manually reloaded before the new remote appeared in the ChromeOS Files explorer.

- **`src/background.js`** – new `chrome.storage.onChanged` listener:
  - Reacts to changes to `rcloneConf` in `chrome.storage.local` (triggered on every save operation).
  - Calls `configureRclone()` and tries to mount all configured remotes.
  - Already mounted remotes generate an internal "Already mounted" error — this error is silently ignored.
  - Works for all save paths: Guided Setup, Advanced (Raw Config), Import.

### Fix: Default Language Switched to English
- **`src/manifest.json`**: Changed `"default_locale"` from `"de"` to `"en"`.
- Users with German ChromeOS will continue receiving the German translation from `_locales/de/`.
- All other languages (and new users without matching locale) now receive English texts instead of German.

### Cleanup: Removal of Non-Working LAN Protocols (TCP Sandbox)
**Problem:** In the browser environment (Chrome Extension Service Worker Manifest V3), native raw TCP sockets are fundamentally prohibited. SMB, SFTP, FTP, and WebDAV (which wasn't compiled in) therefore didn't work in the WASM sandbox but blocked the Rclone pacer for ~30 seconds and froze the ChromeOS Files app.

- **`src/wasm-bridge/main.go`**: Removed imports for `backend/smb`, `backend/ftp`, and `backend/sftp`.
- **`src/wasm-bridge/main.go`**: Added import for `backend/googlephotos` as this cloud service (HTTPS) is supported.
- **`src/config-schemas.js`**: Completely removed forms for SMB, SFTP, FTP, and WebDAV so users aren't confused by non-functional options. Added Google Photos schema.
- **WASM Rebuild**: The reduction in backends lowered the size of the compiled `rclone.wasm` significantly (from ~76 MB to ~68 MB), noticeably improving the extension's load time!

---

## 2026-06-18 – Session: License Compliance, Thumbnail Fix, OAuth Sync & Performance Optimization (Conversation 8782a73a)

### Feature: License/Legal Notice Popup (rclone MIT License Compliance)
**Background:** Since rclone (MIT license) is distributed as `rclone.wasm`, the license text must be accessible to the end user according to roadmap item "⚖️ License Compliance".
- **`src/LICENSE-rclone.txt`** (new): Original rclone `COPYING` text (verified from official rclone repo), sits in `src/` root and thus automatically becomes part of the final extension ZIP.
- **`src/options.html`**: Small link "⚖️ Legal Notices" under the dark mode button in the sidebar; opens a modal with license text intro + full MIT license text. Modal closable via X button, footer button, overlay click, or escape key.
- **`src/options.js`**: New function `setupLicenseModal()`, called in init sequence.
- **`src/_locales/{de,en}/messages.json`**: New keys `footer_legal_link`, `license_modal_title`, `license_modal_intro`, `btn_close`.

### Fix: Image Preview (Thumbnail) in Files App Grid Remained Empty
**Problem:** Images showed only the generic file type icon instead of a preview in the file explorer. According to official `chrome.fileSystemProvider` docs (verified via WebFetch), `EntryMetadata.thumbnail` as Data URI can be **max 32 KB** in size — larger values are silently discarded by the Files app (fallback to generic icon). `generateThumbnail()` generated a flat 320×320 JPEG at 0.8 quality without size check; for colorful/detailed images, the result easily exceeded the 32 KB limit.
- **`src/background.js`** – `generateThumbnail()`: Now generates the thumbnail iteratively over a list of decreasing `{maxDim, quality}` combinations (320/0.8 → 320/0.6 → 200/0.6 → 200/0.4 → 120/0.4) and returns the first variant whose Data URI is ≤ 32 KB. If the image is still too large at the smallest step, `null` is returned (existing behavior: no thumbnail, generic icon as fallback).
- **Additional Note (Not Fixable in Code):** `options.thumbnail` is exclusively controlled by the Files app itself (grid view vs. list view) — in the user-provided log, `thumbnail: false` was set on every `onGetMetadataRequested` call, indicating active list view. Could not be reproduced in a real ChromeOS environment (no Chrome browser available in dev VM).

### Feature: Automatic Saving of OAuth Tokens (Config Sync Callback)
**Problem:** Due to the volatile lifecycle of Manifest V3 Service Workers, configurations updated in RAM (like a renewed OAuth token) are lost upon SW inactivity. At the next wake-up, the old, expired configuration was loaded from `chrome.storage.local`, creating latency on the first operation due to a forced re-refresh.
- **`src/wasm-bridge/main.go`**: In the `main()` function, `fs.ConfigFileSet` is now intercepted. On write access, the original setter is called, followed by calling the JavaScript function `onConfigChanged(section, key, value)` asynchronously in a goroutine.
- **`src/background.js`**: 
  - Implemented `serializeIniConfig(obj)` to convert config objects back to INI format.
  - Registered global callback function `self.onConfigChanged`.
  - Introduced a `configUpdateQueue` (Promise chain) to serialize successive write operations on `chrome.storage.local` and prevent race conditions.

### Fix: FSP Timeout Dialog ("Operation is taking longer than expected") after Introducing Config Sync Callback
**Problem:** After introducing `onConfigChanged` (Commit 227038e, persisting internal WASM config changes like OAuth token refresh to `chrome.storage`), connections became consistently slow; ChromeOS showed the FSP timeout dialog. Cause: `checkAllRemotes()` (every 5 mins via alarm) and every `configureRclone()` call re-inject **all** config keys of all remotes, even if nothing changed. The patched `fs.ConfigFileSet` in `main.go` triggers `onConfigChanged` for **every single key** — for 3 remotes with 11 keys in total, that's 11 serialized `chrome.storage.local.get`+`set` roundtrips per tick, blocking the single-thread WASM Service Worker and delaying real FSP requests (stat/list/read) beyond the ~10s ChromeOS timeout.
- **`src/background.js`** – new in-memory mirroring `liveConfigCache`: holds the latest injected values per remote/key.
- **`src/background.js`** – `onConfigChanged`: first compares incoming value against `liveConfigCache`; if identical (routine re-injection without real change), the `chrome.storage` roundtrip is completely skipped. Only true changes (e.g., actual token refresh) trigger a write and update the cache.
- **`src/background.js`** – `configureRclone()` and `checkAllRemotes()`: set `liveConfigCache` to the currently (re-)injected `parsedConf` object before running the injection loop.
- **Verified** via headless Node test (stubbed `chrome.storage`/`configInject`): Routine re-injection of identical values generates 0 storage writes; a simulated token refresh with a changed value generates exactly 1 write and is correctly persisted; after that, re-assertion of the new value is a no-op again.

---

## 2026-07-19 – Session: Codebase Audit — Robustness, Security & Documentation Fixes

Result of a full-codebase review; all identified findings were addressed in one pass.

### Feature: Precise FSP Error Codes (Roadmap item "Error Code Mapping" ✅)
**Problem:** Nearly all FSP handlers returned the generic `'FAILED'` on any backend error, so the Files app could only show a meaningless generic error.
- **`src/config-utils.js`** (new) – `mapErrorToFsp(err, fallback)`: maps RC bridge status codes (400/401/403/404/409/507) and error-message patterns to precise `ProviderError` codes (`NOT_FOUND`, `ACCESS_DENIED`, `NO_SPACE`, `EXISTS`, `NOT_EMPTY`, `NOT_A_DIRECTORY`, `NOT_A_FILE`, `INVALID_OPERATION`, `IO`). Quota errors are deliberately checked *before* the 403 check, because Google Drive reports "quota exceeded" as HTTP 403 — for the user that is a storage problem, not a permission problem.
- **`src/background.js`** – all FSP handlers (`getMetadata`, `readDirectory`, `mkdir`, `delete`, `move`, `copy`, `open`, `read`, `write`, `close`) now report `mapErrorToFsp(err)` instead of `'FAILED'`.

### Fix: Silent Data Corruption Risk in Streaming Upload Close
**Problem:** If out-of-order chunks remained in `pendingChunks` at `onCloseFileRequested`, they were flushed sorted by offset *without* checking for gaps — a missing chunk would have produced a silently corrupted file in the cloud.
- **`src/background.js`** – the flush loop now verifies that the remaining chunks form a contiguous range starting at `nextExpectedOffset`; on a gap the upload is aborted with an explicit error (stream abort + FSP error) instead of writing corrupt data.

### Fix: Race Condition on `mountedFileSystems` Storage Writes
**Problem:** Three separate code paths (mount callback, unmount, auto-mount listener) performed unserialized get→modify→set roundtrips on `chrome.storage.local.mountedFileSystems`; concurrent callbacks (multi-remote configs) could overwrite each other's writes and drop mount entries.
- **`src/background.js`** – new `updateMountedFileSystems(mutate)` helper serializes all updates through a promise queue (same pattern as the existing `configUpdateQueue`); all three call sites converted.

### Fix: Error Notification Never Shown for Small Buffered Uploads
**Problem:** The upload-failure path called `chrome.notifications.update()` on a notification ID that was never created when the buffered path skipped the progress notification (< 100 KB files) — the user saw no error at all.
- **`src/background.js`** – the catch path now uses `chrome.notifications.create()` (which also replaces an existing notification with the same ID), including icon and an 8-second auto-clear.

### Perf: Reduced Health-Check Wakeups & Batched Directory Listings
- **`src/background.js`** – `checkRemotes` alarm period raised from 5 to 15 minutes: each firing wakes the Service Worker and re-injects the whole config; 12 wakeups/hour was needlessly battery-hungry for a pure dashboard health indicator. (README updated accordingly.)
- **`src/background.js`** – `onReadDirectoryRequested` now delivers entries to the FSP in batches of 1000 via `successCallback(batch, hasMore)` instead of one potentially huge IPC message (partial implementation of the "Large Directories" roadmap item; backend-side paging remains open).

### Security: Removed Unnecessary `web_accessible_resources`
**Problem:** `manifest.json` exposed `rclone.wasm` to **all** `https://*/*` origins. The Service Worker's own `fetch('rclone.wasm')` does not require web-accessibility (that mechanism is only for foreign web pages), so this only enlarged the attack/fingerprinting surface.
- **`src/manifest.json`** – `web_accessible_resources` block removed entirely.

### Refactor & Tests: Shared Pure Helpers + First Unit Tests (Roadmap item "Automated Tests" started)
- **`src/config-utils.js`** (new) – `parseIniConfig`, `serializeIniConfig`, `sanitizeTokenValue`, `getParentPath` extracted unchanged from `background.js`, plus the new `mapErrorToFsp`. Loaded in the SW via `importScripts()`, and requirable from Node.
- **`tests/config-utils.test.js`** (new) – 15 Node test-runner tests (INI parse/serialize round-trip, token sanitization, parent paths, error mapping incl. the quota-vs-403 edge case). Run with `node --test tests/*.test.js` — all passing.

### Cleanup: Dead Code in WASM Bridge
- **`src/wasm-bridge/main.go`** – removed the unused functions `paramToValue()` and `jsTime()`. No functional change; verified that the bridge still compiles to WASM (`GOOS=js GOARCH=wasm`). A rebuild of `rclone.wasm` is **not** required — the removed code was never referenced.

### Docs: README / Roadmap Brought in Line with the Code
- **`README.md`** – backend table corrected: SFTP/FTP/SMB were falsely listed as "✅ Full support" although the backends are not compiled in and raw-TCP protocols cannot work in Service Worker WASM (they are now listed as "❌ Not possible" with explanation); Google Photos added; architecture diagram backend list fixed; "Auto-Obscure" wording clarified (obfuscation with a fixed public key, *not* secure encryption); health-check interval updated; `roadmap.md` links fixed to `ROADMAP.md`; project structure extended with `config-utils.js` and `tests/`.
- **`docs/ROADMAP.md`** – "Error Code Mapping" marked implemented; "Large Directories" marked partially done; "Automated Tests" marked started; "Encrypted Configuration" extended with the design constraint that a master password cannot be prompted from an unattended Service Worker wakeup (session-unlock UX required).

---

## 2026-07-19 – Session: OAuth Token Refresh — Dead-Token Detection & Re-Auth UX (Roadmap item ✅)

**Background analysis:** Automatic *access token* refresh already worked end-to-end: rclone's `oauthutil.TokenSource` refreshes it via the `refresh_token` (a plain HTTPS POST, compatible with the fetch() transport), and the refreshed token is persisted to `chrome.storage` through the existing `onConfigChanged` config-sync callback. The 15-minute health-check alarm triggers this implicitly even on idle systems. The real gap was the **permanent** failure mode: an expired or revoked *refresh token* (e.g. Google `invalid_grant` after revoking access, or 7-day expiry of testing-mode OAuth clients) made every operation fail silently with a generic error.

### Feature: Auth-Failure Detection (`isAuthError`)
- **`src/config-utils.js`** – new `isAuthError(err)`: detects permanent auth failures across both error shapes (RC bridge `{status, error}` objects and plain-string errors from the file bridges) via status 401 and message patterns (`invalid_grant`, `invalid_client`, `couldn't fetch token`, `failed to refresh token`, `token has been expired or revoked`, `oauth2: cannot fetch token`, `unauthorized`). Deliberately does **not** fire on 403/quota errors (those map to `NO_SPACE`/`ACCESS_DENIED`).
- **`tests/config-utils.test.js`** – 3 new tests (18 total, all passing): real-world Google `invalid_grant` payloads, string-bridge errors, and negative cases.

### Feature: Central Re-Auth Notification
- **`src/background.js`** – `self.rc()` is wrapped once after WASM init: every RC call that rejects with an auth error extracts the remote name from `params.fs`/`params.srcFs` and calls `notifyAuthExpired()`; the error is re-thrown unchanged so existing error handling (FSP codes etc.) is unaffected. The fileRead/fileWrite/fileWriteStream paths (which bypass `rc()`) got explicit `isAuthError` checks in the `onOpenFileRequested`, `onReadFileRequested`, and `onCloseFileRequested` error paths.
- **`notifyAuthExpired(remote, err)`**: throttled to max. 1 notification per remote per 30 minutes; stable notification id (`rclone-auth-<remote>`) so repeated failures replace the notification instead of stacking; `requireInteraction: true` with an **"Open settings"** button (single top-level `onButtonClicked` listener, MV3-safe) → `chrome.runtime.openOptionsPage()`. Also persists `status: 'auth_expired'` into `remoteStatus` so the state survives SW restarts.
- **`checkAllRemotes()`**: failed checks now distinguish `auth_expired` from `offline`; a *successful* check calls `clearAuthExpired()` (resets the throttle and removes a stale notification) — so after the user pastes a fresh token, the warning disappears automatically within one health-check cycle.

### UI: "Token expired" Status in the Options Page
- **`src/options.js`** – dashboard cards render `auth_expired` as an amber `status-warning` badge with the localized label; the remote-list status dot gets `status-auth_expired` styling and a readable tooltip.
- **`src/options.html`** – new CSS: `.status-auth_expired` (amber dot `#f29900`) and `.status-warning` (amber badge).
- **`src/_locales/{de,en}/messages.json`** – 4 new keys (`notif_auth_title`, `notif_auth_msg`, `notif_btn_settings`, `status_auth_expired`), appended preserving the existing compact file formatting.

### Docs
- **`docs/ROADMAP.md`** – "OAuth Token Refresh" marked implemented, including the analysis of what already worked; in-app re-auth via `chrome.identity.launchWebAuthFlow` remains as the long-term follow-up (OAuth gateway).
- **`README.md`** – roadmap bullet updated accordingly.

**Note:** JS-only change — no WASM rebuild required. Verified via `node --check` on all touched JS files and `node --test tests/config-utils.test.js` (18/18 passing); the notification/UX flow needs a real-Chromebook test with an actually revoked token (revoke access at https://myaccount.google.com/permissions to reproduce `invalid_grant`).

---

## 2026-07-19 – Session: Download Progress Notifications (Roadmap item ✅)

### Feature: Progress Notification for Large Reads
**Problem:** Opening or copying a large file *out of* a mounted remote gave no feedback — the Files app only shows an indeterminate spinner while `onReadFileRequested` streams chunks in the background. Upload progress existed; download progress was completely missing.
- **`src/background.js`** – new `updateDownloadProgress(file, openRequestId, offset, deliveredBytes)`:
  - Tracks the highest delivered byte offset (`bytesReadEnd`) per open READ-mode file in the existing `openFiles` map (new fields `bytesReadEnd`, `notifId`, `lastNotifiedPct`).
  - Only fires for files **≥ 4 MB** (`DOWNLOAD_NOTIFY_MIN_BYTES`) so small preview reads don't produce notification noise.
  - Creates one `chrome.notifications` progress notification per open file (id derived from the unique `openRequestId` — concurrent downloads get separate notifications) and updates it in **10%-steps** (`DOWNLOAD_NOTIFY_STEP_PCT`), always including the 100% step.
  - A read past EOF (the Files app's end-of-copy signal) finalizes the notification to 100%; it auto-clears after 2.5 s.
  - `clearDownloadProgress()` in `onCloseFileRequested` removes a still-visible notification as a fallback (e.g. aborted reads).
  - Hooked into both the remote `fileRead` path and the EOF short-circuit; the in-memory buffer path (WRITE-mode read-back) is intentionally excluded.
- **`src/_locales/{de,en}/messages.json`** – new keys `notif_download_title` ("Downloading: $FILE$") and `notif_download_prog` ("$PCT$% downloaded").

### Fix: Resolved Merge Conflict in `de/messages.json`
The working tree contained an unresolved Git conflict (`<<<<<<< HEAD` markers) between the "localize extension UI to English" commit (a2b537c) and the uncommitted German OAuth-notification keys — the file was invalid JSON and would have broken `chrome.i18n` entirely. Resolved in favor of the committed English-content direction: English legal block kept, the 4 OAuth keys (`notif_auth_*`, `status_auth_expired`) re-added **in English** to match, file re-validated as JSON and staged as resolved.

### Docs
- **`docs/ROADMAP.md`** – "Download Progress Indicator" marked implemented with the design parameters.
- **`README.md`** – feature bullet extended to "upload & download progress"; roadmap bullet removed.

**Note:** JS-only change, no WASM rebuild. `node --check` clean, 18/18 unit tests passing. Real-device check: copy a file ≥ 4 MB from a mounted remote to Downloads — a progress notification should appear and complete at 100%.

---

## 2026-07-20 – Session: License Headers & Asset Cleanup
- **Source Integrity:** Added MIT license headers to all JavaScript and Go source files (`94bec27`).
- **Asset Housekeeping:** Cleaned up unused icon proposal assets (`110daf0`).

---

## 2026-07-23 – Session: Architectural Audit & Code Review Findings
- **Roadmap Planning:** Documented code-review findings in `ROADMAP.md` covering stale config re-injection gaps, permission scope hardening (`host_permissions`), and documentation inconsistencies (`c2030f7`).
- **License Attribution:** Bundled third-party license attribution guidelines for upcoming release (`2a5c893`).

---

## 2026-07-27 – Session: Ignore Rules & Localization Drift Tracking
- **Repository Health:** Added `tmp_rclone_build/` build directory to `.gitignore` (`671693d`).
- **Issue Tracking:** Documented the German localization regression (locale file overwrite) and stale testing documentation issues in `ROADMAP.md` (`682130a`).

---

## 2026-07-28 – Session: WASM Build Pipeline, Concurrency & Memory Leak Fixes

### Build & Toolchain Hardening
- **rclone WASM Build (`build-wasm.sh`):** Pinned rclone build to `-trimpath` to eliminate local build path leaks in tracebacks (`e5df68f`).
- **Go Toolchain Pinning (`build-wasm.sh`):** Pinned `GO_VERSION="1.25.0"` to eliminate version skew with `wasm_exec.js`, exported `GOTOOLCHAIN=local`, added stale toolchain detection guard, dynamically resolved `wasm_exec.js` from `GOROOT`, and added post-build embedded version assertion (`d3e7f96`).
- **License Manifest Generator:** Created `tools/gen-license-manifest.sh` using `go list -deps` for `GOOS=js GOARCH=wasm` to produce authoritative `THIRD_PARTY_LICENSES.md` and `src/third-party-licenses.txt` (`c0ca543`, `e2910bb`).
- **Manifest & Git Hygiene:** Pruned unused permissions (`contextMenus`, `idle`, `tabs`) from `manifest.json` (`8bd4264`); added `build_tmp.bak` to `.gitignore` (`523264a`).

### SW Concurrency, Config Invalidation & Memory Leaks
- **Stale Config & In-Flight Injection Memoization (`src/background.js`):** Replaced `rcloneConfigured` boolean with `_configPromise` memoization to collapse concurrent wake-up FSP events into a single storage read/injection. Added `configureRclone(true)` forced re-injection on `chrome.storage.onChanged` (`c0c8563`).
- **Keep-Alive Alarm Refcounting (`src/background.js`):** Converted `_keepAliveActive` boolean to `_keepAliveHolders` counter to prevent concurrent uploads from clearing the alarm. Hoisted `startKeepAlive()` before `try` block for strict pairing with `finally`, and added top-level startup clear for stale alarms (`46acd83`).
- **Streaming Upload Goroutine Leak (`src/background.js`):** Aborted `file.streamWriter` (`abort()`, not `close()`) on unwritten handle close to release parked Go `Rcat` goroutines and WASM memory without overwriting cloud files (`14c8395`).
- **German Locale Restoration (`src/_locales/de/messages.json`):** Restored German strings previously overwritten with English text; translated missing keys (`notif_auth_*`, `notif_download_*`, `status_auth_expired`) using informal *du* register (`23f6cd3`).
- **WASM Bridge Refactoring (`src/wasm-bridge/main.go`):** Renamed `ReadCloser` variable in `fileReadCallback` from `rc` to `readCloser` to avoid shadowing the imported `fs/rc` package (`915e393`).

---

## 2026-07-29 – Session: Documentation & Onboarding Refresh
- **Documentation Overhaul:** Rewrote `README.md` to improve project description, simplify setup instructions, update technical expectations, and lower the entry barrier (`37c3d6c`, `4c4fa37`).


