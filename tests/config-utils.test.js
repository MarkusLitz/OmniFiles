// Unit tests for the pure helpers in src/config-utils.js
// Run with:  node --test tests/*.test.js
// (a bare `node --test tests/` does not resolve the suite and fails)

const { test } = require('node:test');
const assert = require('node:assert');
const {
    parseIniConfig,
    serializeIniConfig,
    sanitizeTokenValue,
    getParentPath,
    mapErrorToFsp,
    isAuthError,
    escapeHtml,
    shouldOpenSetupPage,
} = require('../src/config-utils.js');

// ── parseIniConfig ──────────────────────────────────────────────────────

test('parseIniConfig parses sections and key-value pairs', () => {
    const conf = parseIniConfig('[gdrive]\ntype = drive\ntoken = abc\n\n[s3remote]\ntype = s3\n');
    assert.deepStrictEqual(conf, {
        gdrive: { type: 'drive', token: 'abc' },
        s3remote: { type: 's3' },
    });
});

test('parseIniConfig skips comments and blank lines', () => {
    const conf = parseIniConfig('# comment\n; also comment\n\n[r]\nkey = value\n');
    assert.deepStrictEqual(conf, { r: { key: 'value' } });
});

test('parseIniConfig keeps "=" inside values (e.g. base64 tokens)', () => {
    const conf = parseIniConfig('[r]\ntoken = ab==cd=ef\n');
    assert.strictEqual(conf.r.token, 'ab==cd=ef');
});

test('parseIniConfig trims whitespace around sections, keys and values', () => {
    const conf = parseIniConfig('  [ r1 ]  \n  key  =  value  \n');
    assert.deepStrictEqual(conf, { r1: { key: 'value' } });
});

test('parseIniConfig ignores key-value lines before any section', () => {
    const conf = parseIniConfig('orphan = 1\n[r]\nkey = 2\n');
    assert.deepStrictEqual(conf, { r: { key: '2' } });
});

// ── serializeIniConfig ──────────────────────────────────────────────────

test('serializeIniConfig → parseIniConfig round-trips', () => {
    const original = {
        gdrive: { type: 'drive', token: '{"access_token":"x"}' },
        enc: { type: 'crypt', remote: 'gdrive:', password: 'obscured==' },
    };
    assert.deepStrictEqual(parseIniConfig(serializeIniConfig(original)), original);
});

test('serializeIniConfig writes the expected INI format', () => {
    assert.strictEqual(serializeIniConfig({ r: { a: '1', b: '2' } }), '[r]\na = 1\nb = 2\n\n');
});

// ── sanitizeTokenValue ──────────────────────────────────────────────────

test('sanitizeTokenValue repairs double-space corrupted expiry timestamps', () => {
    const corrupted = JSON.stringify({ access_token: 'x', expiry: '2026-04-13T18  :47:21' });
    const fixed = JSON.parse(sanitizeTokenValue(corrupted));
    assert.strictEqual(fixed.expiry, '2026-04-13T18:47:21');
});

test('sanitizeTokenValue repairs single-space corrupted expiry timestamps', () => {
    const corrupted = JSON.stringify({ expiry: '2026-04-13T18 :47:21' });
    const fixed = JSON.parse(sanitizeTokenValue(corrupted));
    assert.strictEqual(fixed.expiry, '2026-04-13T18:47:21');
});

test('sanitizeTokenValue leaves valid tokens untouched', () => {
    const valid = JSON.stringify({ access_token: 'x', expiry: '2026-04-13T18:47:21.000Z' });
    assert.deepStrictEqual(JSON.parse(sanitizeTokenValue(valid)), JSON.parse(valid));
});

test('sanitizeTokenValue returns non-JSON input as-is', () => {
    assert.strictEqual(sanitizeTokenValue('not json at all'), 'not json at all');
});

// ── getParentPath ───────────────────────────────────────────────────────

test('getParentPath resolves nested, top-level and root paths', () => {
    assert.strictEqual(getParentPath('/a/b/c.txt'), '/a/b');
    assert.strictEqual(getParentPath('/a'), '/');
    assert.strictEqual(getParentPath('/'), '/');
    assert.strictEqual(getParentPath(''), '/');
});

// ── mapErrorToFsp ───────────────────────────────────────────────────────

test('mapErrorToFsp maps rc bridge status codes', () => {
    assert.strictEqual(mapErrorToFsp({ status: 404, error: 'x' }), 'NOT_FOUND');
    assert.strictEqual(mapErrorToFsp({ status: 403, error: 'x' }), 'ACCESS_DENIED');
    assert.strictEqual(mapErrorToFsp({ status: 400, error: 'x' }), 'INVALID_OPERATION');
    assert.strictEqual(mapErrorToFsp({ status: 409, error: 'x' }), 'EXISTS');
    assert.strictEqual(mapErrorToFsp({ status: 500, error: 'boom' }), 'FAILED');
});

