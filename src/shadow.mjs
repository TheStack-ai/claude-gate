import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { convertAnthropicToOpenAI } from './format.mjs';
import { callCodexCli, isCodexAvailable } from './codex-bridge.mjs';

const DEFAULT_SHADOW_LOG_PATH = path.join(os.homedir(), '.cc-mux', 'logs', 'shadow.jsonl');

function jaccardSimilarity(a, b) {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const wordsA = new Set(String(a).toLowerCase().split(/\s+/).filter(Boolean));
  const wordsB = new Set(String(b).toLowerCase().split(/\s+/).filter(Boolean));
  if (wordsA.size === 0 && wordsB.size === 0) return 1;
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  return intersection / new Set([...wordsA, ...wordsB]).size;
}

async function fetchCodexResponse(openaiBody, config) {
  const model = config?.openai?.default_model ?? 'gpt-5.4';
  try {
    return await callCodexCli({
      messages: openaiBody.messages || [],
      tools: openaiBody.tools || [],
      model,
    });
  } catch {
    return null;
  }
}

function compareDivergence(anthropicMeta, codexResponse) {
  const divergences = [];

  const codexTools = (codexResponse?.choices?.[0]?.message?.tool_calls ?? [])
    .map(tc => tc.function?.name)
    .filter(Boolean);
  const anthropicTools = anthropicMeta.toolNames ?? [];

  if (codexTools.length > 0 || anthropicTools.length > 0) {
    const aStr = [...anthropicTools].sort().join(',');
    const cStr = [...codexTools].sort().join(',');
    if (aStr !== cStr) {
      divergences.push({
        divergence_type: 'tool_choice',
        anthropic_tool: aStr || null,
        codex_tool: cStr || null,
        similarity_score: jaccardSimilarity(aStr, cStr),
        details: 'different tool selection',
      });
    }
  }

  const codexContent = codexResponse?.choices?.[0]?.message?.content ?? null;
  const anthropicContent = anthropicMeta.textContent || null;

  if (codexContent || anthropicContent) {
    const sim = jaccardSimilarity(codexContent, anthropicContent);
    if (sim < 1) {
      divergences.push({
        divergence_type: 'output_content',
        similarity_score: sim,
        details: sim < 0.7 ? 'significant divergence' : 'minor divergence',
      });
    }
  }

  return divergences;
}

class AnthropicResponseCollector {
  constructor() {
    this.buffer = '';
    this.toolNames = [];
    this.textParts = [];
  }

  push(chunk) {
    this.buffer += chunk.toString('utf8');
    this.buffer = this.buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    let boundary = this.buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const raw = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      this.#parseEvent(raw);
      boundary = this.buffer.indexOf('\n\n');
    }
  }

  getMeta() {
    return {
      toolNames: this.toolNames,
      textContent: this.textParts.join(''),
    };
  }

  #parseEvent(raw) {
    if (!raw) return;
    let eventName = 'message';
    const dataLines = [];
    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim() || eventName;
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (dataLines.length === 0) return;
    const data = dataLines.join('\n');
    if (data === '[DONE]') return;

    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }

    if (eventName === 'content_block_start') {
      const cb = payload?.content_block;
      if (cb?.type === 'tool_use' && cb?.name) {
        this.toolNames.push(cb.name);
      }
    }

    if (eventName === 'content_block_delta') {
      const delta = payload?.delta;
      if (delta?.type === 'text_delta' && delta?.text) {
        this.textParts.push(delta.text);
      }
    }
  }
}

class ShadowContext {
  constructor({ evaluator, classification, bodyBuffer }) {
    this.evaluator = evaluator;
    this.classification = classification;
    this.collector = new AnthropicResponseCollector();
    this.startedAt = evaluator.now();
    this._codexPromise = null;

    let body;
    try {
      body = JSON.parse(bodyBuffer.toString('utf8'));
    } catch {
      this._codexPromise = Promise.resolve(null);
      return;
    }

    const openaiBody = convertAnthropicToOpenAI(body, evaluator.config.openai);
    this._codexPromise = evaluator._fetchCodex(openaiBody, evaluator.config);
  }

  observeChunk(chunk) {
    this.collector.push(chunk);
  }

  complete() {
    return this._doComplete().catch(err => {
      this.evaluator.log.error?.('[shadow] complete error', { error: err.message });
    });
  }

  async _doComplete() {
    const codexResponse = await this._codexPromise;
    const completedAt = this.evaluator.now();
    const anthropicMeta = this.collector.getMeta();
    const base = {
      ts: new Date(this.startedAt).toISOString(),
      session_id: this.classification.sessionId,
      request_id: this.classification.requestId,
      query_source: this.classification.querySource,
      duration_ms: completedAt - this.startedAt,
    };

    if (!codexResponse) {
      await this.evaluator._logResult({ ...base, status: 'error', error: 'no_response' });
      return;
    }

    if (codexResponse.error) {
      await this.evaluator._logResult({
        ...base,
        status: 'error',
        error: codexResponse.error?.message ?? JSON.stringify(codexResponse.error),
      });
      return;
    }

    const divergences = compareDivergence(anthropicMeta, codexResponse);
    const minSim = divergences.length > 0
      ? Math.min(...divergences.map(d => d.similarity_score))
      : 1;

    await this.evaluator._logResult({
      ...base,
      model_anthropic: this.classification.model,
      model_codex: codexResponse.model ?? this.evaluator.config.openai?.default_model,
      status: 'ok',
      divergences,
      min_similarity: minSim,
      warning: minSim < 0.7,
      codex_usage: codexResponse.usage ?? null,
    });
  }
}

export class ShadowEvaluator {
  constructor(options = {}) {
    this.config = options.config ?? {};
    this.logPath = options.logPath ?? DEFAULT_SHADOW_LOG_PATH;
    this.log = options.log ?? console;
    this.now = options.now ?? Date.now;
    this._fetchCodex = options.fetchCodex ?? fetchCodexResponse;
  }

  isEnabled() {
    if (!this.config.shadow?.enabled) return false;
    return true;
  }

  async checkCodexAvailable() {
    if (this._codexAvailable !== undefined) return this._codexAvailable;
    this._codexAvailable = await isCodexAvailable();
    return this._codexAvailable;
  }

  maybeStart(classification, bodyBuffer) {
    if (!this.isEnabled()) return null;
    if (!classification?.shadowEligible) return null;
    return new ShadowContext({ evaluator: this, classification, bodyBuffer });
  }

  async _logResult(record) {
    try {
      await fs.mkdir(path.dirname(this.logPath), { recursive: true });
      await fs.appendFile(this.logPath, JSON.stringify(record) + '\n', 'utf8');
    } catch (err) {
      this.log.error?.('[shadow] log write error', { error: err.message });
    }
  }
}

export function createShadowEvaluator(options) {
  return new ShadowEvaluator(options);
}
