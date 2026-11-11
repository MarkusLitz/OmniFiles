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

// ── diffRemoteConfigs ───────────────────────────────────────────────────

test('diffRemoteConfigs classifies added, removed, modified and unchanged remotes', () => {
    const oldConf = {
        keep: { type: 's3', region: 'eu-central-1' },
        edit: { type: 'drive', token: 'old', team_drive: 'td1' },
        drop: { type: 'dropbox', token: 'x' },
    };
    const newConf = {
        keep: { type: 's3', region: 'eu-central-1' },
        edit: { type: 'drive', token: 'new' }, // value changed + key removed
        fresh: { type: 'webdav', url: 'https://cloud.example.com' },
    };
    assert.deepStrictEqual(diffRemoteConfigs(oldConf, newConf), {
        added: ['fresh'],
        removed: ['drop'],
        modified: ['edit'],
        unchanged: ['keep'],
    });
});

test('diffRemoteConfigs catches extra mounted remotes even when oldConf is empty', () => {
    // Simulates deleting the last remote right after a Service Worker restart
    const diff = diffRemoteConfigs({}, {}, ['staleMount', 'staleMount', 'anotherMount']);
    assert.deepStrictEqual(diff, {
        added: [],
        removed: ['staleMount', 'anotherMount'],
        modified: [],
        unchanged: [],
    });
});

test('diffRemoteConfigs detects key removal when remaining keys match', () => {
    const oldConf = { r: { type: 'drive', token: 't', team_drive: 'abc' } };
    const newConf = { r: { type: 'drive', token: 't' } };
    assert.deepStrictEqual(diffRemoteConfigs(oldConf, newConf).modified, ['r']);
});

// ── renameRemoteInConfig ────────────────────────────────────────────────

test('renameRemoteInConfig replaces old section in-place and removes duplicate', () => {
    const orig = {
        first: { type: 's3' },
        oldname: { type: 'drive', token: 't1' },
        last: { type: 'webdav' },
    };
    const next = renameRemoteInConfig(orig, 'oldname', 'newname', { type: 'drive', token: 't2' });
    assert.deepStrictEqual(Object.keys(next), ['first', 'newname', 'last']);
    assert.strictEqual(next.oldname, undefined);
    assert.deepStrictEqual(next.newname, { type: 'drive', token: 't2' });
});

test('renameRemoteInConfig updates dependent crypt overlay references on rename', () => {
    const orig = {
        gdrive: { type: 'drive', token: 't' },
        encRoot: { type: 'crypt', remote: 'gdrive:', password: 'p' },
        encSub: { type: 'crypt', remote: 'gdrive:vault/sub', password: 'p' },
        encOther: { type: 'crypt', remote: 'gdrive2:vault', password: 'p' },
    };
    const next = renameRemoteInConfig(orig, 'gdrive', 'workdrive', { type: 'drive', token: 't' });
    assert.strictEqual(next.encRoot.remote, 'workdrive:');
    assert.strictEqual(next.encSub.remote, 'workdrive:vault/sub');
    // Must not touch gdrive2: (prefix boundary is colon)
    assert.strictEqual(next.encOther.remote, 'gdrive2:vault');
});

test('renameRemoteInConfig updates in place when name is unchanged', () => {
    const orig = { gdrive: { type: 'drive', token: 'old' } };
    const next = renameRemoteInConfig(orig, 'gdrive', 'gdrive', { type: 'drive', token: 'new' });
    assert.deepStrictEqual(next, { gdrive: { type: 'drive', token: 'new' } });
});

// ── isSensitiveConfigKey / redactConfigValue / redactRuntimeMessage ─────

test('isSensitiveConfigKey detects all known schema and raw-config credential keys', () => {
    const sensitiveKeys = [
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
        'TOKEN',
        '  client_secret  ',
        'custom_auth_token',
        'ssh_key_passphrase',
    ];
    for (const key of sensitiveKeys) {
        assert.strictEqual(isSensitiveConfigKey(key), true, `Expected "${key}" to be sensitive`);
    }
});

test('isSensitiveConfigKey leaves non-secret config keys unmasked', () => {
    const publicKeys = [
        'type',
        'scope',
        'region',
        'provider',
        'url',
        'vendor',
        'user',
        'client_id',
        'access_key_id',
        'endpoint',
        'acl',
        'project_number',
        'anonymous',
        'team_drive',
        'remote',
        'filename_encryption',
        'directory_name_encryption',
        'bypass', // substring "pass" without segment boundary must not false-positive
        '',
        null,
        undefined,
    ];
    for (const key of publicKeys) {
        assert.strictEqual(isSensitiveConfigKey(key), false, `Expected "${key}" not to be sensitive`);
    }
});

