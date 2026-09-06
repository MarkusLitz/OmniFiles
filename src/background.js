// OmniFiles - ChromeOS Rclone Integration
// Copyright (c) 2026 Markus Litz
// Licensed under the MIT License. See LICENSE file in the project root for details.

// ChromeOS Rclone Service Worker

importScripts('wasm_exec.js', 'config-utils.js');

// i18n shorthand — works in Service Workers
const msg = (key, ...subs) => chrome.i18n.getMessage(key, subs.length ? subs : undefined);

// ═══════════════════════════════════════════════════════════════════════
// SERVICE WORKER KEEP-ALIVE
// Chrome MV3 Service Workers are terminated after ~5 min of inactivity.
// During long-running uploads we keep the worker alive using a repeating
// chrome.alarm that fires every 20 s. chrome.alarms is the only reliable
// wake-up mechanism available inside a Service Worker (self-connect does
// not work here — it requires a foreground extension page).
// ═══════════════════════════════════════════════════════════════════════

const KEEPALIVE_ALARM = 'uploadKeepAlive';
// Number of uploads currently relying on the alarm, not a boolean: the Files app
// happily runs several uploads at once, and with a flag the first one to finish
// cleared the alarm out from under every other one still in flight — letting
// Chrome terminate the worker mid-upload, which is the exact failure this whole
// mechanism exists to prevent.
let _keepAliveHolders = 0;

/**
 * Registers one holder of the keep-alive alarm, starting it if it is not
 * already running. Every call MUST be paired with exactly one stopKeepAlive(),
 * or a concurrent upload will have its alarm released early.
 */
function startKeepAlive() {
    _keepAliveHolders++;
    if (_keepAliveHolders > 1) {
        console.log(`[Rclone] Keep-alive already running (${_keepAliveHolders} uploads)`);
        return;
    }
    console.log('[Rclone] Starting keep-alive alarm for long-running upload');
    // periodInMinutes minimum is 1 min in MV3, but we can use delayInMinutes
    // chained with repeated scheduling via the alarm handler instead.
    chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.33 }); // ~20 s
}

/**
 * Releases one holder. The alarm is only cleared once the last concurrent
 * upload has finished.
 */
function stopKeepAlive() {
    // Defensive: an unpaired stop would release the alarm on behalf of an
    // upload that is still running.
    if (_keepAliveHolders === 0) return;
    _keepAliveHolders--;
    if (_keepAliveHolders > 0) {
        console.log(`[Rclone] Keep-alive still needed (${_keepAliveHolders} uploads remaining)`);
        return;
    }
    chrome.alarms.clear(KEEPALIVE_ALARM);
    console.log('[Rclone] Keep-alive alarm stopped');
}

// A worker terminated mid-upload leaves the alarm registered with Chrome while
// _keepAliveHolders resets to 0 here, so nothing would ever clear it again and it
// would wake the worker every 20 s indefinitely. No upload can be in flight
// during startup (openFiles is empty), so any surviving alarm is stale.
chrome.alarms.clear(KEEPALIVE_ALARM);

// ═══════════════════════════════════════════════════════════════════════
// OAUTH RE-AUTH DETECTION
// rclone refreshes access tokens automatically via the refresh_token (plain
// HTTPS POST — works through the fetch() transport), and refreshed tokens are
// persisted back to chrome.storage via the onConfigChanged callback below.
// This section only handles the case that the *refresh itself* fails
// permanently (refresh token expired or revoked → e.g. Google "invalid_grant"):
// instead of every operation failing silently, the user gets a notification
// with a direct path to the options page to paste a fresh token.
// ═══════════════════════════════════════════════════════════════════════

const AUTH_NOTIFY_THROTTLE_MS = 30 * 60 * 1000; // max. 1 notification per remote per 30 min
const AUTH_NOTIF_PREFIX = 'rclone-auth-';
const lastAuthNotify = new Map(); // remoteName → timestamp of last notification

function notifyAuthExpired(remoteName, err) {
    if (!remoteName) return;
    const now = Date.now();
    if (now - (lastAuthNotify.get(remoteName) || 0) < AUTH_NOTIFY_THROTTLE_MS) return;
    lastAuthNotify.set(remoteName, now);

    console.warn(`[Rclone] OAuth token for "${remoteName}" is expired/revoked:`, err);

    // Persist the auth state so the dashboard shows it even after a SW restart
    chrome.storage.local.get(['remoteStatus'], (result) => {
        const statusObj = result.remoteStatus || {};
        statusObj[remoteName] = {
            status: 'auth_expired',
            error: String((err && typeof err === 'object' && (err.error || err.message)) || err),
            timestamp: now
        };
        chrome.storage.local.set({ remoteStatus: statusObj });
    });

    // Stable id per remote: repeated failures replace the notification instead of stacking
    chrome.notifications.create(AUTH_NOTIF_PREFIX + remoteName, {
        type: 'basic',
        iconUrl: 'assets/icon_128.png',
        title: msg('notif_auth_title', remoteName),
        message: msg('notif_auth_msg', remoteName),
        buttons: [{ title: msg('notif_btn_settings') }],
        requireInteraction: true,
    });
}

// Called when a remote works again (health check succeeded): reset the
// throttle and remove a possibly still-visible re-auth notification.
function clearAuthExpired(remoteName) {
    if (!lastAuthNotify.has(remoteName)) return;
    lastAuthNotify.delete(remoteName);
    chrome.notifications.clear(AUTH_NOTIF_PREFIX + remoteName);
}

// Single top-level listener (MV3-safe: re-registered on every SW start).
chrome.notifications.onButtonClicked.addListener((notifId) => {
    if (!notifId.startsWith(AUTH_NOTIF_PREFIX)) return;
    chrome.runtime.openOptionsPage();
    chrome.notifications.clear(notifId);
});

// Create a promise that resolves when rclone WASM is initialized
self.rcValidResolve = null;
self.rcValid = new Promise(resolve => {
    self.rcValidResolve = resolve;
});

// Polyfill for streaming instantiation just in case
if (!WebAssembly.instantiateStreaming) {
    WebAssembly.instantiateStreaming = async (resp, importObject) => {
        const source = await (await resp).arrayBuffer();
        return await WebAssembly.instantiate(source, importObject);
    };
}

console.log('[Rclone] Initializing WebAssembly...');
const go = new Go();

// Load the compiled WASM binary
WebAssembly.instantiateStreaming(fetch('rclone.wasm'), go.importObject).then((result) => {
    // go.run() keeps the Go program running indefinitely
    go.run(result.instance);
}).catch(err => {
    console.error('[Rclone] Failed to initialize WASM:', err);
});

// Once initialized, test the RC bridge and proactively warm up existing remotes
self.rcValid.then(async () => {
    console.log('[Rclone] WASM Bridge Initialized Successfully!');

    // Wrap the Go-provided rc() once so permanent auth failures on *any* call
    // path (FSP handlers, dashboard, health checks) trigger the re-auth
    // notification. The error is re-thrown unchanged for the normal handling.
    const rcOriginal = self.rc;
    self.rc = function (method, params) {
        return rcOriginal(method, params).catch((err) => {
            if (isAuthError(err)) {
                const fsParam = (params && (params.fs || params.srcFs)) || '';
                notifyAuthExpired(String(fsParam).split(':')[0], err);
            }
            throw err;
        });
    };

    try {
        const versionInfo = await self.rc('core/version', {});
        console.log('[Rclone] Version:', versionInfo);
    } catch (err) {
        console.error('[Rclone] Error calling core/version:', err);
    }

    // If mounts already exist (SW woke up from sleep), configure rclone eagerly
    // and fire background stat calls so the Drive backend is initialized before
    // the first real FSP request arrives — avoiding the 10-20s cold-start delay.
    chrome.storage.local.get(['rcloneConf', 'mountedFileSystems'], async (result) => {
        if (!result.rcloneConf || !result.mountedFileSystems?.length) return;
        try {
            const remotes = await configureRclone();
            console.log('[Rclone] Pre-warming backends:', remotes.join(', '));
            for (const remoteName of remotes) {
                self.rc('operations/stat', { fs: remoteName + ':', remote: '' })
                    .catch(() => {}); // fire-and-forget; errors are irrelevant here
            }
        } catch (_) {
            // No config yet or WASM not ready — first FSP request will trigger setup
        }
    });
});

// ======== ChromeOS File System Provider API Implementation ========

// parseIniConfig / serializeIniConfig / sanitizeTokenValue / getParentPath /
// mapErrorToFsp are provided by config-utils.js (shared with the Node unit
// tests in tests/).

// Queue to serialize storage writes and prevent race conditions when multiple keys are updated
let configUpdateQueue = Promise.resolve();

// In-memory mirror of the config currently injected into the WASM core.
// configInject() re-asserts every key on every periodic check (checkAllRemotes,
// every 5 min) and on every SW wakeup, even though the values almost never change.
// Without this cache, every single one of those re-asserted keys would round-trip
// through chrome.storage via onConfigChanged below — e.g. 11 serialized get/set
// pairs for 3 remotes — which starves the single-threaded WASM Service Worker and
// causes real FSP requests (stat/list/read) to miss the ~10s ChromeOS timeout.
// Keeping this mirror lets us skip the storage round-trip unless a value actually
// changed (the real use case: an OAuth token refreshed internally by rclone).
let liveConfigCache = {};

// Callback invoked by Go WASM when configuration keys change (e.g. OAuth token refresh)
self.onConfigChanged = function(section, key, value) {
    if (liveConfigCache[section] && liveConfigCache[section][key] === value) {
        return; // no-op re-assertion of an already-known value — skip the storage write
    }
    console.log(`[Rclone] Config changed internally: [${section}] ${key} = ${value}`);
    configUpdateQueue = configUpdateQueue.then(() => {
        return new Promise((resolve) => {
            chrome.storage.local.get(['rcloneConf'], (result) => {
                const confText = result.rcloneConf || '';
                const config = parseIniConfig(confText);

                if (!config[section]) {
                    config[section] = {};
                }
                config[section][key] = value;

                if (!liveConfigCache[section]) liveConfigCache[section] = {};
                liveConfigCache[section][key] = value;

                const newConfText = serializeIniConfig(config);
                chrome.storage.local.set({ rcloneConf: newConfText }, () => {
                    console.log(`[Rclone] Saved updated config for [${section}] ${key} to storage.`);
                    resolve();
                });
            });
        });
    });
};

