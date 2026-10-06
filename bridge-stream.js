const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

function createRequestLifetime(response, parentSignal, idleMs = 0) {
	const controller = new AbortController();
	const signal = AbortSignal.any([parentSignal, controller.signal]);
	let timer;
	let disposed = false;
	const touch = () => {
		clearTimeout(timer);
		if (disposed || signal.aborted || idleMs === 0) return;
		timer = setTimeout(() => controller.abort(new DOMException('Upstream idle timeout', 'TimeoutError')), idleMs);
		timer.unref?.();
	};
	const cancel = () => {
		if (!response.writableFinished) controller.abort(new DOMException('Client disconnected', 'AbortError'));
	};
	const dispose = () => {
		disposed = true;
		clearTimeout(timer);
		response.off('close', cancel);
		signal.removeEventListener('abort', dispose);
	};
	response.once('close', cancel);
	signal.addEventListener('abort', dispose, { once: true });
	if (response.destroyed) cancel();
	if (signal.aborted) dispose();
	touch();
	return { signal, touch, dispose };
}

async function forwardBody(body, response, lifetime, consume) {
	const monitor = new Transform({
		transform(chunk, encoding, callback) {
			lifetime.touch();
			try { consume(chunk); callback(null, chunk); } catch (error) { callback(error); }
		}
	});
	await pipeline(Readable.fromWeb(body), monitor, response, { signal: lifetime.signal });
}

function transportCode(error) {
	const code = error?.cause?.code || error?.code || error?.name;
	return typeof code === 'string' && /^[A-Za-z0-9_]+$/.test(code) ? code : 'UNKNOWN';
}

module.exports = { createRequestLifetime, forwardBody, transportCode };