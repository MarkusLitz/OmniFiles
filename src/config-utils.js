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

// Node.js export for the unit tests; in the Service Worker (importScripts)
// and on the options page (<script src>) the top-level function declarations
// above simply become globals.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { parseIniConfig, serializeIniConfig, sanitizeTokenValue, getParentPath, mapErrorToFsp, isAuthError, escapeHtml, shouldOpenSetupPage };
}
