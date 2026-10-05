const { test } = require('node:test');
const assert = require('node:assert/strict');
const { browserLogin } = require('../browser-auth');
test('diagnostic browser stays open until disconnect', async () => {
    let closed = false;
    const controller = new AbortController();
    const page = { goto: async () => {}, url: () => 'https://chat.genai.um.edu.mo/', locator: () => ({}) };
    const browser = { close: async () => { closed = true; }, newContext: async () => ({ newPage: async () => page, cookies: async () => [{ name: 'token', value: 'test', domain: 'chat.genai.um.edu.mo', path: '/', sameSite: 'Lax', expires: -1 }] }) };
    await browserLogin({ valid: async () => true, jar: { setCookie: async () => {} } }, {}, controller.signal, () => {}, { launch: async () => browser }, true);
    assert.equal(closed, false);
    controller.abort();
    assert.equal(closed, true);
});
test('saved session does not launch Edge', async () => {
    await browserLogin({ valid: async () => true }, {}, undefined, () => {}, { launch: () => assert.fail('unexpected launch') });
});
test('browser closes on navigation failure', async () => {
    let closed = false;
    const browser = { close: async () => { closed = true; }, newContext: async () => ({ newPage: async () => ({ goto: async () => { throw new Error('navigation failed'); } }) }) };
    await assert.rejects(browserLogin({ valid: async () => false }, {}, undefined, () => {}, { launch: async () => browser }), /navigation failed/);
    assert.ok(closed);
});
test('verified cookies survive browser closure', async () => {
    let checks = 0; let closed = false; let imported;
    const page = { goto: async () => {}, url: () => 'https://chat.genai.um.edu.mo/', locator: () => ({}) };
    const browser = { close: async () => { closed = true; }, newContext: async () => ({ newPage: async () => page, cookies: async () => [{ name: 'token', value: 'test', domain: 'chat.genai.um.edu.mo', path: '/', secure: true, httpOnly: true, sameSite: 'Lax', expires: -1 }] }) };
    await browserLogin({ valid: async () => ++checks > 1, jar: { setCookie: async cookie => { imported = cookie; } } }, {}, undefined, () => {}, { launch: async () => browser });
    assert.equal(imported.value, 'test'); assert.ok(closed);
});