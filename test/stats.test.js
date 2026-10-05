const assert = require('assert');
const {
	MAX_TRACKED_MODELS,
	MAX_SSE_LINE_LENGTH,
	createStats,
	recordRequest,
	commitRequest,
	createUsageParser
} = require('../stats');

suite('Statistics', () => {
	test('accumulates usage once per request', () => {
		const stats = createStats(58379);
		const requestStats = recordRequest(stats, Buffer.from(JSON.stringify({ model: 'gemma4' })));
		const parser = createUsageParser('text/event-stream', requestStats);
		parser.consume(Buffer.from('data: {"usage":{"prompt_tokens":12,"completion_tokens":3}}\n'));
		parser.consume(Buffer.from('data: {"usage":{"prompt_tokens":99,"completion_tokens":99}}\n'));
		parser.finish();

		assert.equal(commitRequest(stats, requestStats), true);
		assert.equal(commitRequest(stats, requestStats), false);
		assert.deepEqual({ requests: stats.requests, tokensIn: stats.tokensIn, tokensOut: stats.tokensOut, usageReports: stats.usageReports, usageMissing: stats.usageMissing }, { requests: 1, tokensIn: 12, tokensOut: 3, usageReports: 1, usageMissing: 0 });
	});

	test('bounds model tracking and recovers after an overlong SSE line', () => {
		const stats = createStats(58379);
		for (let index = 0; index < MAX_TRACKED_MODELS + 3; index++) recordRequest(stats, Buffer.from(JSON.stringify({ model: `model-${index}` })));
		assert.equal(stats.models.size, MAX_TRACKED_MODELS);
		assert.equal(stats.otherModels, 3);

		const requestStats = recordRequest(stats, Buffer.from(JSON.stringify({ model: 'after-limit' })));
		const parser = createUsageParser('text/event-stream', requestStats);
		parser.consume(Buffer.from('x'.repeat(MAX_SSE_LINE_LENGTH + 1)));
		parser.consume(Buffer.from('\ndata: {"usage":{"prompt_tokens":4,"completion_tokens":2}}\n'));
		parser.finish();
		commitRequest(stats, requestStats);

		assert.equal(stats.tokensIn, 4);
		assert.equal(stats.tokensOut, 2);
		assert.equal(stats.usageReports, 1);
	});

	test('records missing usage without inventing token counts', () => {
		const stats = createStats(58379);
		const requestStats = recordRequest(stats, Buffer.from(JSON.stringify({ model: 'no-usage' })));
		const parser = createUsageParser('application/json', requestStats);
		parser.consume(Buffer.from('{"choices":[]}'));
		parser.finish();
		commitRequest(stats, requestStats);

		assert.equal(stats.tokensIn, 0);
		assert.equal(stats.tokensOut, 0);
		assert.equal(stats.usageReports, 0);
		assert.equal(stats.usageMissing, 1);
	});
});