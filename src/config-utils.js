// OmniFiles - ChromeOS Rclone Integration
// Copyright (c) 2026 Markus Litz
// Licensed under the MIT License. See LICENSE file in the project root for details.

// config-utils.js
// Pure helper functions shared between the Service Worker (via importScripts)
// and the Node.js unit tests (via require). No Chrome APIs in here.

// Helper to parse INI config strings into objects
function parseIniConfig(iniString) {
    const config = {};
    let currentSection = null;

    const lines = iniString.split('\n');
    for (let line of lines) {
        line = line.trim();
        if (!line || line.startsWith('#') || line.startsWith(';')) continue;

        if (line.startsWith('[') && line.endsWith(']')) {
            currentSection = line.substring(1, line.length - 1).trim();
            config[currentSection] = {};
        } else if (currentSection && line.includes('=')) {
            const separatorIndex = line.indexOf('=');
            const key = line.substring(0, separatorIndex).trim();
            const value = line.substring(separatorIndex + 1).trim();
            config[currentSection][key] = value;
        }
    }
    return config;
}

// Helper to serialize objects into INI config strings
function serializeIniConfig(obj) {
    let text = '';
    for (const [section, keys] of Object.entries(obj)) {
        text += `[${section}]\n`;
        for (const [key, value] of Object.entries(keys)) {
            text += `${key} = ${value}\n`;
        }
        text += '\n';
    }
    return text;
}

// Sanitize OAuth token JSON - fixes corrupted expiry timestamps
// that get mangled during copy-paste through textarea (colons → spaces)
function sanitizeTokenValue(tokenStr) {
    try {
        const token = JSON.parse(tokenStr);
        if (token.expiry) {
            // Fix timestamps where colons got replaced with spaces
            // e.g. "2026-04-13T18  :47:21" → "2026-04-13T18:47:21"
            token.expiry = token.expiry.replace(/(\d)  :/g, '$1:');
            // Also fix single space corruption
            token.expiry = token.expiry.replace(/(\d) :/g, '$1:');
        }
        return JSON.stringify(token);
    } catch (e) {
        console.warn('[Rclone] Could not parse token JSON for sanitization, using as-is:', e);
        return tokenStr;
    }
}

function getParentPath(path) {
    if (!path || path === '/') return '/';
    const parts = path.split('/');
    parts.pop();
    const p = parts.join('/');
    return p || '/';
}

// ── FSP error code mapping ──────────────────────────────────────────────
// Translates errors from the WASM bridge into precise fileSystemProvider
// ProviderError codes so the Files app can show meaningful messages instead
// of a generic failure. The rc() bridge rejects with { status, error, ... }
// objects, the file bridges (fileRead/fileWrite/fileWriteStream) reject with
// plain strings, and local code may throw Error instances.
function mapErrorToFsp(err, fallback = 'FAILED') {
    let status = 0;
    let text = '';
    if (err && typeof err === 'object') {
        if (typeof err.status === 'number') status = err.status;
        text = String(err.error || err.message || '');
    } else {
        text = String(err ?? '');
    }
    const t = text.toLowerCase();

    if (status === 404 || t.includes('not found') || t.includes('no such ') || t.includes("doesn't exist")) return 'NOT_FOUND';
    // Quota before 403: Google Drive reports "quota exceeded" as HTTP 403,
    // but for the user this is a storage problem, not a permission problem.
    if (status === 507 || t.includes('quota') || t.includes('insufficient storage') || t.includes('no space')) return 'NO_SPACE';
    if (status === 401 || status === 403 || t.includes('permission denied') || t.includes('access denied') ||
        t.includes('forbidden') || t.includes('unauthorized')) return 'ACCESS_DENIED';
    if (status === 409 || t.includes('already exists')) return 'EXISTS';
    if (t.includes('not empty')) return 'NOT_EMPTY';
    if (t.includes('not a directory')) return 'NOT_A_DIRECTORY';
    if (t.includes('is a directory')) return 'NOT_A_FILE';
    if (status === 400) return 'INVALID_OPERATION';
    if (t.includes('timeout') || t.includes('timed out') || t.includes('network') ||
        t.includes('connection') || t.includes('fetch')) return 'IO';
    return fallback;
}

// Detects OAuth/authentication failures that a retry cannot fix — typically an
// expired or revoked *refresh* token (e.g. Google's "invalid_grant"). Access
// tokens are refreshed automatically by rclone via the refresh_token; this
// helper identifies the cases where that refresh itself failed permanently and
// the user must re-authorize (paste a fresh token via the options page).
function isAuthError(err) {
    let status = 0;
    let text = '';
    if (err && typeof err === 'object') {
        if (typeof err.status === 'number') status = err.status;
        text = String(err.error || err.message || '');
    } else {
        text = String(err ?? '');
    }
    const t = text.toLowerCase();
    return status === 401 ||
        t.includes('invalid_grant') ||
        t.includes('invalid_client') ||
        t.includes("couldn't fetch token") ||
        t.includes('failed to refresh token') ||
        t.includes('token has been expired or revoked') ||
        t.includes('token expired') ||
        t.includes('oauth2: cannot fetch token') ||
        t.includes('unauthorized');
}

