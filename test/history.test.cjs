const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHistory } = require('../stats');
const { createStats, recordRequest, applyUsage, commitRequest, createUsageParser } = require('../stats');

test('final stream cache usage settles once and persists model costs', async () => {
	const stats = createStats(58379);
	const request = recordRequest(stats, Buffer.from('{"model":"DeepSeek-V4.1-Flash"}'), Date.parse('2026-10-08T00:00:00Z'));
	const parser = createUsageParser('text/event-stream', request);
	parser.consume(Buffer.from('data: {"usage":{"prompt_tokens":1000,"completion_tokens":1}}\n\n'));
	parser.consume(Buffer.from('data: {"usage":{"prompt_tokens":1000,"completion_tokens":100,"prompt_tokens_details":{"cached_tokens":800}}}\n\n'));
	parser.finish();
	commitRequest(stats, request);
	commitRequest(stats, request);
	const usage = stats.modelUsage.get(request.model);
	assert.equal(usage.requests, 1);
	assert.equal(usage.cachedTokens, 800);
	assert.equal(usage.cacheInputTokens, 1000);
	assert.equal(usage.pricedReports, 1);
	assert.ok(Math.abs(usage.costMin - 0.0000924) < 1e-12);
	assert.equal(usage.costMax, usage.costMin);
	assert.equal(usage.offPeakCost, usage.costMin);
	assert.equal(usage.timedReports, 1);
	const records = new Map();
	const storage = { keys: () => [...records.keys()], get: key => records.get(key), update: async (key, value) => records.set(key, value) };
	const history = createHistory(storage);
	history.start(); history.finish(request); history.finish(request);
	await history.flush();
	assert.deepEqual(createHistory(storage).snapshot().modelUsage, [{ name: request.model, ...usage }]);
});

test('pricing uses request start UTC boundaries, weekdays and no holiday exceptions', () => {
	for (const [time, multiplier] of [
		['2026-10-08T00:59:59Z', 1], ['2026-10-08T01:00:00Z', 2],
		['2026-10-08T03:59:59Z', 2], ['2026-10-08T04:00:00Z', 1],
		['2026-10-08T05:59:59Z', 1], ['2026-10-08T06:00:00Z', 2],
		['2026-10-08T09:59:59Z', 2], ['2026-10-08T10:00:00Z', 1],
		['2026-10-10T02:00:00Z', 1], ['2026-10-11T07:00:00Z', 1],
		['2026-10-01T02:00:00Z', 2], ['2026-10-09T09:00:00+08:00', 2]
	]) {
		const stats = createStats(58379);
		const request = recordRequest(stats, Buffer.from('{"model":"DeepSeek-V4.1-Flash"}'), Date.parse(time));
		applyUsage(request, { prompt_tokens: 1000000, completion_tokens: 1000000, prompt_cache_hit_tokens: 0 });
		commitRequest(stats, request);
		const usage = stats.modelUsage.get(request.model);
		assert.equal(usage.costMin, 0.75 * multiplier, time);
		assert.equal(usage.costMax, usage.costMin, time);
		assert.equal(usage.peakCost, multiplier === 2 ? 1.5 : 0, time);
		assert.equal(usage.offPeakCost, multiplier === 1 ? 0.75 : 0, time);
	}
});

test('saved historical peak price is read unchanged without activation writes', async () => {
	const saved = { modelUsage: [{ name: 'DeepSeek-V4.1-Flash', tokensIn: 1000000, tokensOut: 1000000, cachedTokens: 900000, inputUsageReports: 1, outputUsageReports: 1, pricedReports: 1, timedReports: 1, costMin: 16.964512, costMax: 16.964512, peakCost: 16.964512 }] };
	let writes = 0;
	const history = createHistory({ get: key => key === 'usageHistory.summary.v2' ? saved : undefined, update: async () => { writes++; } });
	await history.flush();
	assert.equal(writes, 0);
	const usage = history.snapshot().modelUsage[0];
	assert.equal(usage.cachedTokens, 900000);
	assert.equal(usage.costMin, 16.964512);
	assert.equal(usage.costMax, usage.costMin);
	assert.equal(usage.timedReports, 1);
	assert.equal(usage.peakCost, usage.costMin);
});

test('missing and invalid cache use 90 percent while valid cache remains actual', () => {
	const stats = createStats(58379);
	for (const cached of [undefined, -1, 101, 0, 50]) {
		const request = recordRequest(stats, Buffer.from('{"model":"DeepSeek-V4.1-Flash"}'));
		applyUsage(request, { prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: cached });
		commitRequest(stats, request);
	}
	const usage = stats.modelUsage.get('DeepSeek-V4.1-Flash');
	assert.equal(usage.requests, 5);
	assert.equal(usage.tokensIn, 500);
	assert.equal(usage.cacheReports, 5);
	assert.equal(usage.cacheInputTokens, 500);
	assert.equal(usage.cachedTokens, 320);
	assert.equal(usage.pricedReports, 5);
	const other = recordRequest(stats, Buffer.from('{"model":"other"}'));
	applyUsage(other, { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 100 } });
	commitRequest(stats, other);
	assert.equal(stats.modelUsage.get('other').pricedReports, 0);
});

test('history shares one in-process accumulator and settles once', async () => {
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

test('published model rates price cache, flat input and CNY conversion independently', () => {
	for (const [model, expected] of [
		['gemma-4-31B-it', 0.394], ['gpt-oss-120b', 0.207],
		['Qwen3.8-27B', 2.669], ['Qwen3.5-397B-A17B', 3.243],
		['GLM-5.3-Flash', 0.542], ['GLM-OCR', 0.4 / 6.711932]
	]) {
		for (const time of ['2026-10-08T02:00:00Z', '2026-10-08T12:00:00Z']) {
			const stats = createStats(58379);
			const request = recordRequest(stats, Buffer.from(JSON.stringify({ model })), Date.parse(time));
			applyUsage(request, { prompt_tokens: 1000000, completion_tokens: 1000000, prompt_cache_hit_tokens: 900000 });
			commitRequest(stats, request);
			const usage = stats.modelUsage.get(model);
			assert.equal(usage.pricedReports, 1, model);
			assert.ok(Math.abs(usage.costMin - expected) < 1e-12, model);
			assert.equal(usage.costMax, usage.costMin, model);
		}
	}
});

test('summary survives fresh storage reload without rewriting', async () => {
	const legacy = { requests: 1495, tokensIn: 383062746, tokensOut: 2451141, inputUsageReports: 1495, outputUsageReports: 1495 };
	const records = new Map([['usageHistory.summary.v2', legacy]]);
	const storage = () => ({ keys: () => [...records.keys()], get: key => records.get(key), update: async (key, value) => {
		if (value === undefined) records.delete(key);
		else records.set(key, value);
	} });
	const history = createHistory(storage());
	await history.flush();
	assert.deepEqual([...records.keys()], ['usageHistory.summary.v2']);
	const saved = records.get('usageHistory.summary.v2');
	assert.equal(saved.backfill, undefined);
	assert.equal(saved.tokensIn + saved.tokensOut, 385513887);
	assert.deepEqual(saved, legacy);
	assert.deepEqual(createHistory(storage()).snapshot(), saved);
});