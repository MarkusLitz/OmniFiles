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
        // Avoid logging the raw SyntaxError: modern V8 embeds a snippet of the
        // input string in e.message, which could leak part of a token/secret.
        console.warn('[Rclone] Could not parse token JSON for sanitization, using as-is.');
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

// Known sensitive rclone configuration keys across all built-in schemas and
// commonly imported raw rclone.conf sections.
const SENSITIVE_CONFIG_KEYS = new Set([
    'token',
    'pass',
    'password',
    'password2',
    'secret_access_key',
    'client_secret',
    'bearer_token',
    'service_account_credentials',
    'session_token',
    'private_key',
    'key_pem',
    'api_key',
    'sas_url',
]);

// Matches snake_case / kebab-case segments such as *_token, *_secret, *_pass,
// password2, *_credentials, etc., without false-positives on words like "bypass".
const SENSITIVE_KEY_SEGMENT_RE = /(?:^|[_-])(?:token|pass|passwd|password|passphrase|secret|credential|credentials)(?:$|[_-\d])/i;

/**
 * Returns true if an rclone config key holds a secret, password, or token
 * that must never be written to Service Worker console logs in cleartext.
 *
 * @param {*} key Config key name.
 * @returns {boolean}
 */
function isSensitiveConfigKey(key) {
    if (typeof key !== 'string') return false;
    const normalized = key.trim().toLowerCase();
    if (!normalized) return false;
    return SENSITIVE_CONFIG_KEYS.has(normalized) || SENSITIVE_KEY_SEGMENT_RE.test(normalized);
}

/**
 * Masks the value of sensitive config keys with '[REDACTED]' for safe logging,
 * leaving ordinary non-secret values (e.g. `type`, `region`, `url`) readable.
 *
 * @param {*} key Config key name.
 * @param {*} value Config value.
 * @returns {string}
 */
function redactConfigValue(key, value) {
    if (isSensitiveConfigKey(key)) {
        return '[REDACTED]';
    }
    return String(value ?? '');
}

/**
 * Returns a log-safe shallow/deep clone of a `chrome.runtime.onMessage` payload
 * with raw INI config strings (`config`, `rcloneConf`) and any sensitive keys
 * replaced by '[REDACTED]'. Does not mutate the original request object.
 *
 * @param {*} request Runtime message payload.
 * @returns {*}
 */
function redactRuntimeMessage(request) {
    if (!request || typeof request !== 'object') return request;
    if (Array.isArray(request)) return request.map(redactRuntimeMessage);
    const copy = {};
    for (const [k, v] of Object.entries(request)) {
        if (k === 'config' || k === 'rcloneConf' || isSensitiveConfigKey(k)) {
            copy[k] = '[REDACTED]';
        } else if (v && typeof v === 'object') {
            copy[k] = redactRuntimeMessage(v);
        } else {
            copy[k] = v;
        }
    }
    return copy;
}

// Prefix used by `testConnection` to isolate unsaved test sections in WASM
// from live mounted remotes, `liveConfigCache`, `chrome.storage.local`, and
// auth-expiry notifications.
const EPHEMERAL_TEST_PREFIX = '__omnifiles_test_';

// Matches rclone's `fspath.CheckConfigName` rule: Unicode letters/numbers,
// `_`, `-`, `.`, `+`, `@`, and internal spaces, not starting with `-` or space
// and not ending with space.
const RCLONE_REMOTE_NAME_RE = /^[\w\p{L}\p{N}.+@]+(?:[ -]+[\w\p{L}\p{N}.+@-]+)*$/u;

/**
 * Returns true if `section` is an ephemeral section name created by
 * `testConnection` that must never be persisted to storage or trigger
 * user-facing auth notifications.
 *
 * @param {*} section Section / remote name.
 * @returns {boolean}
 */
function isEphemeralTestSection(section) {
    return typeof section === 'string' && section.startsWith(EPHEMERAL_TEST_PREFIX);
}

/**
 * Validates an rclone remote section name against rclone's `fspath` rules.
 *
 * @param {*} name Remote name.
 * @returns {boolean}
 */
function isValidRemoteName(name) {
    return typeof name === 'string' &&
        name.length > 0 &&
        !isEphemeralTestSection(name) &&
        RCLONE_REMOTE_NAME_RE.test(name);
}

/**
 * Builds an isolated execution plan for `testConnection` so every section in a
 * submitted `rclone.conf` is tested under a unique temporary WASM section name
 * without mutating or evicting live mounted remotes. Intra-config overlay
 * references (e.g. `crypt` `remote = base:folder`) are rewritten to point at
 * the corresponding temporary base section when `base` is part of the same
 * submitted config, while references to already-saved remotes remain intact.
 *
 * @param {Record<string, Record<string, string>>} parsedConf Parsed INI config.
 * @param {string|number} [runId='0'] Unique identifier for this test run.
 * @returns {{
 *   entries: Array<{name: string, tempName: string, config: Record<string, string>|null, validationError: string|null}>,
 *   tempToName: Record<string, string>
 * }}
 */