test('mapErrorToFsp maps common error message patterns', () => {
    assert.strictEqual(mapErrorToFsp('fileRead: object error: object not found'), 'NOT_FOUND');
    assert.strictEqual(mapErrorToFsp('directory not empty'), 'NOT_EMPTY');
    // Drive reports quota exhaustion as HTTP 403 — must map to NO_SPACE, not ACCESS_DENIED
    assert.strictEqual(mapErrorToFsp(new Error('googleapi: Error 403: quota exceeded')), 'NO_SPACE');
    assert.strictEqual(mapErrorToFsp({ status: 403, error: 'userRateLimitExceeded: quota exceeded' }), 'NO_SPACE');
    assert.strictEqual(mapErrorToFsp('permission denied'), 'ACCESS_DENIED');
    assert.strictEqual(mapErrorToFsp('upload error: connection reset'), 'IO');
    assert.strictEqual(mapErrorToFsp('insufficient storage quota'), 'NO_SPACE');
});

test('mapErrorToFsp falls back to the given default', () => {
    assert.strictEqual(mapErrorToFsp('something unexpected'), 'FAILED');
    assert.strictEqual(mapErrorToFsp('something unexpected', 'IO'), 'IO');
    assert.strictEqual(mapErrorToFsp(null), 'FAILED');
    assert.strictEqual(mapErrorToFsp(undefined), 'FAILED');
});

// ── isAuthError ─────────────────────────────────────────────────────────

test('isAuthError detects dead refresh tokens (rc bridge objects)', () => {
    // Google OAuth: revoked/expired refresh token
    assert.strictEqual(isAuthError({ status: 500, error: 'didn\'t get token: oauth2: cannot fetch token: 400 Bad Request: {"error": "invalid_grant"}' }), true);
    assert.strictEqual(isAuthError({ status: 401, error: 'Unauthorized' }), true);
    assert.strictEqual(isAuthError({ status: 500, error: 'failed to refresh token: oauth2: server response missing access_token' }), true);
});

test('isAuthError detects auth failures in plain-string bridge errors', () => {
    assert.strictEqual(isAuthError('fileRead: open error: couldn\'t fetch token: invalid_grant'), true);
    assert.strictEqual(isAuthError('fileWrite: upload error: token has been expired or revoked'), true);
});

test('isAuthError does not fire on ordinary errors', () => {
    assert.strictEqual(isAuthError({ status: 404, error: 'object not found' }), false);
    assert.strictEqual(isAuthError({ status: 403, error: 'quota exceeded' }), false);
    assert.strictEqual(isAuthError('connection reset by peer'), false);
    assert.strictEqual(isAuthError(null), false);
    assert.strictEqual(isAuthError(undefined), false);
});

// ── escapeHtml ──────────────────────────────────────────────────────────

test('escapeHtml neutralizes markup in remote names', () => {
    assert.strictEqual(
        escapeHtml('<img src=x onerror=alert(1)>'),
        '&lt;img src=x onerror=alert(1)&gt;'
    );
    assert.strictEqual(
        escapeHtml('</span><script>bad()</script>'),
        '&lt;/span&gt;&lt;script&gt;bad()&lt;/script&gt;'
    );
});

test('escapeHtml escapes quotes so it is safe inside an attribute', () => {
    // statusClass/statusTitle land in class="…" and title="…"
    assert.strictEqual(escapeHtml('a" onmouseover="x'), 'a&quot; onmouseover=&quot;x');
    assert.strictEqual(escapeHtml("a' onmouseover='x"), 'a&#39; onmouseover=&#39;x');
});

test('escapeHtml escapes ampersands first, without double-escaping entities', () => {
    assert.strictEqual(escapeHtml('a & b'), 'a &amp; b');
    // A literal "&lt;" typed by the user must survive as visible text.
    assert.strictEqual(escapeHtml('&lt;'), '&amp;lt;');
});

test('escapeHtml coerces non-string values', () => {
    assert.strictEqual(escapeHtml(0), '0');
    assert.strictEqual(escapeHtml(42), '42');
    assert.strictEqual(escapeHtml(null), '');
    assert.strictEqual(escapeHtml(undefined), '');
});

test('escapeHtml leaves ordinary config values untouched', () => {
    assert.strictEqual(escapeHtml('gdrive'), 'gdrive');
    assert.strictEqual(escapeHtml('My Work Drive'), 'My Work Drive');
    assert.strictEqual(escapeHtml('s3'), 's3');
});

// ── shouldOpenSetupPage ─────────────────────────────────────────────────

test('shouldOpenSetupPage fires only for a genuinely fresh install', () => {
    assert.strictEqual(shouldOpenSetupPage({ reason: 'install' }), true);
});

test('shouldOpenSetupPage stays quiet for every non-install reason', () => {
    // An auto-update from the Web Store must not spawn a tab.
    assert.strictEqual(shouldOpenSetupPage({ reason: 'update' }), false);
    // These fire for reasons unrelated to this extension being added.
    assert.strictEqual(shouldOpenSetupPage({ reason: 'chrome_update' }), false);
    assert.strictEqual(shouldOpenSetupPage({ reason: 'shared_module_update' }), false);
});

test('shouldOpenSetupPage tolerates a missing or malformed details object', () => {
    assert.strictEqual(shouldOpenSetupPage(undefined), false);
    assert.strictEqual(shouldOpenSetupPage(null), false);
    assert.strictEqual(shouldOpenSetupPage({}), false);
    assert.strictEqual(shouldOpenSetupPage({ reason: '' }), false);
});