// The injection promise, held from the moment it starts rather than a "done"
// flag set at the end. Waking the worker makes the Files app fire a burst of FSP
// events that each await configureRclone(); with a boolean, none of them had
// been marked configured yet, so every one ran its own storage read and its own
// full configInject() pass into the single-threaded WASM core — starving the
// real stat/list/read calls that have to answer inside ChromeOS's ~10 s timeout.
// Sharing one in-flight promise collapses that burst into a single injection.
let _configPromise = null;
let configuredRemotes = [];

/**
 * Injects the stored rclone.conf into the WASM core, at most once per worker
 * lifetime unless forced.
 *
 * @param {boolean} force Re-inject even though a previous injection succeeded.
 *   Needed after the config changes: without it the memoised promise short-
 *   circuits forever, so an edited remote (e.g. a freshly pasted OAuth token) or
 *   a newly added one is never pushed into the core, and configuredRemotes stays
 *   stale so the caller mounts the old list.
 * @returns {Promise<string[]>} names of the configured remotes
 */
async function configureRclone(force = false) {
    if (_configPromise && !force) return _configPromise;

    const pending = new Promise((resolve, reject) => {
        chrome.storage.local.get(['rcloneConf', 'mountedFileSystems'], (result) => {
            if (chrome.runtime.lastError) {
                return reject(chrome.runtime.lastError);
            }
            if (!result.rcloneConf) {
                return reject(new Error("No OmniFiles configuration found. Please configure it in the extension options."));
            }
            
            // Wait for WASM to be ready
            self.rcValid.then(async () => {
                try {
                    console.log("[Rclone] Injecting config into memory...");
                    const parsedConf = parseIniConfig(result.rcloneConf);
                    // Mirror what's about to be injected so onConfigChanged can tell
                    // real changes apart from this routine re-assertion (see definition above).
                    liveConfigCache = parsedConf;

                    for (const [remoteName, remoteConfig] of Object.entries(parsedConf)) {
                        console.log(`[Rclone] Injecting remote config: ${remoteName}`);

                        // Sanitize token JSON if present (fixes copy-paste corruption)
                        if (remoteConfig.token) {
                            remoteConfig.token = sanitizeTokenValue(remoteConfig.token);
                            console.log(`[Rclone] Token sanitized for ${remoteName}`);
                        }

                        // Use configInject instead of config/create to avoid OAuth deadlock in WASM
                        const res = self.configInject(remoteName, remoteConfig);
                        console.log(`[Rclone] configInject response for ${remoteName}:`, res);
                        
                        if (res && res.error) {
                            throw new Error(`configInject failed for ${remoteName}: ${res.error}`);
                        }
                    }

                    configuredRemotes = Object.keys(parsedConf);

                    resolve(configuredRemotes);
                } catch (err) {
                    console.error("[Rclone] Error pushing config to RC:", err);
                    reject(err);
                }
            });
        });
    });

    _configPromise = pending;
    // A failed injection must not be memoised — no config saved yet, a storage
    // error or a WASM hiccup would otherwise be cached for the rest of the
    // worker's life and every later FSP call would fail against it. The identity
    // check keeps a late failure from clearing a newer forced injection.
    pending.catch(() => {
        if (_configPromise === pending) _configPromise = null;
    });
    return pending;
}

// Serializes read-modify-write updates to the mountedFileSystems array.
// Multiple mount callbacks can fire back-to-back (multi-remote configs);
// without this queue, concurrent get→set roundtrips could overwrite each
// other's changes and silently drop mount entries.
let mountsUpdateQueue = Promise.resolve();
function updateMountedFileSystems(mutate) {
    mountsUpdateQueue = mountsUpdateQueue.then(() => new Promise((resolve) => {
        chrome.storage.local.get({ mountedFileSystems: [] }, (result) => {
            const mounts = mutate(result.mountedFileSystems) || result.mountedFileSystems;
            chrome.storage.local.set({ mountedFileSystems: mounts }, resolve);
        });
    }));
    return mountsUpdateQueue;
}

