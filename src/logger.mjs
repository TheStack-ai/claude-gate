import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_RETENTION_DAYS = 7;
const DEFAULT_LOG_PATH = path.join(os.homedir(), '.claude-gate', 'logs', 'metrics.jsonl');

function headerValue(headers, name) {
  const value = headers?.[name];
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value ?? null;
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function cacheHitRate(cacheRead, inputTokens) {
  const denominator = cacheRead + inputTokens;
  if (denominator <= 0) {
    return 0;
  }

  return cacheRead / denominator;
}

function compactTimestamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function mergeUsage(target, usage) {
  if (!usage || typeof usage !== 'object') {
    return;
  }

  if ('input_tokens' in usage) {
    target.input_tokens = toNumber(usage.input_tokens);
  }

  if ('prompt_tokens' in usage) {
    target.input_tokens = toNumber(usage.prompt_tokens);
  }

  if ('output_tokens' in usage) {
    target.output_tokens = toNumber(usage.output_tokens);
  }

  if ('completion_tokens' in usage) {
    target.output_tokens = toNumber(usage.completion_tokens);
  }

  if ('cache_read_input_tokens' in usage) {
    target.cache_read = toNumber(usage.cache_read_input_tokens);
  }

  if ('cache_creation_input_tokens' in usage) {
    target.cache_write = toNumber(usage.cache_creation_input_tokens);
  }
}

function createBaseRecord({ sessionId, requestId, requestStartedAt, routedTo }) {
  return {
    ts: new Date(requestStartedAt).toISOString(),
    session_id: sessionId ?? 'unknown',
    request_id: requestId ?? null,
    query_source: null,
    model: null,
    input_tokens: 0,
    output_tokens: 0,
    cache_read: 0,
    cache_write: 0,
    cache_hit_rate: 0,
    ttfb_ms: null,
    duration_ms: null,
    tool_count: 0,
    message_count: 0,
    is_retry: false,
    speed: null,
    thinking: false,
    routed_to: routedTo ?? 'anthropic',
    status: null,
  };
}

class SseEventParser {
  constructor(onEvent) {
    this.buffer = '';
    this.onEvent = onEvent;
  }

  push(chunk) {
    this.buffer += chunk.toString('utf8');
    this.buffer = this.buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    let boundary = this.buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const rawEvent = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      this.#emit(rawEvent);
      boundary = this.buffer.indexOf('\n\n');
    }
  }

  #emit(rawEvent) {
    if (!rawEvent) {
      return;
    }

    let eventName = 'message';
    const dataLines = [];

    for (const line of rawEvent.split('\n')) {
      if (line.startsWith('event:')) {
        eventName = line.slice('event:'.length).trim() || eventName;
        continue;
      }

      if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).trimStart());
      }
    }

    if (dataLines.length === 0) {
      return;
    }

    const data = dataLines.join('\n');
    if (data === '[DONE]') {
      return;
    }

    try {
      this.onEvent(eventName, JSON.parse(data));
    } catch {
      // Ignore malformed SSE payloads; metrics logging is best-effort.
    }
  }
}

export class TurnMetricsCollector {
  constructor({ logger, sessionId, requestId, requestStartedAt, routedTo }) {
    this.logger = logger;
    this.record = createBaseRecord({
      sessionId,
      requestId,
      requestStartedAt,
      routedTo,
    });
    this.requestStartedAt = requestStartedAt;
    this.firstByteAt = null;
    this.now = logger.now;
    this.isSse = false;
    this.finalized = false;
    this.sseParser = new SseEventParser((eventName, payload) => {
      this.#handleSseEvent(eventName, payload);
    });
  }

  setClassification(classification = {}) {
    this.record.session_id = classification.sessionId ?? this.record.session_id;
    this.record.request_id = classification.requestId ?? this.record.request_id;
    this.record.query_source = classification.querySource ?? this.record.query_source;
    this.record.model = classification.model ?? this.record.model;
    this.record.tool_count = classification.toolCount ?? this.record.tool_count;
    this.record.message_count = classification.messageCount ?? this.record.message_count;
    this.record.is_retry = classification.isRetry ?? this.record.is_retry;
    this.record.speed = classification.speed ?? this.record.speed;
    this.record.thinking = classification.thinking ?? this.record.thinking;
  }

  setResponseInfo({ status, headers = {} } = {}) {
    this.record.status = status ?? this.record.status;
    const contentType = String(headerValue(headers, 'content-type') ?? '').toLowerCase();
    const contentEncoding = String(headerValue(headers, 'content-encoding') ?? '').toLowerCase();
    this.isSse = contentType.includes('text/event-stream') && !contentEncoding.includes('gzip');
  }

  setRoutedTo(routedTo) {
    if (!routedTo) {
      return;
    }

    this.record.routed_to = routedTo;
  }

  addUsage(usage) {
    mergeUsage(this.record, usage);
  }

