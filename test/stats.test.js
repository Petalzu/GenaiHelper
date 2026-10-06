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
	test('ignores oversized line suffixes and parses multiline UTF-8 events', () => {
		const stats = createStats(58379);
		const request = recordRequest(stats, Buffer.from('{}'));
		const parser = createUsageParser('text/event-stream', request);
		parser.consume(Buffer.from('data: ' + 'x'.repeat(MAX_SSE_LINE_LENGTH)));
		parser.consume(Buffer.from('data: {"usage":{"prompt_tokens":999999}}\n\n'));
		assert.equal(request.hasUsage, false);
		const event = Buffer.from('data: {"text":"\u4e2d\u6587",\r\ndata: "usage":{"prompt_tokens":13,"completion_tokens":7}}\r\n\r\n');
		for (const byte of event) parser.consume(Buffer.from([byte]));
		parser.finish();
		commitRequest(stats, request);
		assert.equal(stats.tokensIn, 13);
		assert.equal(stats.tokensOut, 7);
	});
	test('uses final cumulative usage and commits once per request', () => {
		const stats = createStats(58379);
		const requestStats = recordRequest(stats, Buffer.from(JSON.stringify({ model: 'gemma4' })));
		const parser = createUsageParser('text/event-stream', requestStats);
		parser.consume(Buffer.from('data: {"usage":{"prompt_tokens":12,"completion_tokens":3}}\n\n'));
		parser.consume(Buffer.from('data: {"usage":{"prompt_tokens":99,"completion_tokens":99}}\n\n'));
		parser.finish();

		assert.equal(commitRequest(stats, requestStats), true);
		assert.equal(commitRequest(stats, requestStats), false);
		assert.deepEqual({ requests: stats.requests, tokensIn: stats.tokensIn, tokensOut: stats.tokensOut, usageReports: stats.usageReports, usageMissing: stats.usageMissing }, { requests: 1, tokensIn: 99, tokensOut: 99, usageReports: 1, usageMissing: 0 });
	});

	test('partial usage preserves earlier fields and missing output stays unknown', () => {
		const stats = createStats(58379);
		assert.equal(recordRequest(stats), undefined);
		assert.equal(stats.requests, 0);
		for (const final of [false, true]) {
			const request = recordRequest(stats, Buffer.from('{"model":"sample"}'));
			const parser = createUsageParser('text/event-stream', request);
			parser.consume(Buffer.from('data: {"usage":{"prompt_tokens":40}}\n\n'));
			if (final) {
				parser.consume(Buffer.from('data: {"usage":{"completion_tokens":'));
				parser.consume(Buffer.from('80}}\n\ndata: {"usage":{"completion_tokens":null}}\n\n'));
			}
			parser.finish();
			commitRequest(stats, request);
		}
		assert.equal(stats.tokensIn, 80);
		assert.equal(stats.tokensOut, 80);
		assert.equal(stats.inputUsageReports, 2);
		assert.equal(stats.outputUsageReports, 1);
	});

	test('bounds model tracking and recovers after an overlong SSE line', () => {
		const stats = createStats(58379);
		for (let index = 0; index < MAX_TRACKED_MODELS + 3; index++) recordRequest(stats, Buffer.from(JSON.stringify({ model: `model-${index}` })));
		assert.equal(stats.models.size, MAX_TRACKED_MODELS);
		assert.equal(stats.otherModels, 3);

		const requestStats = recordRequest(stats, Buffer.from(JSON.stringify({ model: 'after-limit' })));
		const parser = createUsageParser('text/event-stream', requestStats);
		parser.consume(Buffer.from('x'.repeat(MAX_SSE_LINE_LENGTH + 1)));
		parser.consume(Buffer.from('\n\ndata: {"usage":{"prompt_tokens":4,"completion_tokens":2}}\n\n'));
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