test('isSensitiveConfigKey covers every password / obscured field in config-schemas.js', () => {
    const prevWindow = global.window;
    global.window = {};
    try {
        delete require.cache[require.resolve('../src/config-schemas.js')];
        require('../src/config-schemas.js');
        const providers = global.window.rcloneProviders;
        assert.ok(providers && Object.keys(providers).length > 0);
        for (const [provKey, prov] of Object.entries(providers)) {
            for (const field of prov.fields) {
                if (field.type === 'password' || field.needsObscure) {
                    assert.strictEqual(
                        isSensitiveConfigKey(field.name),
                        true,
                        `Provider "${provKey}" secret field "${field.name}" must be redacted`
                    );
                }
            }
        }
    } finally {
        if (prevWindow === undefined) delete global.window;
        else global.window = prevWindow;
    }
});

test('redactConfigValue masks secrets and preserves ordinary config values', () => {
    assert.strictEqual(
        redactConfigValue('token', '{"access_token":"ya29.secret","refresh_token":"1//secret"}'),
        '[REDACTED]'
    );
    assert.strictEqual(redactConfigValue('pass', 'obscured_pw'), '[REDACTED]');
    assert.strictEqual(redactConfigValue('password2', 'obscured_salt'), '[REDACTED]');
    assert.strictEqual(redactConfigValue('secret_access_key', 'wJalrXUtnFEMI/K7MDENG'), '[REDACTED]');
    assert.strictEqual(redactConfigValue('service_account_credentials', '{"private_key":"..."}'), '[REDACTED]');
    assert.strictEqual(redactConfigValue('type', 'drive'), 'drive');
    assert.strictEqual(redactConfigValue('region', 'eu-central-1'), 'eu-central-1');
    assert.strictEqual(redactConfigValue('url', null), '');
});

test('redactRuntimeMessage redacts raw config payloads without mutating the request', () => {
    const req = {
        action: 'testConnection',
        config: '[gdrive]\ntype = drive\ntoken = {"access_token":"ya29.secret"}\n',
    };
    const safe = redactRuntimeMessage(req);
    assert.deepStrictEqual(safe, {
        action: 'testConnection',
        config: '[REDACTED]',
    });
    // Original request must stay intact for the message handler to parse
    assert.ok(req.config.includes('ya29.secret'));

    // Non-sensitive messages pass through unchanged
    assert.deepStrictEqual(redactRuntimeMessage({ action: 'getDashboardData' }), {
        action: 'getDashboardData',
    });

    // Nested sensitive keys are also redacted
    assert.deepStrictEqual(
        redactRuntimeMessage({ action: 'custom', meta: { bearer_token: 'abc', vendor: 'nextcloud' } }),
        { action: 'custom', meta: { bearer_token: '[REDACTED]', vendor: 'nextcloud' } }
    );
    assert.strictEqual(redactRuntimeMessage(null), null);
});

// ── testConnection isolation & multi-remote helpers ─────────────────────

test('isEphemeralTestSection identifies temporary testConnection sections only', () => {
    assert.strictEqual(isEphemeralTestSection('__omnifiles_test_1700000_1_0'), true);
    assert.strictEqual(isEphemeralTestSection('gdrive'), false);
    assert.strictEqual(isEphemeralTestSection(''), false);
    assert.strictEqual(isEphemeralTestSection(null), false);
});

test('isValidRemoteName matches rclone fspath remote naming rules', () => {
    assert.strictEqual(isValidRemoteName('gdrive'), true);
    assert.strictEqual(isValidRemoteName('My_Work-Drive.1'), true);
    assert.strictEqual(isValidRemoteName('My Cloud Drive'), true);
    assert.strictEqual(isValidRemoteName('-leading-dash'), false);
    assert.strictEqual(isValidRemoteName(' leading-space'), false);
    assert.strictEqual(isValidRemoteName('trailing-space '), false);
    assert.strictEqual(isValidRemoteName('bad:colon'), false);
    assert.strictEqual(isValidRemoteName('bad/slash'), false);
    assert.strictEqual(isValidRemoteName('__omnifiles_test_1_0'), false);
    assert.strictEqual(isValidRemoteName(''), false);
});