function buildEphemeralTestPlan(parsedConf, runId = '0') {
    const safeConf = parsedConf && typeof parsedConf === 'object' ? parsedConf : {};
    const safeRunId = String(runId ?? '0').replace(/[^a-zA-Z0-9_]/g, '_');
    const names = Object.keys(safeConf);
    const nameToTemp = {};
    const tempToName = {};

    names.forEach((name, idx) => {
        const tempName = `${EPHEMERAL_TEST_PREFIX}${safeRunId}_${idx}`;
        nameToTemp[name] = tempName;
        tempToName[tempName] = name;
    });

    const entries = [];
    for (const name of names) {
        const rawSec = safeConf[name];
        const tempName = nameToTemp[name];

        if (!isValidRemoteName(name)) {
            entries.push({
                name,
                tempName,
                config: null,
                validationError: `Invalid remote name "${name}".`,
            });
            continue;
        }

        if (!rawSec || typeof rawSec !== 'object' || !String(rawSec.type || '').trim()) {
            entries.push({
                name,
                tempName,
                config: null,
                validationError: 'Missing required "type" field.',
            });
            continue;
        }

        const cloned = { ...rawSec };
        if (cloned.token) {
            cloned.token = sanitizeTokenValue(cloned.token);
        }
        if (typeof cloned.remote === 'string') {
            const colonIdx = cloned.remote.indexOf(':');
            if (colonIdx > 0) {
                const targetName = cloned.remote.slice(0, colonIdx);
                if (Object.prototype.hasOwnProperty.call(nameToTemp, targetName)) {
                    cloned.remote = nameToTemp[targetName] + cloned.remote.slice(colonIdx);
                }
            }
        }

        entries.push({
            name,
            tempName,
            config: cloned,
            validationError: null,
        });
    }

    return { entries, tempToName };
}

/**
 * Extracts a clean, human-readable error message from WASM `rc()` rejection
 * objects (`{ status, error, path }`), `Error` instances, or plain strings, and
 * maps any temporary test section names back to the user's original remote names.
 *
 * @param {*} err Error value from WASM or JS.
 * @param {Record<string, string>|null} [tempToName=null] Mapping of tempName → original name.
 * @returns {string}
 */
function formatRcloneError(err, tempToName = null) {
    let text = '';
    if (err && typeof err === 'object') {
        text = String(err.error || err.message || '');
        if (!text) {
            try { text = JSON.stringify(err); } catch (_) { text = String(err); }
        }
    } else {
        text = String(err ?? '');
    }

    text = text
        .replace(/^method call failed:\s*/i, '')
        .replace(/^error in ListJSON:\s*/i, '')
        .trim();

    if (tempToName && typeof tempToName === 'object') {
        const tempKeys = Object.keys(tempToName).sort((a, b) => b.length - a.length);
        for (const tempKey of tempKeys) {
            if (tempKey && text.includes(tempKey)) {
                text = text.split(tempKey).join(tempToName[tempKey]);
            }
        }
    }

    return text || 'Unknown error';
}

/**
 * Aggregates per-remote `testConnection` outcomes into the response payload
 * expected by the Options UI (`{ success, remotes, results, error? }`).
 *
 * @param {Array<{remote: string, success: boolean, error?: string}>} results
 * @returns {{success: boolean, remotes: string[], results: Array<{remote: string, success: boolean, error?: string}>, error?: string}}
 */
function summarizeTestConnectionResults(results) {
    const list = Array.isArray(results) ? results : [];
    const remotes = list.map(r => r.remote);
    const failed = list.filter(r => !r.success);
    if (failed.length === 0) {
        return { success: true, remotes, results: list };
    }
    const error = list.length === 1
        ? failed[0].error
        : failed.map(f => `[${f.remote}] ${f.error}`).join('; ');
    return { success: false, error, remotes, results: list };
}

// Node.js export for the unit tests; in the Service Worker (importScripts)
// and on the options page (<script src>) the top-level function declarations
// above simply become globals.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        parseIniConfig,
        serializeIniConfig,
        sanitizeTokenValue,
        getParentPath,
        mapErrorToFsp,
        isAuthError,
        escapeHtml,
        shouldOpenSetupPage,
        diffRemoteConfigs,
        renameRemoteInConfig,
        isSensitiveConfigKey,
        redactConfigValue,
        redactRuntimeMessage,
        isEphemeralTestSection,
        isValidRemoteName,
        buildEphemeralTestPlan,
        formatRcloneError,
        summarizeTestConnectionResults,
    };
}