/**
 * Escapes text destined for an innerHTML template.
 *
 * Remote names and their `type` values come straight from the stored
 * rclone.conf — an INI file the user can also *import* from disk — so the
 * content is not necessarily theirs. A section named e.g.
 * `[<img src=x onerror=...>]` would otherwise be parsed as markup by the
 * options-page renderers that build dashboard cards and remote-list rows
 * from template literals.
 *
 * The extension-page CSP (script-src 'self') blocks inline handlers, so this
 * is not code execution — but unescaped markup can still break or deface the
 * options UI, and the CSP should not be the only thing standing between
 * config data and the DOM.
 *
 * @param {*} value Any value; coerced to string (null/undefined → '').
 * @returns {string} The value with HTML-significant characters escaped.
 */
function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Whether a chrome.runtime.onInstalled event should open the settings page.
 *
 * True only for a genuinely fresh install. The extension auto-updates from the
 * Web Store, so reacting to 'update' — or to 'chrome_update' /
 * 'shared_module_update', which fire for reasons that have nothing to do with
 * this extension being added — would spawn a tab in front of users who did not
 * ask for one. That is user-hostile and a Web Store review risk.
 *
 * Extracted here rather than inlined in the listener so the gate is unit
 * testable: an unpacked extension loaded with --load-extension reports
 * reason 'install' on every browser launch, so the 'update' path cannot be
 * exercised in a browser harness.
 *
 * @param {{reason?: string}} details The onInstalled event details.
 * @returns {boolean}
 */
function shouldOpenSetupPage(details) {
    return !!details && details.reason === 'install';
}

/**
 * Compares two parsed INI config objects (plus optional extra known/mounted
 * remote IDs) to classify remotes as added, removed, modified, or unchanged.
 *
 * `extraKnownRemotes` lets the Service Worker catch remotes that are still
 * mounted in ChromeOS or listed in storage even when `oldConf` was empty or
 * unavailable across a Service Worker restart.
 *
 * @param {Record<string, Record<string, string>>} [oldConf={}]
 * @param {Record<string, Record<string, string>>} [newConf={}]
 * @param {Iterable<string>} [extraKnownRemotes=[]]
 * @returns {{added: string[], removed: string[], modified: string[], unchanged: string[]}}
 */
function diffRemoteConfigs(oldConf = {}, newConf = {}, extraKnownRemotes = []) {
    const safeOld = oldConf && typeof oldConf === 'object' ? oldConf : {};
    const safeNew = newConf && typeof newConf === 'object' ? newConf : {};

    const added = [];
    const removed = [];
    const modified = [];
    const unchanged = [];

    const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

    for (const name of Object.keys(safeNew)) {
        if (!hasOwn(safeOld, name)) {
            added.push(name);
            continue;
        }
        const prevSec = safeOld[name] || {};
        const nextSec = safeNew[name] || {};
        const prevKeys = Object.keys(prevSec);
        const nextKeys = Object.keys(nextSec);
        let same = prevKeys.length === nextKeys.length;
        if (same) {
            for (const k of nextKeys) {
                if (!hasOwn(prevSec, k) || prevSec[k] !== nextSec[k]) {
                    same = false;
                    break;
                }
            }
        }
        if (same) unchanged.push(name);
        else modified.push(name);
    }

    const removedSeen = new Set();
    const recordRemoved = (name) => {
        if (!name || hasOwn(safeNew, name) || removedSeen.has(name)) return;
        removedSeen.add(name);
        removed.push(name);
    };

    for (const name of Object.keys(safeOld)) recordRemoved(name);
    if (extraKnownRemotes) {
        for (const name of extraKnownRemotes) recordRemoved(name);
    }

    return { added, removed, modified, unchanged };
}

/**
 * Updates or renames a remote inside a parsed INI config object, preserving
 * section order on rename and updating any `crypt` overlay whose `remote`
 * target points at `oldName:` (e.g. `oldName:` or `oldName:folder`).
 *
 * @param {Record<string, Record<string, string>>} parsedConfig
 * @param {string|null|undefined} oldName Original remote name when editing, or null for new.
 * @param {string} newName Target remote name.
 * @param {Record<string, string>} newRemoteObj Updated key-value pairs for the section.
 * @returns {Record<string, Record<string, string>>}
 */
function renameRemoteInConfig(parsedConfig, oldName, newName, newRemoteObj) {
    const src = parsedConfig && typeof parsedConfig === 'object' ? parsedConfig : {};
    if (!oldName || oldName === newName) {
        return { ...src, [newName]: newRemoteObj };
    }

    const updated = {};
    let placed = false;
    const oldPrefix = oldName + ':';

    for (const [secName, secVals] of Object.entries(src)) {
        if (secName === oldName) {
            updated[newName] = newRemoteObj;
            placed = true;
            continue;
        }
        if (secVals && secVals.type === 'crypt' && typeof secVals.remote === 'string' && secVals.remote.startsWith(oldPrefix)) {
            updated[secName] = {
                ...secVals,
                remote: newName + secVals.remote.slice(oldName.length),
            };
        } else {
            updated[secName] = secVals;
        }
    }

    if (!placed) {
        updated[newName] = newRemoteObj;
    }
    return updated;
}

// Node.js export for the unit tests; in the Service Worker (importScripts)
// and on the options page (<script src>) the top-level function declarations
// above simply become globals.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { parseIniConfig, serializeIniConfig, sanitizeTokenValue, getParentPath, mapErrorToFsp, isAuthError, escapeHtml, shouldOpenSetupPage, diffRemoteConfigs, renameRemoteInConfig };
}