if (chrome.fileSystemProvider) {
    console.log('[Rclone] FileSystemProvider API available.');

    chrome.fileSystemProvider.onMountRequested.addListener((options, successCallback, errorCallback) => {
        console.log('[Rclone] onMountRequested', options);
        
        // Respond immediately to satisfy the OS mount request signature/timeout
        // Actual mounting logic continues in the background
        try {
            successCallback();
        } catch (e) {
            console.warn('[Rclone] successCallback failed (might be expected in some Chrome versions):', e);
        }

        configureRclone().then((remotes) => {
            console.log(`[Rclone] Config loaded. Active remotes: ${remotes.join(', ')}`);
            
            if (remotes.length === 0) {
                console.error('[Rclone] No remotes found in configuration.');
                return;
            }

            remotes.forEach(remoteName => {
                const fileSystemId = remoteName;
                const displayName = `OmniFiles (${remoteName})`;

                console.log(`[Rclone] Attempting mount for ${fileSystemId}...`);
                chrome.fileSystemProvider.mount({
                    fileSystemId: fileSystemId,
                    displayName: displayName,
                    writable: true
                }, () => {
                    if (chrome.runtime.lastError) {
                        const msg = chrome.runtime.lastError.message;
                        if (msg.includes('Already mounted')) {
                            console.log(`[Rclone] ${fileSystemId} is already mounted.`);
                        } else {
                            console.error(`[Rclone] Mount failed for ${remoteName}:`, msg);
                        }
                    } else {
                        console.log(`[Rclone] Successfully mounted ${fileSystemId}`);
                        updateMountedFileSystems((mounts) => {
                            if (!mounts.find(m => m.id === fileSystemId)) {
                                mounts.push({ id: fileSystemId, name: displayName, remote: remoteName + ':' });
                            }
                            return mounts;
                        });
                    }
                });
            });
        }).catch(err => {
            console.error('[Rclone] Pre-mount configuration failed:', err);
        });
    });

    chrome.fileSystemProvider.onUnmountRequested.addListener((options, successCallback, errorCallback) => {
        console.log('[Rclone] onUnmountRequested', options);
        chrome.fileSystemProvider.unmount({ fileSystemId: options.fileSystemId }, () => {
            if (chrome.runtime.lastError) {
                console.error('[Rclone] Unmount failed:', chrome.runtime.lastError);
                errorCallback('FAILED');
            } else {
                updateMountedFileSystems((mounts) => mounts.filter(m => m.id !== options.fileSystemId));
                successCallback();
            }
        });
    });

    // ═══════════════════════════════════════════════════════════════════
    // TWO-LEVEL METADATA CACHE
    //   L1 – RAM Map  (fast, wiped when Service Worker sleeps)
    //   L2 – IndexedDB (persistent across SW restarts)
    // ═══════════════════════════════════════════════════════════════════

    const statCache = new Map();             // L1 – in-memory
    const CACHE_TTL_MS   = 5 * 60 * 1000;  // 5 min  – normal freshness window
    const CACHE_TTL_HARD = 24 * 60 * 60 * 1000; // 24 h – max IDB entry age

    // ── IndexedDB helpers ────────────────────────────────────────────────

    const IDB_NAME    = 'rclone-stat-cache';
    const IDB_STORE   = 'entries';
    const IDB_VERSION = 1;

    /** Singleton IDB connection. Opened once, reused for every subsequent call. */
    let _idbPromise = null;
    function idbOpen() {
        if (_idbPromise) return _idbPromise;
        _idbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(IDB_NAME, IDB_VERSION);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(IDB_STORE)) {
                    db.createObjectStore(IDB_STORE); // keyed by cacheKey string
                }
            };
            req.onsuccess = (e) => resolve(e.target.result);
            req.onerror   = (e) => {
                _idbPromise = null; // allow retry on next call
                reject(e.target.error);
            };
        });
        return _idbPromise;
    }

    /** Reads one entry from IDB. Returns { item, timestamp, thumbnail? } or null. */
    async function idbCacheGet(cacheKey) {
        try {
            const db = await idbOpen();
            return await new Promise((resolve, reject) => {
                const tx  = db.transaction(IDB_STORE, 'readonly');
                const req = tx.objectStore(IDB_STORE).get(cacheKey);
                req.onsuccess = (e) => resolve(e.target.result ?? null);
                req.onerror   = (e) => reject(e.target.error);
            });
        } catch (err) {
            console.warn('[Rclone][IDB] read error:', err);
            return null;
        }
    }

    /** Writes / updates one entry in IDB (fire-and-forget – never blocks callers). */
    function idbCachePut(cacheKey, entry) {
        idbOpen().then(db => {
            const tx  = db.transaction(IDB_STORE, 'readwrite');
            tx.objectStore(IDB_STORE).put(entry, cacheKey);
        }).catch(err => console.warn('[Rclone][IDB] write error:', err));
    }

    /** Deletes one entry from IDB. */
    function idbCacheDelete(cacheKey) {
        idbOpen().then(db => {
            const tx  = db.transaction(IDB_STORE, 'readwrite');
            tx.objectStore(IDB_STORE).delete(cacheKey);
        }).catch(err => console.warn('[Rclone][IDB] delete error:', err));
    }

    /**
     * Removes all IDB entries older than CACHE_TTL_HARD.
     * Called once at startup in the background – never blocks the SW boot path.
     */
    function idbCleanupExpired() {
        idbOpen().then(db => {
            const cutoff = Date.now() - CACHE_TTL_HARD;
            const tx     = db.transaction(IDB_STORE, 'readwrite');
            const store  = tx.objectStore(IDB_STORE);
            const req    = store.openCursor();
            let deleted  = 0;
            req.onsuccess = (e) => {
                const cursor = e.target.result;
                if (!cursor) {
                    if (deleted > 0)
                        console.log(`[Rclone][IDB] Cleanup: removed ${deleted} expired entries.`);
                    return;
                }
                if (cursor.value && cursor.value.timestamp < cutoff) {
                    cursor.delete();
                    deleted++;
                }
                cursor.continue();
            };
            req.onerror = (e) => console.warn('[Rclone][IDB] cleanup cursor error:', e.target.error);
        }).catch(err => console.warn('[Rclone][IDB] cleanup open error:', err));
    }

    // Kick off cleanup in the background (non-blocking)
    idbCleanupExpired();

    // ── Cache access helpers ─────────────────────────────────────────────

    /**
     * Looks up a cacheKey:
     *   1. Returns L1 (RAM) entry if still fresh.
     *   2. Falls back to L2 (IDB), promotes to L1 if still within TTL.
     *   3. Returns null if stale or absent.
     */
    async function cacheGet(cacheKey) {
        // L1 check
        const mem = statCache.get(cacheKey);
        if (mem) {
            if (Date.now() - mem.timestamp < CACHE_TTL_MS) return mem;
            statCache.delete(cacheKey); // evict stale L1 entry
        }
        // L2 check
        const idb = await idbCacheGet(cacheKey);
        if (idb && (Date.now() - idb.timestamp < CACHE_TTL_MS)) {
            statCache.set(cacheKey, idb); // promote to L1
            return idb;
        }
        return null;
    }

    /**
     * Writes to both L1 and L2.
     */
    function cacheSet(cacheKey, entry) {
        statCache.set(cacheKey, entry);
        idbCachePut(cacheKey, entry);
    }

    function invalidateCache(remote, entryPath) {
        // remote is like "ziraInfo:" and entryPath comes from chromeos (with leading /)
        const key1 = remote + entryPath;
        statCache.delete(key1);
        idbCacheDelete(key1);
        statCache.delete('__listing__:' + key1);
        idbCacheDelete('__listing__:' + key1);

        // Also invalidate the parent directory's stat and listing cache
        const parentPath = getParentPath(entryPath);
        const key2 = remote + parentPath;
        statCache.delete(key2);
        idbCacheDelete(key2);
        statCache.delete('__listing__:' + key2);
        idbCacheDelete('__listing__:' + key2);
    }

    // Returns a valid Date, falling back to now if the input is missing or unparseable
    function safeDate(modTime) {
        if (!modTime) return new Date();
        const d = new Date(modTime);
        // Ensure it's a valid Date object that FSP can serialize
        if (isNaN(d.getTime())) return new Date();
        return d;
    }

    const pendingNotifications = new Map();

    // Notifies the Files app of a change in a directory, so it can refresh its view.
    function notifyChange(fileSystemId, observedPath, changeType, entryPath) {
        const key = fileSystemId + ':' + observedPath;
        if (!pendingNotifications.has(key)) {
            pendingNotifications.set(key, {
                changes: [],
                timer: null
            });
        }
        
        const pending = pendingNotifications.get(key);
        if (entryPath) {
            // Only add if not already present with same type to avoid massive arrays
            if (!pending.changes.find(c => c.entryPath === entryPath && c.changeType === changeType)) {
                pending.changes.push({ entryPath, changeType });
            }
        }
        
        if (pending.timer) {
            clearTimeout(pending.timer);
        }
        
        pending.timer = setTimeout(() => {
            const currentChanges = pending.changes;
            pendingNotifications.delete(key);
            
            // Provide both root-level changeType and changes array for maximum compatibility
            chrome.fileSystemProvider.notify(
                {
                    fileSystemId,
                    observedPath,
                    recursive: false,
                    changeType: changeType,
                    changes: currentChanges,
                    tag: String(Date.now())
                },
                () => {
                    if (chrome.runtime.lastError) {
                        console.warn('[Rclone] notify callback:', chrome.runtime.lastError.message);
                    }
                }
            );
        }, 200);
    }

    function isImageFile(filename) {
        if (!filename) return false;
        const ext = filename.split('.').pop().toLowerCase();
        return ['jpg', 'jpeg', 'png', 'webp', 'bmp'].includes(ext);
    }

    // chrome.fileSystemProvider hard-caps EntryMetadata.thumbnail at 32 KB
    // (data URI, PNG/JPEG/WEBP). Larger thumbnails are silently dropped by
    // the Files app, which then falls back to the generic type icon.
    const MAX_THUMBNAIL_BYTES = 32 * 1024;

    async function generateThumbnail(uint8Array, mimeType) {
        try {
            const blob = new Blob([uint8Array], { type: mimeType });
            const bitmap = await createImageBitmap(blob);

            // Progressively shrink dimensions/quality until the encoded data URI
            // fits inside the 32 KB limit. Cheap to retry — all work happens
            // on the already-decoded bitmap, no extra network calls.
            const attempts = [
                { maxDim: 320, quality: 0.8 },
                { maxDim: 320, quality: 0.6 },
                { maxDim: 200, quality: 0.6 },
                { maxDim: 200, quality: 0.4 },
                { maxDim: 120, quality: 0.4 },
            ];

            for (const { maxDim, quality } of attempts) {
                let w = bitmap.width;
                let h = bitmap.height;
                if (w > maxDim || h > maxDim) {
                    const ratio = Math.min(maxDim / w, maxDim / h);
                    w = Math.floor(w * ratio);
                    h = Math.floor(h * ratio);
                }

                const canvas = new OffscreenCanvas(w, h);
                const ctx = canvas.getContext('2d');
                ctx.drawImage(bitmap, 0, 0, w, h);

                const thumbBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
                const buffer = await thumbBlob.arrayBuffer();

                let binary = '';
                const bytes = new Uint8Array(buffer);
                for (let i = 0; i < bytes.byteLength; i++) {
                    binary += String.fromCharCode(bytes[i]);
                }
                const dataUrl = `data:image/jpeg;base64,${btoa(binary)}`;
                if (dataUrl.length <= MAX_THUMBNAIL_BYTES) return dataUrl;
            }

            console.warn('[Rclone] Could not shrink thumbnail under the 32KB FSP limit, skipping.');
            return null;
        } catch (e) {
            console.error('[Rclone] generateThumbnail error:', e);
            return null;
        }
    }

    chrome.fileSystemProvider.onGetMetadataRequested.addListener(async (options, successCallback, errorCallback) => {
        console.log('[Rclone] onGetMetadataRequested starts:', options.entryPath, 'thumbnail:', options.thumbnail);
        
        try {
            await configureRclone();
        } catch (err) {
            console.error('[Rclone] Config Error on wakeup:', err);
            return errorCallback('FAILED');
        }

        // Short-circuit for root directory — no Google Drive call needed.
        if (options.entryPath === '/') {
            const rootMeta = {};
            if (options.isDirectory) rootMeta.isDirectory = true;
            if (options.name) rootMeta.name = '';
            if (options.size) rootMeta.size = 0;
            if (options.modificationTime) rootMeta.modificationTime = new Date();
            console.log('[Rclone] Root metadata requested, returning immediately.');
            successCallback(rootMeta);
            return;
        }

        const currentRemote = options.fileSystemId + ':';
        const cacheKey = currentRemote + options.entryPath;
        const rclonePath = options.entryPath.substring(1); // strip leading /

        // Check if it's a virtual file (created but not uploaded yet)
        if (typeof virtualFiles !== 'undefined' && virtualFiles.has(cacheKey)) {
            console.log('[Rclone] returning synthetic metadata for virtual file:', rclonePath);
            const metadata = {};
            if (options.isDirectory) metadata.isDirectory = false;
            if (options.name) metadata.name = options.entryPath.split('/').pop() || options.entryPath;
            if (options.size) metadata.size = 0;
            if (options.modificationTime) metadata.modificationTime = new Date();
            if (options.thumbnail) metadata.thumbnail = null;
            return successCallback(metadata);
        }

        let item = null;
        // Use the two-level cache (L1=RAM, L2=IndexedDB)
        let cached = await cacheGet(cacheKey);

        if (cached) {
            item = cached.item;
        } else {
            try {
                const statRes = await self.rc('operations/stat', { fs: currentRemote, remote: rclonePath });
                if (!statRes || !statRes.item) {
                    console.warn('[Rclone] stat returned no item for:', rclonePath);
                    return errorCallback('NOT_FOUND');
                }
                item = statRes.item;
                cached = { item, timestamp: Date.now() };
                cacheSet(cacheKey, cached);  // write-through to RAM + IDB
            } catch (err) {
                console.error('[Rclone] stat API Error:', err);
                return errorCallback(mapErrorToFsp(err, 'NOT_FOUND'));
            }
        }

        const metadata = {};
        if (options.isDirectory) metadata.isDirectory = !!item.IsDir;
        if (options.name) metadata.name = item.Name || options.entryPath.split('/').pop() || options.entryPath;
        // Always provide size when requested; use 0 for directories (rclone returns -1 for dirs)
        if (options.size) metadata.size = (item.Size >= 0) ? item.Size : 0;
        if (options.modificationTime) metadata.modificationTime = safeDate(item.ModTime);

        // THUMBNAIL LOGIC
        if (options.thumbnail && !item.IsDir) {
            if (cached.thumbnail !== undefined) {
                if (cached.thumbnail) metadata.thumbnail = cached.thumbnail;
            } else {
                const name = metadata.name || '';
                const size = metadata.size || 0;
                if (isImageFile(name) && size > 0 && size < 20 * 1024 * 1024) {  // < 20MB limit
                    try {
                        console.log(`[Rclone] Generating thumbnail for: ${rclonePath}`);
                        const fileData = await self.fileRead(currentRemote, rclonePath, 0, size);
                        const mimeType = 'image/' + name.split('.').pop().toLowerCase().replace('jpg', 'jpeg');
                        const thumbDataUrl = await generateThumbnail(fileData, mimeType);
                        if (thumbDataUrl) {
                            metadata.thumbnail = thumbDataUrl;
                            cached.thumbnail = thumbDataUrl;
                        } else {
                            cached.thumbnail = null;
                        }
                    } catch (e) {
                        console.error('[Rclone] Thumbnail generation failed', e);
                        cached.thumbnail = null;
                    }
                } else {
                    cached.thumbnail = null;
                }
                // Persist the thumbnail decision back to IDB
                idbCachePut(cacheKey, cached);
            }
        }

        successCallback(metadata);
    });

    chrome.fileSystemProvider.onReadDirectoryRequested.addListener(async (options, successCallback, errorCallback) => {
        console.log('[Rclone] onReadDirectoryRequested:', options.directoryPath);
        
        try {
            await configureRclone();
        } catch (err) {
            console.error('[Rclone] Config Error on wakeup:', err);
            return errorCallback('FAILED');
        }

        const currentRemote = options.fileSystemId + ':';
        const rclonePath = options.directoryPath === '/' ? '' : options.directoryPath.substring(1);
        const listingCacheKey = '__listing__:' + currentRemote + options.directoryPath;

        // Delivers entries to the FSP in bounded batches. Huge folders would
        // otherwise produce one giant IPC message to the Files app; the FSP
        // explicitly supports repeated successCallback(batch, hasMore) calls.
        const LISTING_BATCH_SIZE = 1000;
        function deliverEntries(entries) {
            if (entries.length <= LISTING_BATCH_SIZE) {
                return successCallback(entries, false);
            }
            for (let i = 0; i < entries.length; i += LISTING_BATCH_SIZE) {
                const hasMore = i + LISTING_BATCH_SIZE < entries.length;
                successCallback(entries.slice(i, i + LISTING_BATCH_SIZE), hasMore);
            }
        }

        try {
            // ── L1/L2 listing cache hit ──────────────────────────────────────
            const cachedListing = await cacheGet(listingCacheKey);
            if (cachedListing && cachedListing.items) {
                console.log(`[Rclone] Listing cache hit: ${options.directoryPath} (${cachedListing.items.length} entries)`);
                const entries = cachedListing.items.map(item => {
                    const e = { isDirectory: !!item.IsDir, name: item.Name };
                    if (options.size) e.size = (item.Size >= 0) ? item.Size : 0;
                    if (options.modificationTime) e.modificationTime = safeDate(item.ModTime);
                    return e;
                });
                return deliverEntries(entries);
            }

            // ── Cache miss: fetch from backend ───────────────────────────────
            console.log(`[Rclone] Fetching listing for ${currentRemote}${rclonePath}...`);
            const listRes = await self.rc('operations/list', {
                fs: currentRemote,
                remote: rclonePath,
                opt: {}
            });

            console.log("[Rclone] list result:", listRes);

            if (listRes && listRes.status && listRes.status !== 200) {
                 console.error("[Rclone] operations/list returned non-200 status:", listRes);
                 errorCallback(mapErrorToFsp(listRes));
                 return;
            }

            const entries = [];
            if (listRes && listRes.list) {
                const now = Date.now();
                console.log(`[Rclone] Received ${listRes.list.length} entries.`);
                for (const item of listRes.list) {
                    // Populate per-entry stat cache (L1 + L2)
                    const childEntryPath = options.directoryPath === '/' ? '/' + item.Name : options.directoryPath + '/' + item.Name;
                    cacheSet(currentRemote + childEntryPath, { item, timestamp: now });

                    const entry = {
                        isDirectory: !!item.IsDir,
                        name: item.Name
                    };
                    // Always provide size when requested; use 0 for directories (rclone returns -1)
                    if (options.size) entry.size = (item.Size >= 0) ? item.Size : 0;
                    if (options.modificationTime) entry.modificationTime = safeDate(item.ModTime);

                    entries.push(entry);
                }
                // Cache the full listing so re-opens of this folder are instant
                cacheSet(listingCacheKey, { items: listRes.list, timestamp: now });
            } else {
                console.warn("[Rclone] list result has no 'list' property.", listRes);
            }

            deliverEntries(entries);
        } catch (err) {
            console.error('[Rclone] list API Error:', err);
            errorCallback(mapErrorToFsp(err));
        }
    });

    chrome.fileSystemProvider.onCreateDirectoryRequested.addListener(async (options, successCallback, errorCallback) => {
        try {
            await configureRclone();
            const currentRemote = options.fileSystemId + ':';
            const rclonePath = options.directoryPath.substring(1);
            console.log('[Rclone] mkdir:', rclonePath);
            const mkRes = await self.rc('operations/mkdir', { fs: currentRemote, remote: rclonePath });
            console.log('[Rclone] mkdir result:', mkRes);
            // Inject synthetic stat so ChromeOS re-stat calls are served from cache
            // instead of hitting the backend (avoids the 3× stat round-trips after notify)
            const dirName = options.directoryPath.split('/').pop();
            cacheSet(currentRemote + options.directoryPath, {
                item: { IsDir: true, Name: dirName, Size: -1, ModTime: new Date().toISOString() },
                timestamp: Date.now()
            });
            // Only invalidate the parent stat + listing (new entry is already in cache above)
            const parentPath = getParentPath(options.directoryPath);
            const parentKey = currentRemote + parentPath;
            statCache.delete(parentKey);
            idbCacheDelete(parentKey);
            statCache.delete('__listing__:' + parentKey);
            idbCacheDelete('__listing__:' + parentKey);
            notifyChange(options.fileSystemId, parentPath, 'CHANGED', options.directoryPath);
            successCallback();
        } catch (err) {
            console.error('[Rclone] mkdir error:', err);
            errorCallback(mapErrorToFsp(err));
        }
    });

    chrome.fileSystemProvider.onDeleteEntryRequested.addListener(async (options, successCallback, errorCallback) => {
        try {
            await configureRclone();
            const currentRemote = options.fileSystemId + ':';
            const cacheKey = currentRemote + options.entryPath;
            const rclonePath = options.entryPath.substring(1);
            console.log('[Rclone] delete:', rclonePath, 'recursive:', options.recursive);

            // If it's a virtual file, just remove it from memory (no network request needed)
            if (typeof virtualFiles !== 'undefined' && virtualFiles.has(cacheKey)) {
                console.log('[Rclone] deleting virtual file (no-op network):', rclonePath);
                virtualFiles.delete(cacheKey);
                invalidateCache(currentRemote, options.entryPath);
                const parentPath = getParentPath(options.entryPath);
                notifyChange(options.fileSystemId, parentPath, 'CHANGED', options.entryPath);
                return successCallback();
            }

            // Always stat first to determine if it's a file or directory
            const statRes = await self.rc('operations/stat', { fs: currentRemote, remote: rclonePath });
            console.log('[Rclone] stat before delete:', statRes);

            if (!statRes || !statRes.item) {
                // Entry does not exist — treat as no-op success (e.g. copy-then-overwrite cleanup)
                console.warn('[Rclone] delete: entry not found, treating as no-op:', rclonePath);
                successCallback();
                return;
            }

            if (statRes.item.IsDir) {
                if (options.recursive) {
                    // Recursive directory delete
                    const delRes = await self.rc('operations/purge', { fs: currentRemote, remote: rclonePath });
                    console.log('[Rclone] purge result:', delRes);
                } else {
                    // Non-recursive directory delete (fails if not empty)
                    const delRes = await self.rc('operations/rmdir', { fs: currentRemote, remote: rclonePath });
                    console.log('[Rclone] rmdir result:', delRes);
                }
            } else {
                const delRes = await self.rc('operations/deletefile', { fs: currentRemote, remote: rclonePath });
                console.log('[Rclone] deletefile result:', delRes);
            }

            // Invalidate BEFORE notifying
            invalidateCache(currentRemote, options.entryPath);
            const parentPath = getParentPath(options.entryPath);
            notifyChange(options.fileSystemId, parentPath, 'CHANGED', options.entryPath);
            successCallback();
        } catch (err) {
            console.error('[Rclone] delete error:', err);
            errorCallback(mapErrorToFsp(err));
        }
    });

    chrome.fileSystemProvider.onMoveEntryRequested.addListener(async (options, successCallback, errorCallback) => {
        try {
            await configureRclone();
            const currentRemote = options.fileSystemId + ':';
            const srcPath = options.sourcePath.substring(1);
            const dstPath = options.targetPath.substring(1);
            
            console.log('[Rclone] move:', srcPath, '->', dstPath);
            const statRes = await self.rc('operations/stat', { fs: currentRemote, remote: srcPath });
            console.log('[Rclone] stat before move:', statRes);
            if (statRes && statRes.item && statRes.item.IsDir) {
                const moveRes = await self.rc('sync/move', { srcFs: currentRemote + srcPath, dstFs: currentRemote + dstPath });
                console.log('[Rclone] sync/move result:', moveRes);
            } else {
                const moveRes = await self.rc('operations/movefile', { srcFs: currentRemote, srcRemote: srcPath, dstFs: currentRemote, dstRemote: dstPath });
                console.log('[Rclone] movefile result:', moveRes);
            }
            // Invalidate source (entry is gone from there)
            invalidateCache(currentRemote, options.sourcePath);
            // Inject moved entry at target so ChromeOS re-stats are served from cache
            if (statRes && statRes.item) {
                const dstName = options.targetPath.split('/').pop();
                cacheSet(currentRemote + options.targetPath, {
                    item: { ...statRes.item, Name: dstName },
                    timestamp: Date.now()
                });
                // Invalidate only the target's parent stat + listing, not the entry itself
                const targetParentKey = currentRemote + getParentPath(options.targetPath);
                statCache.delete(targetParentKey);
                idbCacheDelete(targetParentKey);
                statCache.delete('__listing__:' + targetParentKey);
                idbCacheDelete('__listing__:' + targetParentKey);
            } else {
                invalidateCache(currentRemote, options.targetPath);
            }
            const srcParent = getParentPath(options.sourcePath);
            const dstParent = getParentPath(options.targetPath);
            notifyChange(options.fileSystemId, srcParent, 'CHANGED', options.sourcePath);
            if (dstParent !== srcParent) {
                notifyChange(options.fileSystemId, dstParent, 'CHANGED', options.targetPath);
            }
            successCallback();
        } catch (err) {
            console.error('[Rclone] move error:', err);
            errorCallback(mapErrorToFsp(err));
        }
    });

    if (chrome.fileSystemProvider.onCopyEntryRequested) {
        chrome.fileSystemProvider.onCopyEntryRequested.addListener(async (options, successCallback, errorCallback) => {
            try {
                await configureRclone();
                const currentRemote = options.fileSystemId + ':';
                const srcPath = options.sourcePath.substring(1);
                const dstPath = options.targetPath.substring(1);

                console.log('[Rclone] copy:', srcPath, '->', dstPath);
                const statRes = await self.rc('operations/stat', { fs: currentRemote, remote: srcPath });
                console.log('[Rclone] stat before copy:', statRes);

                if (statRes && statRes.item && statRes.item.IsDir) {
                    // For directories, use sync/copy
                    const copyRes = await self.rc('sync/copy', { srcFs: currentRemote + srcPath, dstFs: currentRemote + dstPath });
                    console.log('[Rclone] sync/copy result:', copyRes);
                } else {
                    // For files, use operations/copyfile
                    const copyRes = await self.rc('operations/copyfile', {
                        srcFs: currentRemote,
                        srcRemote: srcPath,
                        dstFs: currentRemote,
                        dstRemote: dstPath
                    });
                    console.log('[Rclone] copyfile result:', copyRes);
                }

                // Inject copied entry at target so ChromeOS re-stats are served from cache
                if (statRes && statRes.item) {
                    const dstName = options.targetPath.split('/').pop();
                    cacheSet(currentRemote + options.targetPath, {
                        item: { ...statRes.item, Name: dstName },
                        timestamp: Date.now()
                    });
                    // Invalidate only the target's parent stat + listing
                    const dstParentKey = currentRemote + getParentPath(options.targetPath);
                    statCache.delete(dstParentKey);
                    idbCacheDelete(dstParentKey);
                    statCache.delete('__listing__:' + dstParentKey);
                    idbCacheDelete('__listing__:' + dstParentKey);
                } else {
                    invalidateCache(currentRemote, options.targetPath);
                }
                const dstParent = getParentPath(options.targetPath);
                notifyChange(options.fileSystemId, dstParent, 'CHANGED', options.targetPath);
                successCallback();
            } catch (err) {
                console.error('[Rclone] copy error:', err);
                errorCallback(mapErrorToFsp(err));
            }
        });
    } else {
        console.warn('[Rclone] onCopyEntryRequested not available in this Chrome version. Copy will use fallback read/write path.');
    }

    const openFiles = new Map();
    const virtualFiles = new Map(); // tracks files created but not yet uploaded

    // ═══════════════════════════════════════════════════════════════════
    // DOWNLOAD PROGRESS NOTIFICATIONS
    // Reading a large file (open / copy out of the Files app) previously
    // gave no feedback at all — the user only saw an indeterminate spinner.
    // We track the highest byte offset delivered per open READ-mode file and
    // show a progress notification, updated in 10%-steps to avoid spam.
    // ═══════════════════════════════════════════════════════════════════

    const DOWNLOAD_NOTIFY_MIN_BYTES = 4 * 1024 * 1024; // only files >= 4 MB
    const DOWNLOAD_NOTIFY_STEP_PCT  = 10;              // update granularity

    function updateDownloadProgress(file, openRequestId, offset, deliveredBytes) {
        if (file.mode !== 'READ') return;
        if (!file.size || file.size < DOWNLOAD_NOTIFY_MIN_BYTES) return;

        const end = offset + deliveredBytes;
        if (end > (file.bytesReadEnd || 0)) file.bytesReadEnd = end;
        const pct = Math.min(100, Math.floor((file.bytesReadEnd / file.size) * 100));
        const fileName = file.path.split('/').pop();

        if (!file.notifId) {
            // openRequestId is unique per open file → stable id, no collisions
            // between concurrent downloads
            file.notifId = 'rclone-download-' + openRequestId;
            file.lastNotifiedPct = pct;
            chrome.notifications.create(file.notifId, {
                type: 'progress',
                iconUrl: 'assets/icon_128.png',
                title: msg('notif_download_title', fileName),
                message: msg('notif_download_prog', String(pct)),
                progress: pct
            });
            return;
        }

        // Update only every N percentage points (but always at 100%)
        if (pct === file.lastNotifiedPct) return;
        if (pct < 100 && pct - file.lastNotifiedPct < DOWNLOAD_NOTIFY_STEP_PCT) return;
        file.lastNotifiedPct = pct;

        chrome.notifications.update(file.notifId, {
            progress: pct,
            message: msg('notif_download_prog', String(pct))
        });

        if (pct >= 100) {
            // Fully delivered — clear shortly; onCloseFileRequested also clears
            const id = file.notifId;
            setTimeout(() => chrome.notifications.clear(id), 2500);
        }
    }

    function clearDownloadProgress(file) {
        if (file && file.notifId) {
            chrome.notifications.clear(file.notifId);
            file.notifId = null;
        }
    }

    // Files >= STREAM_THRESHOLD_BYTES use the streaming upload path (TransformStream → WASM)
    // Smaller files continue to use the in-memory buffer path for reliable random-access edits.
    const STREAM_THRESHOLD_BYTES = 4 * 1024 * 1024; // 4 MB

    chrome.fileSystemProvider.onCreateFileRequested.addListener(async (options, successCallback, errorCallback) => {
        try {
            await configureRclone();
            const currentRemote = options.fileSystemId + ':';
            const rclonePath = options.filePath.substring(1);
            console.log('[Rclone] createFile (virtual):', rclonePath);
            
            // Register as virtual file (lazy creation)
            const cacheKey = currentRemote + options.filePath;
            virtualFiles.set(cacheKey, { timestamp: Date.now() });

            // Invalidate BEFORE notifying
            invalidateCache(currentRemote, options.filePath);
            const parentPath = getParentPath(options.filePath);
            notifyChange(options.fileSystemId, parentPath, 'CHANGED', options.filePath);
            successCallback();
        } catch (err) {
            console.error('[Rclone] onCreateFileRequested error:', err);
            errorCallback('FAILED');
        }
    });

    chrome.fileSystemProvider.onOpenFileRequested.addListener(async (options, successCallback, errorCallback) => {
        console.log('[Rclone] onOpenFileRequested:', options.filePath, 'mode:', options.mode);
        
        try {
            await configureRclone();
        } catch (err) {
            return errorCallback('FAILED');
        }

        const currentRemote = options.fileSystemId + ':';
        const rclonePath = options.filePath.substring(1);
        const cacheKey = currentRemote + options.filePath;

        try {
            let fileSize = 0;
            let isVirtual = false;

            if (virtualFiles.has(cacheKey)) {
                isVirtual = true;
                console.log('[Rclone] Opening virtual file:', rclonePath);
            } else {
                const statRes = await self.rc('operations/stat', { fs: currentRemote, remote: rclonePath });
                if (!statRes || !statRes.item || statRes.item.IsDir) {
                    return errorCallback('NOT_FOUND');
                }
                fileSize = statRes.item.Size;
            }

            // ── WRITE mode ─────────────────────────────────────────────────────────
            if (options.mode === 'WRITE') {
                const useStreaming = isVirtual || fileSize >= STREAM_THRESHOLD_BYTES;

                if (useStreaming) {
                    // ── Streaming path (large / new files) ───────────────────────
                    // Create a TransformStream: JS writes chunks to the writable side;
                    // WASM reads them from the readable side via fileWriteStream().
                    const ts = new TransformStream();
                    const streamWriter = ts.writable.getWriter();

                    // Launch the upload in the background — it will block on each
                    // Read() call inside jsStreamReader until we enqueue chunks.
                    const uploadPromise = self.fileWriteStream(
                        currentRemote,
                        rclonePath,
                        ts.readable,
                        fileSize || 0
                    );

                    openFiles.set(options.requestId, {
                        remote: currentRemote,
                        path: rclonePath,
                        fsPath: options.filePath,
                        size: fileSize,
                        mode: 'WRITE',
                        buffer: null,          // no in-memory buffer for streaming
                        modified: false,
                        isVirtual: isVirtual,
                        // Streaming-specific fields:
                        useStreaming: true,
                        streamWriter: streamWriter,
                        uploadPromise: uploadPromise,
                        nextExpectedOffset: 0,
                        pendingChunks: new Map(), // offset → Uint8Array for out-of-order chunks
                    });
                    console.log('[Rclone] Opened file for streaming upload:', rclonePath);
                } else {
                    // ── Buffered path (small existing files) ─────────────────────
                    let fileBuffer = new Uint8Array(0);
                    if (!isVirtual && fileSize > 0) {
                        fileBuffer = await self.fileRead(currentRemote, rclonePath, 0, fileSize);
                    }
                    openFiles.set(options.requestId, {
                        remote: currentRemote,
                        path: rclonePath,
                        fsPath: options.filePath,
                        size: fileSize,
                        mode: 'WRITE',
                        buffer: fileBuffer,
                        modified: false,
                        isVirtual: isVirtual,
                        useStreaming: false,
                    });
                    console.log('[Rclone] Opened file for buffered upload:', rclonePath);
                }
            } else {
                // ── READ mode ──────────────────────────────────────────────────────
                openFiles.set(options.requestId, {
                    remote: currentRemote,
                    path: rclonePath,
                    fsPath: options.filePath,
                    size: fileSize,
                    mode: options.mode,
                    buffer: null,
                    modified: false,
                    isVirtual: isVirtual,
                    useStreaming: false,
                    // Download-progress tracking (see updateDownloadProgress)
                    bytesReadEnd: 0,
                    notifId: null,
                    lastNotifiedPct: -1,
                });
            }

            successCallback();
        } catch (err) {
            console.error('[Rclone] onOpenFileRequested error:', err);
            // fileRead() rejects with plain strings and bypasses the rc() wrapper
            if (isAuthError(err)) notifyAuthExpired(options.fileSystemId, err);
            errorCallback(mapErrorToFsp(err));
        }
    });

    chrome.fileSystemProvider.onReadFileRequested.addListener(async (options, successCallback, errorCallback) => {
        const { openRequestId, offset, length } = options;
        console.log(`[Rclone] onReadFileRequested: id=${openRequestId} offset=${offset} length=${length}`);

        const file = openFiles.get(openRequestId);
        if (!file) return errorCallback('INVALID_OPERATION');

        try {
            await configureRclone();

            // If offset is at or past EOF, return empty buffer — signals "done" to the Files app.
            // This prevents HTTP 416 errors from rclone when copying files via the read/write fallback.
            if (file.size !== undefined && offset >= file.size) {
                console.log(`[Rclone] onReadFileRequested: offset ${offset} >= fileSize ${file.size}, returning empty buffer (EOF).`);
                // Reading past EOF means the sequential download is complete
                updateDownloadProgress(file, openRequestId, file.size, 0);
                successCallback(new ArrayBuffer(0), false);
                return;
            }

            if (file.buffer && file.modified) {
                // Return from un-flushed memory buffer
                const chunk = file.buffer.slice(offset, offset + length);
                successCallback(chunk.buffer, false);
            } else {
                // Return from remote
                const currentRemote = options.fileSystemId + ':';
                console.log(`[Rclone] Calling fileRead: ${currentRemote}${file.path} offset=${offset} length=${length}`);
                const uint8 = await self.fileRead(currentRemote, file.path, offset, length);
                const buffer = uint8.buffer.slice(uint8.byteOffset, uint8.byteOffset + uint8.byteLength);
                console.log(`[Rclone] fileRead returned ${buffer.byteLength} bytes.`);
                updateDownloadProgress(file, openRequestId, offset, buffer.byteLength);
                successCallback(buffer, false);
            }
        } catch (err) {
            console.error('[Rclone] onReadFileRequested error:', err);
            if (isAuthError(err)) notifyAuthExpired(options.fileSystemId, err);
            errorCallback(mapErrorToFsp(err, 'IO'));
        }
    });

    chrome.fileSystemProvider.onWriteFileRequested.addListener(async (options, successCallback, errorCallback) => {
        console.log(`[Rclone] onWriteFileRequested: id=${options.openRequestId} offset=${options.offset} length=${options.data.byteLength}`);
        const file = openFiles.get(options.openRequestId);
        if (!file || file.mode !== 'WRITE') return errorCallback('INVALID_OPERATION');

        try {
            const incoming = new Uint8Array(options.data);

            if (file.useStreaming) {
                // ── Streaming path ────────────────────────────────────────────────
                // The FSP may deliver chunks in any order.  We buffer out-of-order
                // chunks in pendingChunks and flush them in sequence so the stream
                // (and rclone on the other end) always sees bytes in order.
                file.pendingChunks.set(options.offset, incoming);

                // Flush all consecutive chunks starting from nextExpectedOffset
                let flushMore = true;
                while (flushMore) {
                    const chunk = file.pendingChunks.get(file.nextExpectedOffset);
                    if (chunk === undefined) {
                        flushMore = false;
                    } else {
                        file.pendingChunks.delete(file.nextExpectedOffset);
                        await file.streamWriter.write(chunk);
                        file.nextExpectedOffset += chunk.byteLength;
                        // Update tracked size
                        if (file.nextExpectedOffset > file.size) {
                            file.size = file.nextExpectedOffset;
                        }
                    }
                }

                file.modified = true;
                successCallback();
            } else {
                // ── Buffered path ─────────────────────────────────────────────────
                const reqEnd = options.offset + incoming.byteLength;

                // Expand buffer if needed
                let currentBuf = file.buffer || new Uint8Array(0);
                if (reqEnd > currentBuf.byteLength) {
                    const newBuf = new Uint8Array(reqEnd);
                    newBuf.set(currentBuf);
                    currentBuf = newBuf;
                }

                // Write chunk into buffer
                currentBuf.set(incoming, options.offset);

                file.buffer = currentBuf;
                file.modified = true;
                file.size = currentBuf.byteLength;

                successCallback();
            }
        } catch (err) {
            console.error('[Rclone] write error:', err);
            errorCallback(mapErrorToFsp(err, 'IO'));
        }
    });

    chrome.fileSystemProvider.onTruncateRequested.addListener((options, successCallback, errorCallback) => {
        const file = openFiles.get(options.openRequestId);
        if (!file || file.mode !== 'WRITE') return errorCallback('INVALID_OPERATION');

        if (file.useStreaming) {
            // For streaming files we have no in-memory buffer.
            // The FSP often calls truncate(0) before starting to write a new file —
            // we just update the size hint and succeed; the stream starts fresh anyway.
            file.size = options.length;
            file.modified = true;
            return successCallback();
        }

        // ── Buffered path ─────────────────────────────────────────────────────
        const currentBuf = file.buffer || new Uint8Array(0);
        if (options.length === currentBuf.byteLength) {
            return successCallback();
        }

        const newBuf = new Uint8Array(options.length);
        if (options.length > currentBuf.byteLength) {
            newBuf.set(currentBuf); // pad with 0s
        } else {
            newBuf.set(currentBuf.slice(0, options.length)); // truncate
        }

        file.buffer = newBuf;
        file.modified = true;
        file.size = options.length;
        successCallback();
    });

    chrome.fileSystemProvider.onCloseFileRequested.addListener(async (options, successCallback, errorCallback) => {
        console.log('[Rclone] onCloseFileRequested:', options.openRequestId);
        const file = openFiles.get(options.openRequestId);
        
        if (file) {
            if (file.mode === 'WRITE' && (file.modified || file.isVirtual)) {
                const notifId = 'rclone-upload-' + Date.now();
                const fileName = file.path.split('/').pop();

                // Keep the Service Worker alive during potentially long uploads.
                // Claimed before the try so it is strictly paired with the
                // stopKeepAlive() in the finally: if configureRclone() below throws,
                // the finally still runs, and an unpaired stop would decrement the
                // refcount on behalf of a concurrent upload and clear its alarm.
                startKeepAlive();

                try {
                    await configureRclone();

                    if (file.useStreaming) {
                        // ── Streaming close ──────────────────────────────────────
                        // Show progress notification for streaming uploads
                        chrome.notifications.create(notifId, {
                            type: 'progress',
                            iconUrl: 'assets/icon_128.png',
                            title: msg('notif_stream_title', fileName),
                            message: msg('notif_stream_init'),
                            progress: 10
                        });

                        console.log(`[Rclone] Closing stream for ${file.remote}${file.path} (${file.size} bytes written)`);

                        // Flush any remaining out-of-order chunks before closing.
                        // The chunks must form a contiguous range starting at
                        // nextExpectedOffset — if there is a gap, concatenating
                        // them would silently corrupt the file, so abort instead.
                        if (file.pendingChunks && file.pendingChunks.size > 0) {
                            console.warn(`[Rclone] ${file.pendingChunks.size} out-of-order chunks remain on close — flushing in offset order`);
                            const sortedOffsets = [...file.pendingChunks.keys()].sort((a, b) => a - b);
                            let expectedOffset = file.nextExpectedOffset;
                            for (const offset of sortedOffsets) {
                                if (offset !== expectedOffset) {
                                    throw new Error(`Upload aborted: missing data between byte ${expectedOffset} and byte ${offset} — refusing to write a corrupt file`);
                                }
                                const chunk = file.pendingChunks.get(offset);
                                await file.streamWriter.write(chunk);
                                expectedOffset += chunk.byteLength;
                            }
                            file.nextExpectedOffset = expectedOffset;
                            file.pendingChunks.clear();
                        }

                        chrome.notifications.update(notifId, {
                            progress: 30,
                            message: msg('notif_stream_init') + ' (flushing...)',
                        });

                        // Close the writable side → signals EOF to Go's io.Reader
                        await file.streamWriter.close();

                        chrome.notifications.update(notifId, {
                            progress: 50,
                            message: msg('notif_stream_init') + ' (uploading...)',
                        });

                        // Wait for the WASM upload to complete
                        await file.uploadPromise;

                        chrome.notifications.update(notifId, {
                            type: 'basic',
                            title: msg('notif_stream_ok_title'),
                            message: msg('notif_stream_ok_msg', fileName)
                        });
                        setTimeout(() => chrome.notifications.clear(notifId), 3000);

                    } else {
                        // ── Buffered close ───────────────────────────────────────
                        const showProgress = file.buffer && file.buffer.byteLength > 100 * 1024;

                        console.log(`[Rclone] Uploading buffered file to ${file.remote}${file.path} (${file.buffer ? file.buffer.byteLength : 0} bytes)`);

                        if (showProgress) {
                            chrome.notifications.create(notifId, {
                                type: 'progress',
                                iconUrl: 'assets/icon_128.png',
                                title: msg('notif_upload_title', fileName),
                                message: msg('notif_upload_init'),
                                progress: 0
                            });
                        }

                        const progressCb = (uploaded, total) => {
                            if (showProgress) {
                                const pct = total > 0 ? Math.round((uploaded / total) * 100) : 0;
                                chrome.notifications.update(notifId, {
                                    progress: pct,
                                    message: msg('notif_upload_prog', String(pct))
                                });
                            }
                        };

                        await self.fileWrite(file.remote, file.path, file.buffer, progressCb);

                        if (showProgress) {
                            chrome.notifications.update(notifId, {
                                type: 'basic',
                                title: msg('notif_upload_ok_title'),
                                message: msg('notif_upload_ok_msg', fileName),
                                progress: 100
                            });
                            setTimeout(() => chrome.notifications.clear(notifId), 3000);
                        }
                    }

                    const fileFsPath = file.fsPath || '/' + file.path;

                    if (file.isVirtual) {
                        virtualFiles.delete(file.remote + fileFsPath);
                    }

                    invalidateCache(file.remote, fileFsPath);
                    const parentPath = getParentPath(fileFsPath);
                    const fileSystemId = file.remote.slice(0, -1);
                    notifyChange(fileSystemId, parentPath, 'CHANGED', fileFsPath);

                } catch (err) {
                    console.error('[Rclone] Fatal upload error on close:', err);

                    // fileWrite/fileWriteStream reject with plain strings and
                    // bypass the rc() wrapper — detect dead tokens here too
                    if (isAuthError(err)) notifyAuthExpired(file.remote.slice(0, -1), err);

                    // Abort the stream if streaming upload failed
                    if (file.useStreaming && file.streamWriter) {
                        try {
                            await file.streamWriter.abort(err);
                        } catch (_) { /* ignore secondary abort errors */ }
                    }

                    // create() replaces an existing notification with the same id
                    // and — unlike update() — also works when the buffered path
                    // never showed a progress notification (small files).
                    chrome.notifications.create(notifId, {
                        type: 'basic',
                        iconUrl: 'assets/icon_128.png',
                        title: msg('notif_upload_fail'),
                        message: String(err)
                    });
                    setTimeout(() => chrome.notifications.clear(notifId), 8000);

                    openFiles.delete(options.openRequestId);
                    return errorCallback(mapErrorToFsp(err));
                } finally {
                    // Always stop the keep-alive when the upload finishes (success or error)
                    stopKeepAlive();
                }
            } else if (file.mode === 'WRITE' && file.useStreaming && file.streamWriter) {
                // Opened for a streaming write, but nothing was ever written and the
                // file isn't virtual — the user opened the handle and closed it again.
                // onOpenFileRequested already launched fileWriteStream(), so Go is
                // parked inside Rcat blocked on a Read() that will never be satisfied.
                // Without this branch the goroutine (and its WASM heap) leaks for the
                // rest of the Service Worker's life, once per such open.
                //
                // abort(), NOT close(): closing would end the stream cleanly at zero
                // bytes, and Rcat would happily write an empty file over the user's
                // existing one. Aborting errors the readable side so Rcat fails and
                // writes nothing.
                console.log('[Rclone] Discarding unwritten streaming handle:', file.path);
                try {
                    await file.streamWriter.abort(new Error('closed without write'));
                } catch (_) { /* already errored or closed — nothing to unwind */ }
                // The abort necessarily rejects uploadPromise. Nobody awaits it on this
                // path, so consume it here or it surfaces as an unhandled rejection.
                if (file.uploadPromise) file.uploadPromise.catch(() => {});
            }
            // Remove a still-visible download-progress notification (READ mode)
            clearDownloadProgress(file);
            openFiles.delete(options.openRequestId);
            successCallback();
        } else {
            errorCallback('INVALID_OPERATION');
        }
    });

    // ═══════════════════════════════════════════════════════════════════
    // CONTEXT MENU ACTIONS (Rechtsklick-Menü in der ChromeOS Files App)
    // ═══════════════════════════════════════════════════════════════════

    // Action IDs — stable identifiers the Files app round-trips back to us
    const ACTION_COPY_LINK     = 'rclone_copy_link';
    const ACTION_COPY_PATH     = 'rclone_copy_path';
    const ACTION_FILE_INFO     = 'rclone_file_info';
    const ACTION_CACHE_REFRESH = 'rclone_cache_refresh';

    /**
     * Returns the list of custom actions to show in the context menu.
     * Called every time the user right-clicks a file/folder on our volume.
     */
    chrome.fileSystemProvider.onGetActionsRequested.addListener((options, successCallback, errorCallback) => {
        console.log('[Rclone] onGetActionsRequested:', options.entryPaths);

        // Determine if any of the selected paths is a directory
        // (we optimistically check the L1 cache; if unknown we show all actions)
        const currentRemote = options.fileSystemId + ':';
        const anyDir = options.entryPaths.some(p => {
            const cached = statCache.get(currentRemote + p);
            return cached && cached.item && cached.item.IsDir;
        });
        const allDirs = options.entryPaths.every(p => {
            const cached = statCache.get(currentRemote + p);
            return cached && cached.item && cached.item.IsDir;
        });

        const actions = [];

        // 🔗 Public link — skip for directories (most backends don't support it)
        if (!anyDir || options.entryPaths.length === 1) {
            actions.push({ id: ACTION_COPY_LINK, title: msg('action_copy_link') });
        }

        // 📋 Rclone path — always useful
        actions.push({ id: ACTION_COPY_PATH, title: msg('action_copy_path') });

        // ℹ️ File info — for single selections only (stat is per-file)
        if (options.entryPaths.length === 1) {
            actions.push({ id: ACTION_FILE_INFO, title: msg('action_file_info') });
        }

        // 🔄 Cache invalidation — always available
        actions.push({ id: ACTION_CACHE_REFRESH, title: msg('action_cache_refresh') });

        successCallback(actions);
    });

    /**
     * Executes one of our custom context-menu actions.
     */
    chrome.fileSystemProvider.onExecuteActionRequested.addListener(async (options, successCallback, errorCallback) => {
        console.log('[Rclone] onExecuteActionRequested:', options.actionId, options.entryPaths);

        try {
            await configureRclone();
        } catch (err) {
            console.error('[Rclone] Config error in action handler:', err);
            return errorCallback('FAILED');
        }

        const currentRemote = options.fileSystemId + ':';

        // Helper: show a notification and optionally store a value for the options page
        function showActionNotif(notifId, title, message, buttons) {
            const opts = {
                type: 'basic',
                iconUrl: 'assets/icon_128.png',
                title,
                message,
                requireInteraction: true,
            };
            if (buttons && buttons.length) opts.buttons = buttons;
            chrome.notifications.create(notifId, opts);
        }

        switch (options.actionId) {

            // ── 🔗 Link kopieren ────────────────────────────────────────────────
            case ACTION_COPY_LINK: {
                const entryPath = options.entryPaths[0];
                const rclonePath = entryPath.substring(1);
                const fileName = entryPath.split('/').pop() || entryPath;
                const notifId = 'rclone-link-' + Date.now();

                try {
                    console.log(`[Rclone] Generating public link for: ${currentRemote}${rclonePath}`);
                    const linkRes = await self.rc('operations/publiclink', {
                        fs: currentRemote,
                        remote: rclonePath,
                        expire: '7d',
                        unlink: false,
                    });

                    const url = linkRes && (linkRes.url || linkRes.URL);
                    if (!url) {
                        throw new Error(msg('notif_link_no_url'));
                    }

                    console.log(`[Rclone] Public link: ${url}`);

                    chrome.storage.local.set({ lastGeneratedLink: { url, path: rclonePath, ts: Date.now() } });

                    showActionNotif(notifId,
                        msg('notif_link_title', fileName),
                        url,
                        [{ title: msg('notif_btn_browser') }]
                    );

                    // Handle button click: open in browser tab
                    const notifClickHandler = (id, btnIdx) => {
                        if (id !== notifId) return;
                        chrome.tabs.create({ url });
                        chrome.notifications.clear(notifId);
                        chrome.notifications.onButtonClicked.removeListener(notifClickHandler);
                    };
                    chrome.notifications.onButtonClicked.addListener(notifClickHandler);
                    // Auto-clear after 60 s
                    setTimeout(() => {
                        chrome.notifications.clear(notifId);
                        chrome.notifications.onButtonClicked.removeListener(notifClickHandler);
                    }, 60000);

                } catch (err) {
                    console.error('[Rclone] publiclink error:', err);
                    showActionNotif(notifId,
                        msg('notif_link_fail'),
                        err.toString(),
                        []
                    );
                    setTimeout(() => chrome.notifications.clear(notifId), 8000);
                }

                successCallback();
                break;
            }

            // ── 📋 Pfad kopieren ────────────────────────────────────────────────
            case ACTION_COPY_PATH: {
                const paths = options.entryPaths.map(p => {
                    const rclonePath = p.substring(1);
                    return currentRemote + rclonePath;
                });
                const text = paths.join('\n');
                const notifId = 'rclone-path-' + Date.now();

                // Store so the options page can offer clipboard copy
                chrome.storage.local.set({ lastCopiedPath: { text, ts: Date.now() } });

                showActionNotif(notifId,
                    msg('notif_path_title'),
                    text,
                    [{ title: msg('btn_open_browser') }]
                );

                // Button: open options page where the user can copy the path
                const clickHandler = (id, btnIdx) => {
                    if (id !== notifId) return;
                    chrome.runtime.openOptionsPage();
                    chrome.notifications.clear(notifId);
                    chrome.notifications.onButtonClicked.removeListener(clickHandler);
                };
                chrome.notifications.onButtonClicked.addListener(clickHandler);
                setTimeout(() => {
                    chrome.notifications.clear(notifId);
                    chrome.notifications.onButtonClicked.removeListener(clickHandler);
                }, 30000);

                successCallback();
                break;
            }

            // ── ℹ️ Datei-Details ────────────────────────────────────────────────
            case ACTION_FILE_INFO: {
                const entryPath = options.entryPaths[0];
                const rclonePath = entryPath.substring(1);
                const notifId = 'rclone-info-' + Date.now();

                try {
                    const statRes = await self.rc('operations/stat', { fs: currentRemote, remote: rclonePath });
                    if (!statRes || !statRes.item) {
                        throw new Error(msg('notif_info_no_data'));
                    }
                    const item = statRes.item;

                    // Format size
                    function fmtSize(bytes) {
                        if (bytes < 0) return '—';
                        if (bytes === 0) return '0 B';
                        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
                        const i = Math.floor(Math.log(bytes) / Math.log(1024));
                        return (bytes / Math.pow(1024, i)).toFixed(2) + ' ' + units[i];
                    }

                    const modTime = item.ModTime ? new Date(item.ModTime).toLocaleString() : '—';
                    const size    = item.IsDir ? msg('info_size_dir') : fmtSize(item.Size);
                    const mime    = item.MimeType || '—';

                    const message = [
                        msg('info_name', item.Name),
                        msg('info_type', item.IsDir ? msg('info_type_folder') : msg('info_type_file')),
                        msg('info_size', size),
                        msg('info_modified', modTime),
                        msg('info_mime', mime),
                    ].join('\n');

                    showActionNotif(notifId, msg('notif_info_title', item.Name), message, []);
                    setTimeout(() => chrome.notifications.clear(notifId), 20000);

                } catch (err) {
                    console.error('[Rclone] file info error:', err);
                    showActionNotif(notifId, msg('notif_info_fail'), err.toString(), []);
                    setTimeout(() => chrome.notifications.clear(notifId), 8000);
                }

                successCallback();
                break;
            }

            // ── 🔄 Cache leeren ─────────────────────────────────────────────────
            case ACTION_CACHE_REFRESH: {
                let count = 0;
                for (const entryPath of options.entryPaths) {
                    invalidateCache(currentRemote, entryPath);
                    // Also invalidate the directory itself so a re-listing is forced
                    const parentPath = getParentPath(entryPath);
                    invalidateCache(currentRemote, parentPath);
                    count++;
                }
                console.log(`[Rclone] Cache invalidated for ${count} path(s) on ${currentRemote}`);

                const notifId = 'rclone-refresh-' + Date.now();
                chrome.notifications.create(notifId, {
                    type: 'basic',
                    iconUrl: 'assets/icon_128.png',
                    title: msg('notif_cache_title'),
                    message: msg('notif_cache_msg', String(count)),
                });
                setTimeout(() => chrome.notifications.clear(notifId), 4000);

                successCallback();
                break;
            }

            default:
                console.warn('[Rclone] Unknown action:', options.actionId);
                errorCallback('INVALID_OPERATION');
        }
    });

    chrome.fileSystemProvider.onAddWatcherRequested.addListener((options, successCallback, errorCallback) => {
        console.log('[Rclone] onAddWatcherRequested:', options.entryPath, 'recursive:', options.recursive);
        // Stub implementation: always succeed
        successCallback();
    });

    chrome.fileSystemProvider.onRemoveWatcherRequested.addListener((options, successCallback, errorCallback) => {
        console.log('[Rclone] onRemoveWatcherRequested:', options.entryPath);
        // Stub implementation: always succeed
        successCallback();
    });

} else {
    console.log('[Rclone] FileSystemProvider API NOT available. (Are you on ChromeOS?)');
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    console.log('[Rclone] Received message:', request);
    
    if (request.action === 'testConnection') {
        (async () => {
            try {
                // Wait for WASM to be ready
                await self.rcValid;
                
                const parsedConf = parseIniConfig(request.config);
                const remotes = Object.keys(parsedConf);
                
                if (remotes.length === 0) {
                    sendResponse({ success: false, error: 'No remotes found in provided config.' });
                    return;
                }
                
                // Pick the first remote to test
                const testRemote = remotes[0];
                const remoteConfig = parsedConf[testRemote];
                
                console.log(`[Rclone] Testing connection for remote: ${testRemote}`);
                
                // Sanitize token JSON if present
                if (remoteConfig.token) {
                    remoteConfig.token = sanitizeTokenValue(remoteConfig.token);
                }
                
                // Inject config into WASM
                const injectRes = self.configInject(testRemote, remoteConfig);
                if (injectRes && injectRes.error) {
                    sendResponse({ success: false, error: `Config inject failed: ${injectRes.error}` });
                    return;
                }
                
                // Test by listing root
                const listRes = await self.rc('operations/list', {
                    fs: testRemote + ':',
                    remote: '',
                    opt: {}
                });
                
                console.log('[Rclone] Test connection list result:', listRes);
                
                sendResponse({ success: true, remotes: remotes });
            } catch (err) {
                console.error('[Rclone] Test connection error:', err);
                sendResponse({ success: false, error: err.toString() });
            }
        })();
        
        return true; // Keep channel open
    }

    if (request.action === 'getDashboardData') {
        (async () => {
            try {
                await self.rcValid;
                
                chrome.storage.local.get(['mountedFileSystems', 'remoteStatus', 'rcloneConf'], async (result) => {
                    const mounts = result.mountedFileSystems || [];
                    const statusObj = result.remoteStatus || {};
                    const parsedConf = parseIniConfig(result.rcloneConf || '');
                    
                    const dashboardData = [];
                    
                    for (const mount of mounts) {
                        const remoteName = mount.id;
                        const config = parsedConf[remoteName];
                        
                        let quotaInfo = null;
                        if (config && config.type) {
                            try {
                                const aboutRes = await self.rc('operations/about', { fs: remoteName + ':' });
                                console.log(`[Rclone] operations/about for ${remoteName}:`, JSON.stringify(aboutRes));
                                quotaInfo = aboutRes;
                            } catch (e) {
                                console.warn(`[Rclone] operations/about failed for ${remoteName}:`, e);
                            }
                        }
                        
                        let activeUploads = 0;
                        if (typeof openFiles !== 'undefined') {
                            openFiles.forEach((file, requestId) => {
                                if (file.remote === remoteName + ':' && file.mode === 'WRITE' && file.modified) {
                                    activeUploads++;
                                }
                            });
                        }
                        
                        dashboardData.push({
                            name: remoteName,
                            type: config ? config.type : 'unknown',
                            status: statusObj[remoteName] ? statusObj[remoteName].status : 'unknown',
                            quota: quotaInfo,
                            activeUploads: activeUploads
                        });
                    }
                    
                    sendResponse({ success: true, data: dashboardData });
                });
            } catch (err) {
                console.error('[Rclone] getDashboardData error:', err);
                sendResponse({ success: false, error: err.toString() });
            }
        })();
        
        return true; // Keep channel open
    }
});

