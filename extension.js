const vscode = require('vscode');
const http = require('node:http');
const { Readable } = require('node:stream');
const { Session, ORIGIN } = require('./auth');
const { browserLogin: login } = require('./browser-auth');
const { dashboardHtml } = require('./dashboard');
const { createStats, recordRequest, commitRequest, createUsageParser } = require('./stats');

let stopActive;

class DashboardProvider {
	constructor(getState, actions, onError) {
		this.getState = getState;
		this.actions = actions;
		this.onError = onError;
		this.view = undefined;
		this.messageSubscription = undefined;
		this.disposeSubscription = undefined;
	}

	resolveWebviewView(view) {
		this.view = view;
		view.webview.options = { enableScripts: true };
		view.webview.html = dashboardHtml();
		this.messageSubscription = view.webview.onDidReceiveMessage(message => {
			if (message?.command === 'ready' || message?.command === 'refresh') {
				this.refresh();
				return;
			}
			const action = this.actions[message?.command];
			if (action) Promise.resolve(action()).catch(this.onError);
		});
		this.disposeSubscription = view.onDidDispose(() => {
			if (this.view === view) this.view = undefined;
			this.messageSubscription?.dispose();
			this.messageSubscription = undefined;
		});
		this.refresh();
	}

	refresh() {
		this.view?.webview.postMessage({ type: 'state', data: this.getState() });
	}

	dispose() {
		this.messageSubscription?.dispose();
		this.disposeSubscription?.dispose();
		this.view = undefined;
	}
}

