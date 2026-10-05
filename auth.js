const { CookieJar } = require('tough-cookie');
const { load } = require('cheerio');
const ORIGIN = 'https://chat.genai.um.edu.mo';
const HOSTS = new Set(['chat.genai.um.edu.mo', 'login.um.edu.mo', 'websso.um.edu.mo']);

class Session {
    constructor(saved, trace = () => {}) { this.jar = saved ? CookieJar.fromJSON(saved) : new CookieJar(); this.trace = trace; }
    async request(url, options = {}) {
        let current = new URL(url);
        let method = options.method || 'GET';
        let body = options.body;
        for (let count = 0; count < 20; count++) {
            if (current.protocol !== 'https:' || !HOSTS.has(current.hostname)) throw new Error('Untrusted authentication destination');
            const headers = { ...options.headers, Cookie: await this.jar.getCookieString(current.href) };
            this.trace(`HTTP ${method} ${current.hostname}`);
            let response;
            try {
                response = await fetch(current, { method, body, headers, redirect: 'manual', signal: options.signal || AbortSignal.timeout(120000) });
            } catch (error) {
                const code = error.cause?.code || error.name;
                this.trace(`Transport failure: ${/^[A-Za-z0-9_]+$/.test(code) ? code : 'UNKNOWN'}`);
                throw error;
            }
            this.trace(`HTTP status ${response.status}`);
            for (const cookie of response.headers.getSetCookie()) await this.jar.setCookie(cookie, current.href);
            const location = response.headers.get('location');
            if (![301, 302, 303, 307, 308].includes(response.status) || !location) return response;
            await response.body?.cancel();
            if (response.status === 303 || ([301, 302].includes(response.status) && method === 'POST')) { method = 'GET'; body = undefined; }
            const next = new URL(location, current);
            if (body && next.origin !== current.origin) throw new Error('Cross-origin POST redirect refused');
            current = next;
        }
        throw new Error('Too many authentication redirects');
    }
    async valid(signal) {
        const response = await this.request(`${ORIGIN}/api/v1/models`, { signal });
        const valid = response.ok && (response.headers.get('content-type') || '').includes('application/json');
        await response.body?.cancel();
        return valid;
    }
}

function forms(html, url) {
    const document = load(html);
    return document('form').toArray().map(element => {
        const form = document(element);
        const fields = [];
        form.find('input').each((index, input) => {
            const field = document(input);
            if (field.attr('name')) fields.push({ name: field.attr('name'), type: field.attr('type') || 'text', value: field.attr('value') || '' });
        });
        return { action: new URL(form.attr('action') || url, url).href, method: (form.attr('method') || 'GET').toUpperCase(), fields };
    });
}
async function login(session, credentials, signal, trace = () => {}) {
    trace('Checking saved session');
    if (await session.valid(signal)) return;
    trace('Starting OIDC redirects');
    let response = await session.request(`${ORIGIN}/oauth/oidc/login`, { signal });
    let submitted = false;
    for (let step = 0; step < 12; step++) {
        const html = await response.text();
        const available = forms(html, response.url);
        const passwordForm = available.find(form => form.fields.some(field => field.type === 'password'));
        trace(`Authentication step ${step + 1}: ${passwordForm ? 'password form' : 'federation or completion page'}`);
        let form;
        if (passwordForm) {
            if (submitted) { trace('Password form returned after submission; credentials rejected or additional verification required'); throw new Error('UMPASS rejected login. Check credentials or required verification.'); }
            if (new URL(passwordForm.action).origin !== 'https://websso.um.edu.mo') throw new Error('Unexpected password destination');
            form = passwordForm;
            submitted = true;
        } else {
            form = available.find(item => item.fields.some(field => ['SAMLRequest', 'SAMLResponse', 'wresult'].includes(field.name)) && item.fields.every(field => field.type === 'hidden'));
        }
        if (!form) {
            trace('No supported form; validating resulting API session');
            if (await session.valid(signal)) return;
            trace('Resulting API session invalid; unsupported or interactive step');
            throw new Error('Interactive verification or unsupported login step required; no browser was opened.');
        }
        if (form.method !== 'POST') throw new Error('Unsupported authentication form method');
        const body = new URLSearchParams();
        for (const field of form.fields) {
            if (['checkbox', 'submit', 'button'].includes(field.type)) continue;
            body.append(field.name, field.name === 'UserName' && passwordForm ? credentials.username : field.type === 'password' ? credentials.password : field.value);
        }
        trace(passwordForm ? 'Submitting credentials once' : 'Submitting federation form');
        response = await session.request(form.action, { method: 'POST', body, signal });
    }
    throw new Error('Authentication step limit exceeded');
}
module.exports = { Session, forms, ORIGIN, login };