// Background Connection Test
chrome.runtime.onInstalled.addListener((details) => {
    console.log('[Rclone] Creating background alarm...');
    // 15 min (previously 5): every firing wakes the Service Worker and
    // re-injects the entire config — for a pure health indicator on the
    // dashboard, waking 12×/h was needlessly battery-hungry.
    chrome.alarms.create('checkRemotes', { periodInMinutes: 15 });

    // Open the settings page once, on a genuinely fresh install. Until now
    // nothing visible happened after "Add to Chrome": there is no toolbar
    // button, so the settings page is reachable only through the puzzle-piece
    // overflow menu — and a new user has no reason to look there.
    //
    // The 'install'-only gate lives in config-utils.js (shouldOpenSetupPage)
    // so it can be unit tested; see the note there on why a browser harness
    // cannot exercise the 'update' path.
    //
    // No deep link is needed: with no remotes configured the options page
    // already opens on Guided Setup — see chooseLandingTab() in options.js.
    if (shouldOpenSetupPage(details)) {
        chrome.runtime.openOptionsPage();
    }
});

// Auto-mount new remotes when rcloneConf changes (e.g. after wizard/advanced save).
// Already-mounted remotes get "Already mounted" which is silently ignored.
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.rcloneConf) return;
    console.log('[Rclone] Config changed — re-injecting and checking for new remotes to mount...');
    self.rcValid.then(() => {
        // force: the stored config just changed, so the memoised injection is
        // stale by definition. Without this the call short-circuits, the core
        // keeps serving the old config, and the loop below iterates a stale
        // remote list — so a newly added remote is neither injected nor mounted
        // until the worker restarts or the 15 min health check re-injects it.
        configureRclone(true).then(remotes => {
            remotes.forEach(remoteName => {
                chrome.fileSystemProvider.mount({
                    fileSystemId: remoteName,
                    displayName: `OmniFiles (${remoteName})`,
                    writable: true
                }, () => {
                    if (chrome.runtime.lastError) {
                        const msg = chrome.runtime.lastError.message;
                        if (!msg.includes('Already mounted')) {
                            console.error(`[Rclone] Auto-mount failed for ${remoteName}:`, msg);
                        }
                    } else {
                        console.log(`[Rclone] Auto-mounted new remote: ${remoteName}`);
                        updateMountedFileSystems((mounts) => {
                            if (!mounts.find(m => m.id === remoteName)) {
                                mounts.push({ id: remoteName, name: `OmniFiles (${remoteName})`, remote: remoteName + ':' });
                            }
                            return mounts;
                        });
                    }
                });
            });
        }).catch(err => console.error('[Rclone] Auto-mount configureRclone failed:', err));
    });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === 'checkRemotes') {
        console.log('[Rclone] Running periodic remote check...');
        await checkAllRemotes();
    } else if (alarm.name === KEEPALIVE_ALARM) {
        // No-op: receiving this alarm event is enough to keep the
        // Service Worker alive during a long-running upload.
        console.log('[Rclone] Keep-alive alarm fired (upload in progress)');
    }
});

