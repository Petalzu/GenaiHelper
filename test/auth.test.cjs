const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Session, forms, login } = require('../auth');
test('forms preserve hidden values and decode entities', () => {
    const [form] = forms('<form method="post" action="/login?a=1&amp;b=2"><input name="csrf" type="hidden" value="a&amp;b"><input name="Password" type="password"></form>', 'https://websso.um.edu.mo/');
    assert.equal(form.action, 'https://websso.um.edu.mo/login?a=1&b=2');
    assert.equal(form.fields[0].value, 'a&b');
});
test('untrusted destinations are refused before fetch', async () => {
    await assert.rejects(new Session().request('https://example.com'), /Untrusted/);
    await assert.rejects(new Session().request('http://websso.um.edu.mo'), /Untrusted/);
});
test('rejected credentials are submitted only once', async () => {
    let posts = 0;
    const session = { valid: async () => false, request: async (url, options) => {
        if (options.method === 'POST') { posts++; assert.equal(options.body.get('UserName'), 'test'); assert.equal(options.body.get('Password'), 'dummy'); }
        return { url: 'https://websso.um.edu.mo/adfs/ls/', text: async () => '<form method="post"><input name="UserName" type="email"><input name="Password" type="password"></form>' };
    } };
    await assert.rejects(login(session, { username: 'test', password: 'dummy' }), /rejected/);
    assert.equal(posts, 1);
});
test('valid saved session needs no login request', async () => {
    await login({ valid: async () => true, request: () => assert.fail('unexpected login') }, {});
});
test('redirect cookies are retained and restored', async () => {
    const original = global.fetch;
    let calls = 0;
    global.fetch = async (url, options) => {
        calls++;
        if (calls === 1) return new Response(null, { status: 302, headers: { location: '/next', 'set-cookie': 'session=test; Secure; Path=/' } });
        assert.match(options.headers.Cookie, /session=test/);
        return new Response('{}', { headers: { 'content-type': 'application/json' } });
    };
    try {
        const session = new Session(); await session.request('https://chat.genai.um.edu.mo/');
        const restored = new Session(JSON.stringify(session.jar.toJSON()));
        assert.match(await restored.jar.getCookieString('https://chat.genai.um.edu.mo/'), /session=test/);
    } finally { global.fetch = original; }
});