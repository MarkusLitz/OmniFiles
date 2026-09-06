<p align="center">
  <img src="src/assets/icon_128.png" alt="OmniFiles Logo" width="128" height="128" />
</p>

<h1 align="center">OmniFiles</h1>

<p align="center">
  <strong>All your cloud storage, as ordinary drives in the ChromeOS Files app.</strong>
</p>

<p align="center">
  <a href="https://chromewebstore.google.com/detail/omnifiles/bdcjbkaghidiffifjhiklniadlfgdipo"><img src="https://img.shields.io/badge/Chrome%20Web%20Store-Install-4285F4?logo=googlechrome&logoColor=white" alt="Install from the Chrome Web Store" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green.svg" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/ChromeOS-105%2B-lightgrey?logo=googlechrome&logoColor=white" alt="Requires ChromeOS 105 or later" />
</p>

<p align="center">
  <a href="#installation"><strong>Install from the Chrome Web Store →</strong></a>
</p>

<p align="center">
  <a href="#features">Features</a> •
  <a href="#supported-backends">Backends</a> •
  <a href="#installation">Installation</a> •
  <a href="#configuration">Configuration</a> •
  <a href="#architecture">Architecture</a> •
  <a href="#building-from-source">Build</a> •
  <a href="#roadmap">Roadmap</a>
</p>

---

## What is OmniFiles?

Your files end up scattered. Some live in Google Drive, some in Dropbox or OneDrive, some in a work storage bucket. On a Chromebook, reaching them usually means a browser tab per service — download a file to edit it, then remember to upload it back afterwards.

OmniFiles puts them all in the **Files app** instead, the same window as your Downloads folder. Every account you connect shows up in the sidebar as its own drive. Open a document and it opens. Rename, copy, move and delete behave the way they do for files already on your device. Right-click something to grab a shareable link. Photos show real thumbnails instead of generic icons.

Nothing has to be copied onto your Chromebook for this to work, and no browser tab is involved.

**Before you start, three things worth knowing:**