async function checkAllRemotes() {
    try {
        await self.rcValid;
        
        chrome.storage.local.get(['rcloneConf', 'remoteStatus'], async (result) => {
            if (!result.rcloneConf) return;
            
            const parsedConf = parseIniConfig(result.rcloneConf);
            // Mirror what's about to be re-injected (see onConfigChanged definition above) —
            // keeps the periodic re-check from flooding chrome.storage with no-op writes.
            liveConfigCache = parsedConf;
            const remotes = Object.keys(parsedConf);
            const statusObj = result.remoteStatus || {};

            for (const remote of remotes) {
                const config = parsedConf[remote];
                if (!config.type) continue;
                
                try {
                    if (config.token) {
                        config.token = sanitizeTokenValue(config.token);
                    }
                    self.configInject(remote, config);
                    
                    // Test connection by listing root with limit 1
                    await self.rc('operations/list', {
                        fs: remote + ':',
                        remote: '',
                        opt: { limit: 1 }
                    });
                    
                    statusObj[remote] = {
                        status: 'online',
                        timestamp: Date.now()
                    };
                    // Remote works again — clear a possibly stale re-auth notification
                    clearAuthExpired(remote);
                } catch (e) {
                    console.warn(`[Rclone] Check failed for ${remote}:`, e);
                    statusObj[remote] = {
                        // auth_expired = refresh token dead, user must re-authorize;
                        // the notification itself is fired by the wrapped self.rc()
                        status: isAuthError(e) ? 'auth_expired' : 'offline',
                        error: e.toString(),
                        timestamp: Date.now()
                    };
                }
            }
            
            chrome.storage.local.set({ remoteStatus: statusObj });
        });
    } catch (err) {
        console.error('[Rclone] checkAllRemotes error:', err);
    }
}