function activate(context) {
	const output = vscode.window.createOutputChannel('GENAI Login');
	context.subscriptions.push(output);
	const trace = message => output.appendLine(`${new Date().toISOString()} ${message}`);
	let server, active, authentication, keepaliveTimer, keepaliveOwner;
	let state = 'Disconnected';
	let dashboard;
	let keepaliveInfo = { state: 'idle', lastCheckAt: null };
	const stats = createStats(58379);
	const status = value => { state = value; dashboard?.refresh(); };
	const stateSnapshot = () => ({
		status: state,
		port: stats.port,
		connectedAt: stats.connectedAt,
		requests: stats.requests,
		tokensIn: stats.tokensIn,
		tokensOut: stats.tokensOut,
		usageReports: stats.usageReports,
		usageMissing: stats.usageMissing,
		models: [...stats.models].map(([name, requests]) => ({ name, requests })).concat(stats.otherModels ? [{ name: '其他模型', requests: stats.otherModels }] : []),
		keepalive: { ...keepaliveInfo }
	});
	const stop = () => {
		active?.abort(); active = undefined; authentication = undefined;
		clearTimeout(keepaliveTimer); keepaliveTimer = undefined; keepaliveOwner = undefined;
		keepaliveInfo = { state: 'idle', lastCheckAt: null };
		server?.closeAllConnections(); server?.close(); server = undefined;
		stats.connectedAt = null; stats.requests = 0; stats.tokensIn = 0; stats.tokensOut = 0; stats.usageReports = 0; stats.usageMissing = 0; stats.models.clear(); stats.otherModels = 0;
		status('Disconnected');
	};
	stopActive = stop;
	const credentials = async () => {
		if (active) throw new Error('Disconnect before changing credentials.');
		const username = await vscode.window.showInputBox({ title: 'UMPASS account', prompt: 'Full UMPASS login name', ignoreFocusOut: true });
		if (!username) return false;
		const password = await vscode.window.showInputBox({ title: 'UMPASS password', password: true, ignoreFocusOut: true });
		if (!password) return false;
		await context.secrets.store('credentials', JSON.stringify({ username, password }));
		await context.secrets.delete('session');
		return true;
	};
	const connect = async () => {
		if (active) return;
		output.show(true);
		trace('Manual connection requested');
		let stored = await context.secrets.get('credentials');
		if (!stored) { if (!await credentials()) return; stored = await context.secrets.get('credentials'); }
		if (active) return;
		const controller = new AbortController(); active = controller;
		keepaliveOwner = controller;
		let keepaliveInFlight = false;
		const account = JSON.parse(stored);
		let session;
		try { session = new Session(await context.secrets.get('session'), trace); } catch { trace('Saved cookie jar unavailable; starting fresh'); session = new Session(undefined, trace); }
		if (controller.signal.aborted) return;
		const persist = async () => { controller.signal.throwIfAborted(); await context.secrets.store('session', JSON.stringify(session.jar.toJSON())); };
		const authenticate = () => {
			if (!authentication) {
				status('Authenticating');
				authentication = login(session, account, controller.signal, trace, undefined, true).then(async () => { await persist(); stats.connectedAt ??= Date.now(); trace('Authenticated; session saved'); status(`Connected :${stats.port}`); }).finally(() => { if (active === controller) authentication = undefined; });
			}
			return authentication;
		};
		const scheduleKeepalive = () => {
			if (keepaliveOwner !== controller || active !== controller || controller.signal.aborted) return;
			clearTimeout(keepaliveTimer);
			keepaliveTimer = setTimeout(runKeepalive, 60000);
		};
		const isCurrentConnection = () => keepaliveOwner === controller && active === controller && !controller.signal.aborted;
		const runKeepalive = async () => {
			if (!isCurrentConnection() || keepaliveInFlight) return;
			keepaliveInFlight = true;
			keepaliveInfo = { state: 'checking', lastCheckAt: Date.now() };
			dashboard?.refresh();
			try {
				const valid = await session.valid(controller.signal);
				if (!isCurrentConnection()) return;
				if (valid) {
					await persist();
					if (!isCurrentConnection()) return;
					keepaliveInfo = { state: 'healthy', lastCheckAt: Date.now() };
					trace('Keepalive: session valid');
				} else {
					keepaliveInfo = { state: 'reauthenticating', lastCheckAt: Date.now() };
					dashboard?.refresh();
					trace('Keepalive: session expired; reauthenticating');
					await authenticate();
					if (!isCurrentConnection()) return;
					await persist();
					if (!isCurrentConnection()) return;
					keepaliveInfo = { state: 'healthy', lastCheckAt: Date.now() };
					trace('Keepalive: reauthenticated');
				}
			} catch { if (isCurrentConnection()) { keepaliveInfo = { state: 'error', lastCheckAt: Date.now() }; trace('Keepalive: check failed; will retry'); } }
			finally {
				keepaliveInFlight = false;
				if (isCurrentConnection()) { scheduleKeepalive(); dashboard?.refresh(); }
			}
		};
		const startKeepalive = () => { clearTimeout(keepaliveTimer); scheduleKeepalive(); };
		const sendError = (response, code, message) => { response.writeHead(code, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message } })); };
		const settleRequest = requestStats => {
			if (active !== controller || controller.signal.aborted) return;
			if (commitRequest(stats, requestStats)) dashboard?.refresh();
		};
		const handle = async (request, response) => {
			const fetchSite = request.headers['sec-fetch-site'];
			const rejected = request.headers.host !== '127.0.0.1:58379' ? 'host mismatch' : request.headers.origin ? 'Origin present' : fetchSite !== undefined && fetchSite !== 'none' ? `Fetch Metadata rejected (${['same-origin', 'same-site', 'cross-site'].includes(fetchSite) ? fetchSite : 'unrecognized'})` : request.headers.authorization !== 'Bearer local-browser-session' ? (request.headers.authorization ? 'Authorization mismatch' : 'Authorization missing') : '';
			if (rejected) { trace(`Local request rejected: ${rejected}`); return sendError(response, 403, `Local authenticated clients only: ${rejected}`); }
			const route = request.method === 'POST' && request.url === '/v1/chat/completions' ? '/api/v1/chat/completions' : request.method === 'GET' && request.url === '/v1/models' ? '/api/v1/models' : null;
			if (!route) return sendError(response, 404, 'Not found');
			if (authentication) await authentication;
			const chunks = []; let size = 0;
			for await (const chunk of request) { size += chunk.length; if (size > 20 * 1024 * 1024) return sendError(response, 413, 'Request too large'); chunks.push(chunk); }
			const options = { method: request.method, body: request.method === 'POST' ? Buffer.concat(chunks) : undefined, headers: { 'content-type': 'application/json', Accept: 'application/json' }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]) };
			let result = await session.request(ORIGIN + route, options);
			if (result.status === 401) {
				await result.body?.cancel();
				try { await authenticate(); } catch { sendError(response, 401, 'Automatic login failed; reconnect after checking credentials or verification.'); if (active === controller) stop(); return; }
				result = await session.request(ORIGIN + route, options);
			}
			await persist(); status(`Connected :${stats.port}`);
			const requestStats = request.method === 'POST' && request.url === '/v1/chat/completions' ? recordRequest(stats, Buffer.concat(chunks)) : recordRequest(stats);
			const contentType = result.headers.get('content-type') || 'application/json';
			response.writeHead(result.status, { 'content-type': contentType });
			if (!result.body) { settleRequest(requestStats); return response.end(); }
			const stream = Readable.fromWeb(result.body);
			const usageParser = createUsageParser(contentType, requestStats);
			stream.on('data', chunk => {
				usageParser.consume(chunk);
			});
			stream.on('end', () => {
				usageParser.finish();
				settleRequest(requestStats);
			});
			stream.on('error', () => { usageParser.finish(); settleRequest(requestStats); response.destroy(); });
			response.on('close', () => { usageParser.finish(); settleRequest(requestStats); stream.destroy(); });
			stream.pipe(response);
		};
		server = http.createServer((request, response) => { handle(request, response).catch(() => {
			if (!controller.signal.aborted) status('Network error; retry request');
			if (!response.headersSent) sendError(response, 502, 'Upstream request failed. Retry when network is available.'); else response.destroy();
		}); });
		try {
			status('Connecting');
			await new Promise((resolve, reject) => { server.once('error', reject); server.listen(stats.port, '127.0.0.1', resolve); });
			await authenticate();
			startKeepalive();
		} catch (error) { trace('Connection failed; inspect preceding stage (no credentials logged)'); output.show(true); if (active === controller) stop(); throw error; }
	};
	const actions = { connect, credentials, disconnect: stop, clear: async () => { stop(); await context.secrets.delete('credentials'); await context.secrets.delete('session'); } };
	const reportError = error => vscode.window.showErrorMessage(error?.code === 'EADDRINUSE' ? 'Port 58379 is occupied. Stop the old bridge or disconnect the other VS Code window.' : 'GENAI login failed or timed out. Check GENAI Login output, installed Edge, credentials and MFA.');
	for (const [name, action] of Object.entries(actions)) context.subscriptions.push(vscode.commands.registerCommand(`genai-login.${name}`, async () => {
		try { await action(); } catch (error) { reportError(error); }
	}));
	dashboard = new DashboardProvider(stateSnapshot, actions, reportError);
	context.subscriptions.push(vscode.window.registerWebviewViewProvider('genai-login.session', dashboard), { dispose: () => dashboard.dispose() }, { dispose: stop });
}
function deactivate() { stopActive?.(); }
module.exports = { activate, deactivate };
