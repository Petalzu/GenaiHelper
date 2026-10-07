const { StringDecoder } = require('node:string_decoder');
const { randomUUID } = require('node:crypto');

function createHistory(storage, onError = () => {}) {
	const prefix = 'usageHistory.v1.';
	const key = prefix + randomUUID();
	const own = { requests: 0, tokensIn: 0, tokensOut: 0, inputUsageReports: 0, outputUsageReports: 0 };
	let pending = Promise.resolve();
	const save = () => {
		const snapshot = { ...own };
		pending = pending.then(() => storage.update(key, snapshot)).catch(onError);
	};
	return {
		start() { own.requests++; save(); },
		finish(request) {
			if (!request || request.historyCommitted) return;
			request.historyCommitted = true;
			if (request.hasInput) { own.tokensIn += request.tokensIn; own.inputUsageReports++; }
			if (request.hasOutput) { own.tokensOut += request.tokensOut; own.outputUsageReports++; }
			save();
		},
		snapshot() {
			const total = { ...own };
			for (const storedKey of storage.keys()) {
				if (!storedKey.startsWith(prefix) || storedKey === key) continue;
				const record = storage.get(storedKey);
				for (const field of Object.keys(total)) {
					if (Number.isSafeInteger(record?.[field]) && record[field] >= 0) total[field] += record[field];
				}
			}
			return total;
		},
		flush: () => pending
	};
}
const MAX_TRACKED_MODELS = 64;
const MAX_SSE_LINE_LENGTH = 64 * 1024;
const MAX_JSON_STATS_BODY = 2 * 1024 * 1024;

function createStats(port) {
	return {
		port,
		connectedAt: null,
		requests: 0,
		tokensIn: 0,
		tokensOut: 0,
		usageReports: 0,
		usageMissing: 0,
		inputUsageReports: 0,
		outputUsageReports: 0,
		models: new Map(),
		otherModels: 0
	};
}

function recordRequest(stats, body) {
	if (body === undefined) return undefined;
	stats.requests++;
	let model = 'unknown';
	if (body.length <= MAX_JSON_STATS_BODY) {
		try {
			const parsed = JSON.parse(body.toString('utf8'));
			if (typeof parsed.model === 'string' && parsed.model.length <= 256 && parsed.model) model = parsed.model;
		} catch { model = 'unknown'; }
	}
	const current = stats.models.get(model);
	if (current !== undefined) stats.models.set(model, current + 1);
	else if (stats.models.size < MAX_TRACKED_MODELS) stats.models.set(model, 1);
	else stats.otherModels++;
	return { hasUsage: false, hasInput: false, hasOutput: false, tokensIn: 0, tokensOut: 0, committed: false };
}

function applyUsage(requestStats, usage) {
	if (!usage || !requestStats || requestStats.committed) return;
	const tokensIn = Number.isSafeInteger(usage.prompt_tokens) && usage.prompt_tokens >= 0 ? usage.prompt_tokens : null;
	const tokensOut = Number.isSafeInteger(usage.completion_tokens) && usage.completion_tokens >= 0 ? usage.completion_tokens : null;
	if (tokensIn === null && tokensOut === null) return;
	requestStats.hasUsage = true;
	if (tokensIn !== null) { requestStats.tokensIn = tokensIn; requestStats.hasInput = true; }
	if (tokensOut !== null) { requestStats.tokensOut = tokensOut; requestStats.hasOutput = true; }
}

function commitRequest(stats, requestStats) {
	if (!requestStats || requestStats.committed) return false;
	requestStats.committed = true;
	if (requestStats.hasUsage) {
		stats.usageReports++;
		stats.tokensIn += requestStats.tokensIn;
		stats.tokensOut += requestStats.tokensOut;
		if (requestStats.hasInput) stats.inputUsageReports++;
		if (requestStats.hasOutput) stats.outputUsageReports++;
	} else stats.usageMissing++;
	return true;
}

