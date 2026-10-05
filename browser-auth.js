const { chromium } = require('playwright-core');
const { Cookie } = require('tough-cookie');
const { setTimeout: delay } = require('node:timers/promises');
const { ORIGIN } = require('./auth');

async function browserLogin(session, credentials, signal, trace = () => {}, launcher = chromium, keepOpen = false) {
    if (keepOpen && !signal) throw new Error('Diagnostic browser requires disconnect signal');
    trace('Checking saved session');
    if (!keepOpen && await session.valid(signal)) return;
    const bounded = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(180000)]);
    bounded.throwIfAborted();
    let browser;
    let retained = false;
    const close = () => { browser?.close().catch(() => {}); };
    bounded.addEventListener('abort', close, { once: true });
    try {
        trace('Starting temporary headless Edge');
        browser = await launcher.launch({ channel: 'msedge', headless: true, timeout: 30000 });
        bounded.throwIfAborted();
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(`${ORIGIN}/oauth/oidc/login`, { waitUntil: 'domcontentloaded', timeout: 45000 });
        let submitted = false;
        let lastStage;
        while (true) {
            bounded.throwIfAborted();
            const origin = new URL(page.url()).origin;
            const stage = origin === 'https://websso.um.edu.mo' ? 'Waiting for UMPASS / MFA' : origin === ORIGIN ? 'Checking GENAI callback' : 'Waiting for identity redirect';
            if (stage !== lastStage) { trace(stage); lastStage = stage; }
            const password = page.locator('input[name="Password"][type="password"]');
            if (!submitted && origin === 'https://websso.um.edu.mo' && await password.isVisible()) {
                const safe = await password.evaluate(input => {
                    const form = input.form;
                    return globalThis.location.origin === 'https://websso.um.edu.mo' && form && new URL(form.action, globalThis.location.href).origin === globalThis.location.origin && form.method.toLowerCase() === 'post';
                });
                if (!safe) throw new Error('Unexpected credential form');
                trace('Filling verified UMPASS login form');
                const form = page.locator('form').filter({ has: password });
                await form.locator('input[name="UserName"]:visible').fill(credentials.username);
                await password.fill(credentials.password);
                submitted = true;
                trace('Submitting credentials once; waiting for automatic MFA completion');
                const submit = page.locator('#submitButton');
                if (await submit.count()) await submit.click();
                else await password.press('Enter');
            }
            if (origin === ORIGIN) {
                const cookies = await context.cookies(ORIGIN);
                for (const cookie of cookies) {
                    await session.jar.setCookie(new Cookie({ key: cookie.name, value: cookie.value, domain: cookie.domain.replace(/^\./, ''), hostOnly: !cookie.domain.startsWith('.'), path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly, sameSite: cookie.sameSite.toLowerCase(), expires: cookie.expires > 0 ? new Date(cookie.expires * 1000) : 'Infinity' }), ORIGIN);
                }
                if (cookies.length && await session.valid(bounded)) {
                    bounded.throwIfAborted();
                    trace('Browser session verified');
                    if (keepOpen) {
                        retained = true;
                        signal.addEventListener('abort', close, { once: true });
                        browser.once?.('disconnected', () => signal.removeEventListener('abort', close));
                        trace('Diagnostic mode: Edge retained until Disconnect');
                    }
                    return;
                }
            }
            await delay(1000, undefined, { signal: bounded });
        }
    } finally {
        bounded.removeEventListener('abort', close);
        if (browser && !retained) { await browser.close(); trace('Temporary Edge closed'); }
    }
}
module.exports = { browserLogin };