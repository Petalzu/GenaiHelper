const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHistory } = require('../stats');

test('history survives reloads, merges independent writers and settles once', async () => {
	const records = new Map();
	const storage = { keys: () => [...records.keys()], get: key => records.get(key), update: async (key, value) => { records.set(key, value); } };
	const first = createHistory(storage);
	const second = createHistory(storage);
	first.start(); second.start(); first.start();
	const request = { hasInput: true, hasOutput: true, tokensIn: 12, tokensOut: 30 };
	first.finish(request); first.finish(request);
	second.finish({ hasInput: true, tokensIn: 5 });
	await Promise.all([first.flush(), second.flush()]);
	assert.deepEqual(createHistory(storage).snapshot(), { requests: 3, tokensIn: 17, tokensOut: 30, inputUsageReports: 2, outputUsageReports: 1 });
	assert.equal(first.snapshot().requests, 3);
});

test('failed persistence is reported and does not poison later updates', async () => {
	let updates = 0, errors = 0;
	const history = createHistory({ keys: () => [], get() {}, update: async () => { if (++updates === 1) throw Error('disk'); } }, () => { errors++; });
	history.start(); history.start(); await history.flush();
	assert.equal(errors, 1);
	assert.equal(updates, 2);
	assert.equal(history.snapshot().requests, 2);
});