function createUsageParser(contentType, requestStats) {
	const isEventStream = contentType.toLowerCase().includes('text/event-stream');
	const formatting = { contentChunks: 0, contentNewlines: 0, reasoningAfterContent: 0,
		mixedReasoningContent: 0, reasoningChunks: 0, toolCallChunks: 0, reasoningIdChunks: 0,
		parsedEvents: 0, invalidEvents: 0, droppedEvents: 0, eventStream: isEventStream };
	const contentChoices = new Set();
	let lineBuffer = '';
	let jsonBuffer = '';
	let finished = false;
	const decoder = new StringDecoder('utf8');
	let droppingLine = false;
	let eventData = '';
	let droppingEvent = false;
	const flushEvent = () => {
		if (droppingEvent) formatting.droppedEvents++;
		if (!droppingEvent && eventData.trim() && eventData.trim() !== '[DONE]') {
			try {
				const event = JSON.parse(eventData);
				formatting.parsedEvents++;
				applyUsage(requestStats, event.usage);
				for (const choice of Array.isArray(event.choices) ? event.choices : []) {
					const delta = choice?.delta;
					if (!delta) continue;
					const index = choice.index ?? 0;
					const hasReasoning = [delta.cot_summary, delta.reasoning_text, delta.reasoning_content, delta.reasoning, delta.thinking].some(value => typeof value === 'string' && value.length > 0);
					if (hasReasoning) formatting.reasoningChunks++;
					if (contentChoices.has(index) && hasReasoning) formatting.reasoningAfterContent++;
					if (delta.cot_id || delta.reasoning_opaque || delta.signature) formatting.reasoningIdChunks++;
					if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) formatting.toolCallChunks++;
					if (typeof delta.content === 'string' && delta.content.length > 0) {
						if (hasReasoning) formatting.mixedReasoningContent++;
						formatting.contentChunks++;
						formatting.contentNewlines += (delta.content.match(/\n/g) || []).length;
						if (contentChoices.size < 128) contentChoices.add(index);
					}
				}
			} catch { formatting.invalidEvents++; }
		}
		eventData = '';
		droppingEvent = false;
	};

	const processLine = line => {
		const normalized = line.endsWith('\r') ? line.slice(0, -1) : line;
		if (!normalized) { flushEvent(); return; }
		if (!normalized.startsWith('data:') || normalized.length > MAX_SSE_LINE_LENGTH) return;
		const data = normalized.slice(5).replace(/^ /, '');
		if (droppingEvent) return;
		if (eventData.length + data.length + 1 > MAX_SSE_LINE_LENGTH) { droppingEvent = true; eventData = ''; return; }
		eventData += (eventData ? '\n' : '') + data;
	};

	const consumeEventStream = text => {
		let offset = 0;
		while (offset < text.length) {
			const newline = text.indexOf('\n', offset);
			if (newline < 0) {
				const remaining = text.slice(offset);
				if (!droppingLine) {
					if (lineBuffer.length + remaining.length <= MAX_SSE_LINE_LENGTH) lineBuffer += remaining;
					else { lineBuffer = ''; droppingLine = true; droppingEvent = true; }
				}
				return;
			}
			const segment = text.slice(offset, newline);
			if (!droppingLine && lineBuffer.length + segment.length <= MAX_SSE_LINE_LENGTH) processLine(lineBuffer + segment);
			else droppingEvent = true;
			droppingLine = false;
			lineBuffer = '';
			offset = newline + 1;
		}
	};

	return {
		formatting,
		consume(chunk) {
			if (finished || !requestStats) return;
			const text = decoder.write(chunk);
			if (isEventStream) {
				consumeEventStream(text);
				return;
			}
			if (jsonBuffer !== null) {
				jsonBuffer = jsonBuffer.length + text.length <= MAX_JSON_STATS_BODY ? jsonBuffer + text : null;
			}
		},
		finish() {
			if (finished || !requestStats) return;
			finished = true;
			if (isEventStream) {
				consumeEventStream(decoder.end());
				if (lineBuffer && !droppingLine) processLine(lineBuffer);
				flushEvent();
				lineBuffer = '';
				return;
			}
			if (jsonBuffer !== null) {
				jsonBuffer += decoder.end();
				try { applyUsage(requestStats, JSON.parse(jsonBuffer).usage); } catch {}
			}
			jsonBuffer = '';
		}
	};
}

module.exports = {
	createHistory,
	MAX_TRACKED_MODELS,
	MAX_SSE_LINE_LENGTH,
	MAX_JSON_STATS_BODY,
	createStats,
	recordRequest,
	applyUsage,
	commitRequest,
	createUsageParser
};