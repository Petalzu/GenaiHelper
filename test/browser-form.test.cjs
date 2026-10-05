const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
test('ADFS duplicate username fields only fill visible password form', async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        const page = await browser.newPage();
        await page.setContent('<form><input name="UserName" type="email"><input name="Password" type="password"></form><form><input name="UserName" type="hidden" value="unchanged"></form>');
        const password = page.locator('input[name="Password"][type="password"]');
        await assert.rejects(page.locator('input[name="UserName"]').fill('test'), /strict mode violation/);
        const form = page.locator('form').filter({ has: password });
        await form.locator('input[name="UserName"]:visible').fill('test');
        assert.equal(await page.locator('input[type="email"]').inputValue(), 'test');
        assert.equal(await page.locator('input[type="hidden"]').inputValue(), 'unchanged');
    } finally { await browser.close(); }
});