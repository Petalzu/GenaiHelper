const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('local access permits none metadata but requires host and bearer without Origin', () => {
    const source = fs.readFileSync(require.resolve('../extension.js'), 'utf8');
    const start = source.indexOf('const fetchSite =');
    const end = source.indexOf('if (rejected)', start);
    assert.ok(start >= 0 && end > start);
    const check = headers => vm.runInNewContext(source.slice(start, end) + 'rejected', { request: { headers } });
    const base = { host: '127.0.0.1:58379', authorization: 'Bearer local-browser-session' };
    assert.equal(check(base), '');
    assert.equal(check({ ...base, 'sec-fetch-site': 'none' }), '');
    for (const site of ['cross-site', 'same-site', 'same-origin', 'invalid']) {
        assert.notEqual(check({ ...base, 'sec-fetch-site': site }), '');
    }
    assert.notEqual(check({ ...base, origin: 'https://example.com' }), '');
    assert.notEqual(check({ ...base, authorization: 'wrong', 'sec-fetch-site': 'none' }), '');
    assert.notEqual(check({ ...base, authorization: undefined }), '');
    assert.notEqual(check({ ...base, host: 'example.com' }), '');
});