  observeChunk(chunk) {
    if (!this.firstByteAt) {
      this.firstByteAt = this.now();
      this.record.ttfb_ms = this.firstByteAt - this.requestStartedAt;
    }

    if (this.isSse) {
      this.sseParser.push(chunk);
    }
  }

  async finalize({ status } = {}) {
    if (this.finalized) {
      return this.record;
    }

    this.finalized = true;
    this.record.status = status ?? this.record.status;
    this.record.duration_ms = this.now() - this.requestStartedAt;
    this.record.cache_hit_rate = cacheHitRate(this.record.cache_read, this.record.input_tokens);
    return this.logger.recordTurn(this.record);
  }

  #handleSseEvent(eventName, payload) {
    if (eventName === 'message_start') {
      const message = payload?.message ?? payload;
      this.record.model = message?.model ?? this.record.model;
      mergeUsage(this.record, message?.usage ?? payload?.usage);
      return;
    }

    if (eventName === 'message_delta') {
      mergeUsage(this.record, payload?.usage);
    }
  }
}

export class MetricsLogger {
  constructor(options = {}) {
    this.logPath = options.logPath ?? DEFAULT_LOG_PATH;
    this.retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
    this.now = options.now ?? Date.now;
    this.sessionState = new Map();
    this.writeChain = Promise.resolve();
  }

  createTurnContext({ sessionId, requestId, requestStartedAt = this.now(), routedTo = 'anthropic' } = {}) {
    return new TurnMetricsCollector({
      logger: this,
      sessionId,
      requestId,
      requestStartedAt,
      routedTo,
    });
  }

  async recordTurn(record) {
    return this.#enqueue(async () => {
      await this.#ensureReady();
      const enriched = this.#withSessionAggregates(record);
      await fs.appendFile(this.logPath, `${JSON.stringify(enriched)}\n`, 'utf8');
      return enriched;
    });
  }

  async close() {
    await this.writeChain;
  }

  async #enqueue(task) {
    const next = this.writeChain.then(task, task);
    this.writeChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async #ensureReady() {
    await fs.mkdir(path.dirname(this.logPath), { recursive: true });
    await this.#rotateIfNeeded();
    await this.#purgeOldArchives();
  }

  async #rotateIfNeeded() {
    let stats;
    try {
      stats = await fs.stat(this.logPath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return;
      }

      throw error;
    }

    const retentionMs = this.retentionDays * 24 * 60 * 60 * 1000;
    const now = this.now();
    if (now - stats.mtimeMs < retentionMs) {
      return;
    }

    const parsed = path.parse(this.logPath);
    const archivePath = path.join(parsed.dir, `${parsed.name}.${compactTimestamp(new Date(now))}${parsed.ext}`);
    await fs.rename(this.logPath, archivePath);
  }

  async #purgeOldArchives() {
    const directory = path.dirname(this.logPath);
    const parsed = path.parse(this.logPath);
    const retentionMs = this.retentionDays * 24 * 60 * 60 * 1000;
    const now = this.now();
    const entries = await fs.readdir(directory, { withFileTypes: true });

    await Promise.all(entries.map(async (entry) => {
      if (!entry.isFile()) {
        return;
      }

      if (!entry.name.startsWith(`${parsed.name}.`) || !entry.name.endsWith(parsed.ext)) {
        return;
      }

      const entryPath = path.join(directory, entry.name);
      const stats = await fs.stat(entryPath);
      if (now - stats.mtimeMs > retentionMs) {
        await fs.unlink(entryPath);
      }
    }));
  }

  #withSessionAggregates(record) {
    const sessionId = record.session_id ?? 'unknown';
    const state = this.sessionState.get(sessionId) ?? {
      total_input_tokens: 0,
      total_output_tokens: 0,
      cache_hit_rate_sum: 0,
      retry_count: 0,
      agent_request_count: 0,
      turns: 0,
      last_input_tokens: null,
      context_growth_sum: 0,
    };

    state.turns += 1;
    state.total_input_tokens += toNumber(record.input_tokens);
    state.total_output_tokens += toNumber(record.output_tokens);
    state.cache_hit_rate_sum += Number(record.cache_hit_rate) || 0;

    if (record.is_retry) {
      state.retry_count += 1;
    }

    if (typeof record.query_source === 'string' && record.query_source.startsWith('agent:')) {
      state.agent_request_count += 1;
    }

    if (state.last_input_tokens !== null) {
      state.context_growth_sum += toNumber(record.input_tokens) - state.last_input_tokens;
    }

    state.last_input_tokens = toNumber(record.input_tokens);
    this.sessionState.set(sessionId, state);

    return {
      ...record,
      total_input_tokens: state.total_input_tokens,
      total_output_tokens: state.total_output_tokens,
      avg_cache_hit_rate: state.turns > 0 ? state.cache_hit_rate_sum / state.turns : 0,
      retry_count: state.retry_count,
      agent_request_ratio: state.turns > 0 ? state.agent_request_count / state.turns : 0,
      turns: state.turns,
      context_growth_rate: state.turns > 1 ? state.context_growth_sum / (state.turns - 1) : 0,
    };
  }
}
