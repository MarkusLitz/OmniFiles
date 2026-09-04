# Testing OmniFiles

OmniFiles plugs into the ChromeOS Files app via `chrome.fileSystemProvider`, so
**everything below the unit tests requires a real Chromebook.** The API is not
functional on Chrome for Windows, macOS, or desktop Linux.

---

## 1. Unit tests (any machine)

The pure helpers in `src/config-utils.js` (INI parse/serialize, token
sanitization, parent-path resolution, FSP error mapping, auth-error detection)
are covered by the Node test runner:

```bash
node --test tests/*.test.js
```

> The glob matters. A bare `node --test tests/` does not resolve the suite and
> fails with `MODULE_NOT_FOUND`.

Everything else — FSP handlers, the WASM bridge, caching, notifications — has no
automated coverage yet and must be exercised by hand on-device.

---

## 2. Install on the Chromebook

1. Copy the repository (or an unpacked release zip) onto the Chromebook.
2. Open `chrome://extensions/`.
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select the **`src/` directory** — not the
   repository root.
5. OmniFiles should appear in the extension list with no errors.

> If you rebuilt `rclone.wasm`, reload the extension afterwards; the Service
> Worker caches the old binary until it restarts.

---

## 3. Configure a remote

Right-click the OmniFiles icon → **Options**.

**Guided Setup** (recommended): pick a provider, fill in the credentials, run
**Test Connection**, then save.

**Advanced (Raw Config)**: paste an existing `rclone.conf` and click
**Save Raw Config**.

For Google Drive, OneDrive, Dropbox and Google Photos you need a token generated
on a desktop machine first (`rclone authorize drive`, etc.) — see the README's
Configuration section. S3 and other key-based backends need no such step, which
makes S3 (or a MinIO instance) the fastest backend to smoke-test against.

**Verify:** the remote appears under the **Manage** list with a status dot, and
the **Dashboard** tab shows it once mounted.

---

## 4. Mount

1. Open the **Files app**.
2. Three-dot menu → **Add new service** → **OmniFiles**.
3. Every remote in your config mounts as its own drive, labelled
   **`OmniFiles (<remote-name>)`** in the sidebar.

**Verify:** one sidebar entry per configured remote. If a remote is missing,
check the Service Worker console — a failed `configInject` is logged there.

> **Cold start:** the first request after the Service Worker wakes can take
> several seconds while the 70 MB WASM binary initialises and the backend is
> pre-warmed. Subsequent requests are served from the L1/L2 cache and should feel
> instant.

---

## 5. Filesystem operations

Against a mounted drive, confirm each of these:

| Operation | What to check |
|---|---|
| **Browse** | Directory listings match the provider's own web UI. Folders with >1000 entries still render (entries are delivered in batches). |
| **Open / read** | Double-click a document — it opens with correct contents. |
| **Write** | Save a file into the drive from another app; re-open it and confirm the bytes round-trip. |
| **Rename** | Rename a file and a folder; the change appears at the provider. |
| **Move** | Drag a file to another folder *within the same drive*. |
| **Copy** | Copy a file *within the same drive*. |
| **Delete** | Delete a file and a folder. |

> **Known limitation:** copy and move only work *within* one remote. Dragging
> between two OmniFiles drives (e.g. Drive → S3) is not implemented yet and is
> expected to fail — see the Cross-Remote Copy/Move roadmap item.

### Upload path split

Uploads change strategy at **4 MB**, so test both sides of the boundary:

- **< 4 MB** — buffered in memory (supports random-access edits).
- **≥ 4 MB** — streamed to the cloud via `TransformStream`.

A large upload should also show a **progress notification**, and the Service
Worker must stay alive for its full duration (the `chrome.alarms` keep-alive).
Confirm the file is complete and uncorrupted at the provider afterwards.

### Download progress

Copy a file **≥ 4 MB** from the drive to Downloads. A progress notification
should appear and advance in ~10% steps to 100%.

---

## 6. Thumbnails

Put a few images (`.jpg`, `.jpeg`, `.png`, `.webp`, `.bmp`) on the remote and
switch the Files app to a grid view.

**Verify:** real image previews, not generic type icons. Thumbnails are capped at
32 KB by the FSP API — OmniFiles shrinks progressively to fit, so a very large
photo should still preview (just softer). Non-image types correctly show generic
icons.

Reload the extension and revisit the folder: thumbnails should return from the
IndexedDB cache without re-downloading.

---

## 7. Context-menu actions

Right-click an entry on an OmniFiles drive. All four actions surface their result
as a **notification** — a Service Worker cannot write to the clipboard directly.

| Action | Expected behaviour |
|---|---|
| **Copy Link** | Generates a public link (7-day expiry) and shows it in a notification with an **open in browser** button. Hidden for directories on most backends. Backends without public-link support show a failure notification — that is correct behaviour, not a bug. |
| **Copy Path** | Notification with the rclone path (e.g. `gdrive:documents/file.pdf`). Multi-select yields one path per line. The button opens the options page, where the value can be copied. |
| **File Details** | Single selection only. Notification with name, type, size, modification date and MIME type. |
| **Clear Cache** | Invalidates cached listings; re-entering the folder refetches from the backend. |

---

## 8. Dashboard & health checks

Options → **Dashboard**.

**Verify:** one card per active mount showing type, storage quota (via
`operations/about`), and active upload count. Status reads **Online** for a
working remote.

Health checks re-run every **15 minutes**. To test the failure paths:

- **Offline:** disconnect the network, wait for the next check → status flips to
  Offline.
- **Token expired:** revoke the extension's access at the provider (for Google:
  https://myaccount.google.com/permissions) → the next check should produce an
  `invalid_grant`, a re-auth notification linking to the settings page, and a
  **Token expired** status on the dashboard.

---

## 9. Unmount

Click the **eject** icon next to an OmniFiles drive in the sidebar.

**Verify:** the entry disappears and does not reappear on its own. Re-mounting
via **Add new service** restores it.

---

## 10. Localisation & theme

- Switch ChromeOS to German and reload the extension — the options page and all
  notifications should be fully German, with no leftover English strings or empty
  labels.
- Cycle the dark-mode toggle (**Auto → Dark → Light**) and confirm the preference
  survives a reload.

---

## Troubleshooting

- **Extension won't load** — you selected the repository root instead of `src/`.
- **No "Add new service" entry** — you are not on ChromeOS; the API is unavailable
  elsewhere.
- **Mount succeeds but the drive is empty or errors** — open
  `chrome://extensions/` → **Inspect views: Service Worker** and read the
  `[Rclone]` log lines. Config injection failures, auth errors, and FSP handler
  errors are all logged there.
- **Operations time out** — ChromeOS gives FSP handlers roughly 10 seconds. A
  cold WASM start or a very large directory can exceed it; retrying after the
  worker has warmed up usually succeeds.
