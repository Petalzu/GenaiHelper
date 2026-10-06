const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Writable } = require('node:stream');
const { setTimeout: delay } = require('node:timers/promises');
const { createRequestLifetime, forwardBody, transportCode } = require('../bridge-stream');
const http = require('node:http');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const { Agent, fetch } = require('undici');

test('already cancelled or closed connections release listeners immediately', () => {
	for (const closed of [false, true]) {
		const response = new EventEmitter();
		response.destroyed = closed;
		const parent = new AbortController();
		if (!closed) parent.abort();
		const lifetime = createRequestLifetime(response, parent.signal);
		assert.equal(lifetime.signal.aborted, true);
		assert.equal(response.listenerCount('close'), 0);
	}
});

test('HTTP delayed headers, silent body and large slow-consumed output preserve all bytes', { timeout: 20000 }, async () => {
	const payload = Buffer.from('data: ' + JSON.stringify({ choices: [{ delta: { content: '\u5206\u6790'.repeat(4096) } }] }) + '\n\n');
	const count = 256;
	const expected = createHash('sha256');
	for (let index = 0; index < count; index++) expected.update(payload);
	expected.update('data: [DONE]\n\n');
	let serverError;
	const server = http.createServer((request, response) => {
		(async () => {
			await delay(80);
			response.writeHead(200, { 'content-type': 'text/event-stream' });
			response.flushHeaders();
			await delay(80);
			for (let index = 0; index < count; index++) {
				if (!response.write(payload)) await once(response, 'drain');
			}
			response.end('data: [DONE]\n\n');
		})().catch(error => { serverError = error; response.destroy(); });
	});
	const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const actual = createHash('sha256');
	const sink = new Writable({ highWaterMark: 1024, write(chunk, encoding, callback) {
		actual.update(chunk);
		setTimeout(callback, 1);
	} });
	const lifetime = createRequestLifetime(sink, new AbortController().signal);
	try {
		const result = await fetch(`http://127.0.0.1:${server.address().port}`, { dispatcher, signal: lifetime.signal });
		await forwardBody(result.body, sink, lifetime, () => {});
		assert.equal(actual.digest('hex'), expected.digest('hex'));
		assert.equal(serverError, undefined);
	} finally {
		lifetime.dispose();
		await dispatcher.destroy();
		server.closeAllConnections();
		await new Promise(resolve => server.close(resolve));
	}
});

test('cancellation interrupts a silent upstream body and closes its socket', { timeout: 5000 }, async () => {
	let resolveClosed;
	const closed = new Promise(resolve => { resolveClosed = resolve; });
	const server = http.createServer((request, response) => {
		response.on('close', resolveClosed);
		response.writeHead(200, { 'content-type': 'text/event-stream' });
		response.flushHeaders();
	});
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
	const parent = new AbortController();
	const sink = new Writable({ write(chunk, encoding, callback) { callback(); } });
	const lifetime = createRequestLifetime(sink, parent.signal);
	try {
		const result = await fetch(`http://127.0.0.1:${server.address().port}`, { dispatcher, signal: lifetime.signal });
		const forwarding = forwardBody(result.body, sink, lifetime, () => {});
		parent.abort();
		await assert.rejects(forwarding, { name: 'AbortError' });
		await closed;
	} finally {
		lifetime.dispose();
		await dispatcher.destroy();
		server.closeAllConnections();
		await new Promise(resolve => server.close(resolve));
	}
});
test('default idle timeout is disabled even during long silence', context => {
	context.mock.timers.enable({ apis: ['setTimeout'] });
	const response = new EventEmitter();
	const lifetime = createRequestLifetime(response, new AbortController().signal);
	context.mock.timers.tick(24 * 60 * 60 * 1000);
	assert.equal(lifetime.signal.aborted, false);
	response.emit('close');
	assert.equal(lifetime.signal.aborted, true);
	lifetime.dispose();
});

test('activity extends lifetime beyond the original deadline', async context => {
	context.mock.timers.enable({ apis: ['setTimeout'] });
	const response = new EventEmitter();
	const lifetime = createRequestLifetime(response, new AbortController().signal, 100);
	for (let index = 0; index < 10; index++) {
		context.mock.timers.tick(90);
		assert.equal(lifetime.signal.aborted, false);
		lifetime.touch();
	}
	context.mock.timers.tick(101);
	assert.equal(lifetime.signal.reason.name, 'TimeoutError');
	assert.equal(response.listenerCount('close'), 0);
});

test('client disconnect and parent cancellation abort upstream; disposal clears timer', context => {
	context.mock.timers.enable({ apis: ['setTimeout'] });
	for (const action of ['client', 'parent', 'dispose']) {
		const response = new EventEmitter();
		const parent = new AbortController();
		const lifetime = createRequestLifetime(response, parent.signal, 100);
		if (action === 'client') response.emit('close');
		else if (action === 'parent') parent.abort();
		else lifetime.dispose();
		context.mock.timers.tick(101);
		assert.equal(lifetime.signal.aborted, action !== 'dispose');
		assert.equal(response.listenerCount('close'), 0);
	}
});

test('forwarding preserves bytes with a slow consumer', async () => {
	const chunks = [];
	const response = new Writable({ highWaterMark: 1, write(chunk, encoding, callback) {
		chunks.push(chunk.toString());
		delay(2).then(() => callback());
	} });
	const body = new ReadableStream({ start(controller) {
		controller.enqueue(Buffer.from('data: first\n\n'));
		controller.enqueue(Buffer.from('data: [DONE]\n\n'));
		controller.close();
	} });
	let touches = 0;
	await forwardBody(body, response, { signal: new AbortController().signal, touch() { touches++; } }, () => {});
	assert.equal(chunks.join(''), 'data: first\n\ndata: [DONE]\n\n');
	assert.equal(touches, 2);
});

test('upstream failures reject instead of becoming successful truncated responses', async () => {
	const response = new Writable({ write(chunk, encoding, callback) { callback(); } });
	const body = new ReadableStream({ start(controller) { controller.error(new Error('terminated')); } });
	await assert.rejects(forwardBody(body, response, { signal: new AbortController().signal, touch() {} }, () => {}), /terminated/);
	assert.equal(response.destroyed, true);
	assert.equal(transportCode({ cause: { code: 'UND_ERR_SOCKET' } }), 'UND_ERR_SOCKET');
	assert.equal(transportCode({ name: 'secret value' }), 'UNKNOWN');
});

test('single-byte UTF-8 fragments preserve SSE and intentional newlines exactly', async () => {
	const text = '\u4e2d\u6587\u5206\u6790\n\n```js\nconst value = 1;\n```';
	const original = Buffer.from('data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\r\n\r\ndata: [DONE]\n\n');
	const chunks = [];
	const response = new Writable({ write(chunk, encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
	let offset = 0;
	const body = new ReadableStream({ pull(controller) {
		if (offset === original.length) controller.close();
		else controller.enqueue(original.subarray(offset, ++offset));
	} });
	await forwardBody(body, response, { signal: new AbortController().signal, touch() {} }, () => {});
	assert.deepEqual(Buffer.concat(chunks), original);
	assert.equal(JSON.parse(Buffer.concat(chunks).toString().split('\r\n')[0].slice(6)).choices[0].delta.content, text);
});