- **Chromebooks only.** OmniFiles plugs into the ChromeOS Files app, so it does nothing on Windows, macOS, or desktop Linux.
- **Connecting an account takes one technical step, for now.** Google Drive, OneDrive, Dropbox and Google Photos each need a one-time authorisation performed on a desktop computer, then pasted in (see [Configuration](#configuration)). Services that use plain access keys, such as S3, skip this entirely. Turning the first kind into an ordinary one-click sign-in is a planned improvement — see the [roadmap](#roadmap).
- **It's early software.** Version 0.3.0, published on the [Chrome Web Store](https://chromewebstore.google.com/detail/omnifiles/bdcjbkaghidiffifjhiklniadlfgdipo). Copying files *between* two connected clouds isn't supported yet — copy and move work within one drive at a time.

---

## How it works

**OmniFiles** is a Chrome Extension (Manifest V3) that brings [rclone](https://rclone.org/) directly into ChromeOS as a native filesystem provider. It compiles rclone to WebAssembly and runs it inside the extension's Service Worker, enabling you to browse, read, write, copy, move, and delete files on remote cloud storage — all through the standard ChromeOS Files app, with no Linux container or Crostini required.

> **Why WebAssembly?** Traditional approaches require running rclone as a native binary inside a Linux container. OmniFiles eliminates that dependency entirely by compiling rclone's Go codebase to `GOOS=js GOARCH=wasm`, running it headlessly in a Service Worker, and routing all HTTP traffic through the browser's native `fetch()` API.

---

## Features

### 🗂️ Full Filesystem Integration
- Mounts cloud storage as **native drives** in the ChromeOS Files app via the [`chrome.fileSystemProvider`](https://developer.chrome.com/docs/extensions/reference/fileSystemProvider/) API
- **Multiple simultaneous mounts** — every remote in your config gets its own drive
- Full **CRUD operations**: browse, open, create, rename, move, copy, and delete files and directories

### 📤 Smart Upload Engine
- **Hybrid upload strategy**: small files (< 4 MB) use an in-memory buffer for reliable random-access edits; larger files stream directly to the cloud via `TransformStream` → WASM bridge
- **Real-time upload & download progress** notifications with percentage via `chrome.notifications` (downloads: files ≥ 4 MB, updated in 10% steps)
- **Service Worker keep-alive** mechanism using `chrome.alarms` prevents Chrome from terminating long-running uploads

### 🖼️ Thumbnails & Image Previews
- Generates thumbnails for image files (JPEG, PNG, WebP, BMP) on-the-fly using `OffscreenCanvas` + `createImageBitmap`
- Thumbnails are cached persistently in IndexedDB — no re-download on Service Worker restart

### ⚡ Two-Level Metadata Cache
- **L1 (RAM)**: in-memory `Map` with 5-minute TTL for sub-millisecond lookups
- **L2 (IndexedDB)**: persistent cache with 24-hour TTL, survives Service Worker restarts
- Directory listings pre-populate the cache, so subsequent metadata requests resolve instantly

### 🔧 Configuration UI
- **Guided Setup Wizard**: the single route for adding a remote — step-by-step, with schema-driven form fields and no manual INI editing
- **Provider picker grouped by setup effort**: providers are sorted by what they actually cost you, so the ones needing a one-time step on a desktop computer are marked as such *before* you pick one
- **Edit form**: change an existing remote from Manage Remotes, with stored passwords revealed for editing
- **Advanced Raw Editor**: paste/edit `rclone.conf` directly with INI syntax highlighting
- **Import/Export**: download your config as a file or import an existing one
- **Connection Test**: verify your remote works before saving
- **Auto-Obscure**: passwords are automatically converted to rclone's AES-CTR obscure format — no need to run `rclone obscure` manually. Note: like rclone itself, this is *obfuscation with a fixed, public key*, not secure encryption; the config (including OAuth tokens) is stored unencrypted in `chrome.storage.local` (see Roadmap: Encrypted Configuration)

### 📊 Dashboard
- View active mounts, storage usage (`operations/about`), and active uploads at a glance
- Background health checks every 15 minutes with status indicators (Online / Offline / Unknown)

### 🔗 Context Menu Actions
Right-click files in the ChromeOS Files app to:
- **Copy Link** — generate a public sharing link (7-day expiry)
- **Copy Path** — copy the rclone-formatted path (e.g. `gdrive:documents/file.pdf`)
- **File Details** — view metadata (name, type, size, modification date, MIME type)
- **Clear Cache** — force-refresh directory listings

### 🌍 Internationalization
- Fully localized in **English** (default) and **German**
- All strings externalized via `chrome.i18n` — ready for community translations

### 🌗 Dark Mode
- Three-state toggle: **Auto** (follows system) → **Dark** → **Light**
- Preference persisted across sessions

---

## Supported Backends

| Backend | Provider | Status |
|---------|----------|--------|
| Google Drive | `drive` | ✅ Full support |
| Microsoft OneDrive | `onedrive` | ✅ Full support |
| Amazon S3 | `s3` | ✅ Full support |
| Dropbox | `dropbox` | ✅ Full support |
| Google Cloud Storage | `gcs` | ✅ Full support |
| Google Photos | `googlephotos` | ✅ Compiled in |
| Crypt (Encryption Overlay) | `crypt` | ✅ Full support |
| WebDAV | `webdav` | 🚧 Planned — not yet compiled into WASM |
| SFTP / FTP / SMB | `sftp`, `ftp`, `smb` | ❌ Not possible — these protocols need raw TCP sockets, which are unavailable in Service Worker WASM (only `fetch()`-based HTTP works) |

S3-compatible providers (Wasabi, DigitalOcean Spaces, MinIO, Ceph, etc.) are supported through the S3 backend. See [docs/ROADMAP.md](docs/ROADMAP.md) for the full compatibility analysis of all rclone backends.

---

## Installation

### From the Chrome Web Store (recommended)

**[→ Install OmniFiles](https://chromewebstore.google.com/detail/omnifiles/bdcjbkaghidiffifjhiklniadlfgdipo)**

1. Open the listing on your Chromebook and click **Add to Chrome**.
2. Open the **ChromeOS Files app** → three-dot menu → **Add new service** → **OmniFiles**.
3. Configure a remote — see [Configuration](#configuration).

No developer mode and no manual build required. Updates arrive automatically.

### From Source (Developer Mode)

For contributors, or to run a build with local changes:

1. Clone this repository:
   ```bash
   git clone https://github.com/MarkusLitz/OmniFiles.git
   ```

2. On your Chromebook, open `chrome://extensions/`

3. Enable **Developer mode** (toggle in the top right corner)

4. Click **Load unpacked** and select the `src/` directory

5. The extension should now be active. Open the **ChromeOS Files app** → three-dot menu → **Add new service** → select **OmniFiles**

> **Important:** Select the `src/` folder specifically, not the project root.

> A source install is a *separate* extension from the Web Store build, with its
> own extension ID and its own `chrome.storage`. Running both at once mounts each
> remote twice; disable one before testing the other.

---

## Configuration

### Option 1: Guided Setup (Recommended)

1. Right-click the OmniFiles extension icon → **Options**
2. Navigate to the **Guided Setup** tab
3. Follow the step-by-step wizard:
   - **Step 1**: Choose a name and provider type
   - **Step 2**: Enter credentials (API keys, OAuth tokens, etc.)
   - **Step 3**: Configure optional settings
   - **Step 4**: Test your connection
4. Click **Save** — the remote will be mounted automatically

### Option 2: Raw Config (Advanced)

1. Open the **Advanced (Raw Config)** tab
2. Paste your existing `rclone.conf` content into the editor
3. Click **Save Raw Config**

#### Generating OAuth Tokens

Since the extension runs inside a Service Worker (no browser redirect possible), OAuth tokens must be generated on a desktop machine:

```bash
# On a desktop with rclone installed:
rclone authorize drive      # for Google Drive
rclone authorize onedrive   # for OneDrive
rclone authorize dropbox    # for Dropbox
```

Copy the resulting token JSON and paste it into the appropriate field in the wizard or raw config.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    ChromeOS Files App                     │
│              (chrome.fileSystemProvider API)              │
└──────────────────────┬──────────────────────────────────┘
                       │ FSP Events (mount, read, write, ...)
                       ▼
┌─────────────────────────────────────────────────────────┐
│              background.js (MV3 Service Worker)          │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │ FSP Handlers │  │ Stat Cache   │  │ Notifications │  │
│  │ (CRUD ops)   │  │ L1: RAM Map  │  │ (Progress UI) │  │
│  │              │  │ L2: IndexedDB│  │               │  │
│  └──────┬───────┘  └──────────────┘  └───────────────┘  │
│         │                                                │
│         │  self.rc() / self.fileRead() / self.fileWrite() │
│         ▼                                                │
│  ┌─────────────────────────────────────────────────┐     │
│  │           wasm_exec.js (Go Runtime Glue)         │     │
│  └──────────────────────┬──────────────────────────┘     │
│                         │                                │
│  ┌──────────────────────▼──────────────────────────┐     │
│  │              rclone.wasm (~73 MB)                │     │
│  │                                                  │     │
│  │  main.go (WASM Bridge)                           │     │
│  │  ├── rcCallback()         → RC API (Promise)     │     │
│  │  ├── configInjectCallback → Direct config write  │     │
│  │  ├── fileReadCallback()   → Ranged byte reads    │     │
│  │  ├── fileWriteCallback()  → Buffered uploads     │     │
│  │  └── fileWriteStream()    → Streaming uploads    │     │
│  │                                                  │     │
│  │  Rclone backends: drive, onedrive, s3, dropbox,  │     │
│  │  gcs, googlephotos, crypt, memory                │     │
│  └──────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────┘
                       │
                       │ fetch() (browser-native HTTP)
                       ▼
              ☁️ Cloud Storage APIs
```

### Key Design Decisions

- **No `DialContext`**: Go's WASM HTTP transport normally sets `DialContext` on `http.Transport`, which triggers Go's fake TCP/DNS stack — incompatible with Chrome Extension Service Workers. The build script patches rclone to use `fetch()` natively via build-tagged transport files (`transport_js.go`).

- **Promise-based WASM Bridge**: All rclone operations return JavaScript `Promise` objects. The actual work runs in Go goroutines, preventing deadlocks between Go's blocking I/O and the JavaScript event loop.

- **Config Injection (not `config/create`)**: The interactive `config/create` RC command launches an OAuth server, which deadlocks in WASM. Instead, `configInject()` writes config key-value pairs directly to rclone's in-memory store.

---

## Building from Source

### Prerequisites

- Linux environment (x86_64 or arm64) with `curl`, `tar`, and `git`
- ~2 GB disk space for the build directory
- Go will be downloaded automatically by the build script

### Build the WASM Binary

```bash
./build-wasm.sh
```

This script will:

1. **Download Go** (v1.22.2) into `build_tmp/`
2. **Clone rclone** from the official repository
3. **Inject the custom WASM bridge** (`src/wasm-bridge/main.go`)
4. **Patch the HTTP transport** for Service Worker compatibility
5. **Compile** with `GOOS=js GOARCH=wasm`
6. **Copy artifacts** (`rclone.wasm` + `wasm_exec.js`) to `src/`

The resulting `rclone.wasm` is approximately 73 MB.

> See [docs/WASM_BUILD.md](docs/WASM_BUILD.md) for more details on the build process.

---

## Project Structure

```
OmniFiles/
├── src/                          # Extension source (load this in chrome://extensions)
│   ├── manifest.json             # MV3 manifest with FSP capabilities
│   ├── background.js             # Service Worker — FSP handlers, caching, notifications
│   ├── config-utils.js           # Shared pure helpers (INI parsing, error mapping) — also used by the unit tests
│   ├── options.html              # Settings page — Dashboard, Wizard, Raw Editor
│   ├── options.js                # Settings page logic
│   ├── config-schemas.js         # Provider field definitions for the wizard
│   ├── rclone.wasm               # Compiled rclone binary (~73 MB)
│   ├── wasm_exec.js              # Go WASM runtime glue
│   ├── wasm-bridge/
│   │   └── main.go               # Custom Go entry point (replaces rclone's default)
│   ├── _locales/
│   │   ├── de/messages.json      # German translations
│   │   └── en/messages.json      # English translations (default_locale)
│   └── assets/                   # Extension icons (16–128px)
├── build-wasm.sh                 # WASM build script
├── tests/
│   └── config-utils.test.js      # Node unit tests (run with: node --test tests/*.test.js)
├── docs/
│   ├── CHANGELOG.md              # Detailed development log
│   ├── WASM_BUILD.md             # Build process documentation
│   ├── TESTING.md                # Testing instructions for Chromebooks
│   ├── VERSIONING.md             # Semantic versioning policy
│   └── ROADMAP.md                # Planned features and improvements
└── README.md                     # This file
```

---

## Versioning

This project follows [Semantic Versioning 2.0.0](https://semver.org/). The current version is **`0.3.0`**.

The `version` field in `src/manifest.json` is the single source of truth.

| Component | Changes |
|-----------|---------|
| **MAJOR** | Breaking changes to config format, architecture, or WASM bridge |
| **MINOR** | New features, backends, or significant UI improvements |
| **PATCH** | Bug fixes, performance optimizations, minor UI tweaks |

---

## Roadmap

### 🔴 High Priority
- **Auto-Remount on Service Worker restart** — proactively re-configure rclone when the worker wakes up
- ~~**OAuth Token Refresh**~~ ✅ *Done* — access tokens are refreshed automatically by rclone (and persisted); permanently dead refresh tokens (revoked / `invalid_grant`) now trigger a notification with a direct path to the settings page, and the dashboard shows a "Token expired" status
- **Large Directory Pagination** — paginated `operations/list` to handle folders with thousands of files

### 🟡 Medium Priority
- WebDAV backend support (Nextcloud / ownCloud)
- Encrypted configuration storage (AES-GCM via SubtleCrypto)
- Manual sync command with progress UI
- Cross-remote copy/move
- Upload retry queue with persistence
- Network change detection and auto-reconnect

### 🟢 Future
- WASM memory management (`runtime.GC()` exposure)
- In-app debug/diagnostics panel
- CI/CD build pipeline (GitHub Actions)
- Automated testing (Go unit tests, Jest, Playwright)
- Additional localizations (French, Spanish, Japanese)

> See [docs/ROADMAP.md](docs/ROADMAP.md) for the full roadmap.

---

## Technical Requirements

- **ChromeOS** 105 or later
- **Chrome Extension Manifest V3**
- The `chrome.fileSystemProvider` API is ChromeOS-only — this extension will not function on Chrome for Windows, macOS, or Linux

---

## Documentation

| Document | Description |
|----------|-------------|
| [CHANGELOG.md](docs/CHANGELOG.md) | Detailed chronological development log |
| [WASM_BUILD.md](docs/WASM_BUILD.md) | How to build the rclone WASM binary |
| [TESTING.md](docs/TESTING.md) | Step-by-step testing guide for Chromebooks |
| [VERSIONING.md](docs/VERSIONING.md) | Semantic versioning policy |
| [ROADMAP.md](docs/ROADMAP.md) | Planned features and improvements |

---

## Contributing

Contributions are welcome! Here's how to get started:

1. **Fork** the repository
2. **Create a branch** for your feature or fix
3. **Build and test** on a Chromebook (see [TESTING.md](docs/TESTING.md))
4. **Submit a Pull Request** with a clear description of your changes

### Development Tips

- The `rclone.wasm` binary is ~73 MB and tracked in the repo for convenience. If you modify the Go bridge (`src/wasm-bridge/main.go`), you'll need to rebuild it with `./build-wasm.sh`.
- Use Chrome DevTools on the Service Worker (via `chrome://extensions/` → **Inspect views: Service Worker**) to debug FSP handler logic.
- The `build_tmp/` and `tmp_rclone_build/` directories are gitignored and contain build artifacts.

---

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

### Bundled third-party software

The distributed extension bundles third-party code, primarily inside the compiled `src/rclone.wasm` binary and the `src/wasm_exec.js` runtime glue:

- **rclone** (`rclone.wasm`) — MIT License, Copyright (C) 2012 Nick Craig-Wood. See [src/LICENSE-rclone.txt](src/LICENSE-rclone.txt).
- **Go runtime, standard library & `wasm_exec.js`** — BSD-3-Clause License, Copyright (c) 2009 The Go Authors. See [src/LICENSE-go.txt](src/LICENSE-go.txt).
- **Go modules statically linked into `rclone.wasm`** (AWS SDK, Google API clients, Dropbox SDK, `golang.org/x/*`, and others) — under Apache-2.0, BSD, MIT, ISC and related licenses. See [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) for the inventory, full license texts, and how to regenerate the exact per-package manifest.

---

## Links

| | |
|---|---|
| **Install** | [Chrome Web Store](https://chromewebstore.google.com/detail/omnifiles/bdcjbkaghidiffifjhiklniadlfgdipo) |
| **Source** | [github.com/MarkusLitz/OmniFiles](https://github.com/MarkusLitz/OmniFiles) |
| **Issues & feature requests** | [GitHub Issues](https://github.com/MarkusLitz/OmniFiles/issues) |
| **Privacy** | [PRIVACY_POLICY.md](PRIVACY_POLICY.md) |

---

<p align="center">
  <sub>Built with ❤️ for ChromeOS · Powered by <a href="https://rclone.org/">rclone</a> + WebAssembly</sub>
</p>