test('buildEphemeralTestPlan isolates sections and rewrites sibling overlay targets regardless of order', () => {
    const rawConf = {
        // crypt listed BEFORE its base remote in INI order
        vault: { type: 'crypt', remote: 'gdrive:encrypted/sub', password: 'obs' },
        // crypt referencing an already-saved external remote not in rawConf
        extVault: { type: 'crypt', remote: 'savedS3:bucket/sec', password: 'obs' },
        gdrive: {
            type: 'drive',
            token: JSON.stringify({ access_token: 'x', expiry: '2026-04-13T18  :47:21' }),
        },
    };
    const plan = buildEphemeralTestPlan(rawConf, '42_1');

    assert.strictEqual(plan.entries.length, 3);
    const [vaultEntry, extEntry, driveEntry] = plan.entries;

    assert.strictEqual(vaultEntry.tempName, '__omnifiles_test_42_1_0');
    assert.strictEqual(extEntry.tempName, '__omnifiles_test_42_1_1');
    assert.strictEqual(driveEntry.tempName, '__omnifiles_test_42_1_2');

    // Sibling remote rewritten to temporary section name
    assert.strictEqual(vaultEntry.config.remote, '__omnifiles_test_42_1_2:encrypted/sub');
    // Saved external remote reference preserved as-is
    assert.strictEqual(extEntry.config.remote, 'savedS3:bucket/sec');
    // Token sanitized on the clone without mutating caller's rawConf
    assert.strictEqual(JSON.parse(driveEntry.config.token).expiry, '2026-04-13T18:47:21');
    assert.ok(rawConf.gdrive.token.includes('18  :47:21'));
});

test('buildEphemeralTestPlan flags invalid remote names and missing type fields', () => {
    const plan = buildEphemeralTestPlan({
        '-bad': { type: 's3' },
        notype: { region: 'eu-central-1' },
        good: { type: 'webdav', url: 'https://cloud.example.com' },
    }, '7');

    assert.ok(plan.entries[0].validationError.includes('Invalid remote name'));
    assert.strictEqual(plan.entries[0].config, null);
    assert.ok(plan.entries[1].validationError.includes('type'));
    assert.strictEqual(plan.entries[1].config, null);
    assert.strictEqual(plan.entries[2].validationError, null);
    assert.strictEqual(plan.entries[2].config.type, 'webdav');
});

test('formatRcloneError unwraps rc rejection objects and restores original remote names', () => {
    const tempToName = {
        __omnifiles_test_9_1: 'first',
        __omnifiles_test_9_10: 'tenth',
    };
    const rcErr = {
        status: 404,
        error: 'method call failed: error in ListJSON: failed on "__omnifiles_test_9_10:" and "__omnifiles_test_9_1:"',
        path: 'operations/list',
    };
    assert.strictEqual(
        formatRcloneError(rcErr, tempToName),
        'failed on "tenth:" and "first:"'
    );
    assert.strictEqual(formatRcloneError(new Error('network timeout')), 'network timeout');
    assert.strictEqual(formatRcloneError('plain failure'), 'plain failure');
    assert.strictEqual(formatRcloneError(null), 'Unknown error');
});

test('summarizeTestConnectionResults reports all remotes and per-remote errors', () => {
    assert.deepStrictEqual(
        summarizeTestConnectionResults([
            { remote: 'gdrive', success: true },
            { remote: 's3work', success: true },
        ]),
        {
            success: true,
            remotes: ['gdrive', 's3work'],
            results: [
                { remote: 'gdrive', success: true },
                { remote: 's3work', success: true },
            ],
        }
    );

    // Single remote failure uses unprefixed error message
    const singleFail = summarizeTestConnectionResults([
        { remote: 'gdrive', success: false, error: 'invalid_grant' },
    ]);
    assert.strictEqual(singleFail.success, false);
    assert.strictEqual(singleFail.error, 'invalid_grant');

    // Multi-remote failure names each failing section while preserving full results
    const multiFail = summarizeTestConnectionResults([
        { remote: 'gdrive', success: true },
        { remote: 's3bad', success: false, error: 'InvalidAccessKeyId' },
        { remote: 'vault', success: false, error: 'directory not found' },
    ]);
    assert.strictEqual(multiFail.success, false);
    assert.strictEqual(multiFail.error, '[s3bad] InvalidAccessKeyId; [vault] directory not found');
    assert.deepStrictEqual(multiFail.remotes, ['gdrive', 's3bad', 'vault']);
});
