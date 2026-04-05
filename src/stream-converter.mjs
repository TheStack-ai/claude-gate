/**
 * OpenAI SSE -> Anthropic SSE streaming conversion.
 *
 * Transforms an OpenAI chat completion stream into the Anthropic message
 * streaming event sequence. Handles text content and incremental tool_calls.
 *
 * Required Anthropic event sequence:
 *   message_start → content_block_start → content_block_delta →
 *   content_block_stop → message_delta → message_stop
 */

import { PassThrough, Transform } from 'node:stream';

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

function sseFrame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function openaiSseFrame(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function openaiDoneFrame() {
  return 'data: [DONE]\n\n';
}

function collectStream(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

function normalizeOpenAITextContent(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((part) => {
      if (typeof part === 'string') {
        return part;
      }

      if (part?.type === 'text' || part?.type === 'output_text') {
        return part.text ?? '';
      }

      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function buildSyntheticOpenAISse(openaiResponse) {
  const choice = openaiResponse?.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const payloadId = openaiResponse?.id ?? `chatcmpl_proxy_${Date.now()}`;
  const chunks = [];
  const text = normalizeOpenAITextContent(message.content);
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

  if (text || toolCalls.length > 0) {
    const delta = { role: 'assistant' };

    if (text) {
      delta.content = text;
    }

    if (toolCalls.length > 0) {
      delta.tool_calls = toolCalls.map((toolCall, index) => ({
        index,
        id: toolCall.id,
        type: toolCall.type ?? 'function',
        function: {
          name: toolCall.function?.name ?? '',
          arguments: toolCall.function?.arguments ?? '',
        },
      }));
    }

    chunks.push(openaiSseFrame({
      id: payloadId,
      choices: [{ index: 0, delta }],
    }));
  }

  chunks.push(openaiSseFrame({
    id: payloadId,
    choices: [{
      index: 0,
      delta: {},
      finish_reason: choice.finish_reason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
    }],
    usage: openaiResponse?.usage,
  }));
  chunks.push(openaiDoneFrame());

  return chunks.join('');
}

function parseOpenAISseChunk(raw) {
  const lines = raw.split('\n');
  const dataLines = [];

  for (const line of lines) {
    if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trimStart());
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  const data = dataLines.join('\n');
  if (data === '[DONE]') {
    return { done: true };
  }

  try {
    return { done: false, payload: JSON.parse(data) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Stop reason mapping
// ---------------------------------------------------------------------------

function mapStopReason(finishReason) {
  if (finishReason === 'tool_calls') {
    return 'tool_use';
  }

  if (finishReason === 'length') {
    return 'max_tokens';
  }

  return 'end_turn';
}

// ---------------------------------------------------------------------------
// OpenAIToAnthropicStream
// ---------------------------------------------------------------------------

/**
 * Transform stream that reads raw OpenAI SSE bytes and emits Anthropic SSE bytes.
 *
 * Options:
 *   model    — model name to embed in message_start
 *   inputTokens — prompt_tokens (known before streaming starts)
 */
export class OpenAIToAnthropicStream extends Transform {
  constructor({ model = 'unknown', inputTokens = 0 } = {}) {
    super({ readableObjectMode: false, writableObjectMode: false });

    this._model = model;
    this._inputTokens = inputTokens;
    this._outputTokens = 0;

    // State
    this._started = false;       // message_start emitted?
    this._textBlockOpen = false;  // text content_block is open?
    this._textBlockIndex = 0;

    // Tool call tracking: Map<toolCallIndex, { id, name, argsBuffer, blockIndex, started }>
    this._toolCalls = new Map();
    this._nextBlockIndex = 0;

    // SSE parser buffer
    this._sseBuffer = '';
  }

  // -----------------------------------------------------------------------
  // Transform implementation
  // -----------------------------------------------------------------------

  _transform(chunk, _encoding, callback) {
    this._sseBuffer += chunk.toString('utf8');
    this._sseBuffer = this._sseBuffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    let boundary = this._sseBuffer.indexOf('\n\n');
    while (boundary !== -1) {
      const rawEvent = this._sseBuffer.slice(0, boundary);
      this._sseBuffer = this._sseBuffer.slice(boundary + 2);
      this._processRawEvent(rawEvent);
      boundary = this._sseBuffer.indexOf('\n\n');
    }

    callback();
  }

  _flush(callback) {
    // Flush any remaining partial buffer
    if (this._sseBuffer.trim()) {
      this._processRawEvent(this._sseBuffer);
      this._sseBuffer = '';
    }

    // Close open blocks and message
    this._closeOpenBlocks();
    this._emitMessageEnd(null);
    callback();
  }

  // -----------------------------------------------------------------------
  // SSE event processing
  // -----------------------------------------------------------------------

  _processRawEvent(raw) {
    const parsed = parseOpenAISseChunk(raw);
    if (!parsed) {
      return;
    }

    if (parsed.done) {
      this._closeOpenBlocks();
      this._emitMessageEnd(null);
      return;
    }

    const payload = parsed.payload;
    const choice = payload?.choices?.[0];
    if (!choice) {
      return;
    }

    // Emit message_start on first chunk
    if (!this._started) {
      this._emitMessageStart(payload);
      this._started = true;
    }

    const delta = choice.delta ?? {};
    const finishReason = choice.finish_reason ?? null;

    // Text content
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      this._handleTextDelta(delta.content);
    }

    // Tool calls
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        this._handleToolCallDelta(tc);
      }
    }

    // Usage in final chunk (some providers include it)
    if (payload.usage) {
      this._outputTokens = payload.usage.completion_tokens ?? this._outputTokens;
      this._inputTokens = payload.usage.prompt_tokens ?? this._inputTokens;
    }

    // Finish reason
    if (finishReason) {
      this._closeOpenBlocks();
      this._emitMessageEnd(finishReason);
    }
  }

  // -----------------------------------------------------------------------
  // Anthropic event emitters
  // -----------------------------------------------------------------------

  _emitMessageStart(payload) {
    this.push(sseFrame('message_start', {
      type: 'message_start',
      message: {
        id: payload?.id ?? `msg_proxy_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        model: this._model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: this._inputTokens,
          output_tokens: 0,
        },
      },
    }));
  }

  _handleTextDelta(text) {
    if (!this._textBlockOpen) {
      this._textBlockIndex = this._nextBlockIndex++;
      this.push(sseFrame('content_block_start', {
        type: 'content_block_start',
        index: this._textBlockIndex,
        content_block: { type: 'text', text: '' },
      }));
      this._textBlockOpen = true;
    }

    this._outputTokens++;

    this.push(sseFrame('content_block_delta', {
      type: 'content_block_delta',
      index: this._textBlockIndex,
      delta: { type: 'text_delta', text },
    }));
  }

  _handleToolCallDelta(tc) {
    const tcIndex = tc.index ?? 0;

    if (!this._toolCalls.has(tcIndex)) {
      // Close text block if open — tool blocks come after text
      if (this._textBlockOpen) {
        this.push(sseFrame('content_block_stop', {
          type: 'content_block_stop',
          index: this._textBlockIndex,
        }));
        this._textBlockOpen = false;
      }

      const blockIndex = this._nextBlockIndex++;
      const entry = {
        id: tc.id ?? `toolu_${Date.now()}_${tcIndex}`,
        name: tc.function?.name ?? '',
        argsBuffer: '',
        blockIndex,
        started: false,
      };
      this._toolCalls.set(tcIndex, entry);
    }

    const entry = this._toolCalls.get(tcIndex);

    // Update id/name if provided in this delta
    if (tc.id) {
      entry.id = tc.id;
    }

    if (tc.function?.name) {
      entry.name = tc.function.name;
    }

    // Emit content_block_start once we have the name
    if (!entry.started && entry.name) {
      this.push(sseFrame('content_block_start', {
        type: 'content_block_start',
        index: entry.blockIndex,
        content_block: {
          type: 'tool_use',
          id: entry.id,
          name: entry.name,
        },
      }));
      entry.started = true;
    }

    // Accumulate and emit argument deltas
    if (typeof tc.function?.arguments === 'string' && tc.function.arguments.length > 0) {
      entry.argsBuffer += tc.function.arguments;

      // Emit as input_json_delta
      this.push(sseFrame('content_block_delta', {
        type: 'content_block_delta',
        index: entry.blockIndex,
        delta: {
          type: 'input_json_delta',
          partial_json: tc.function.arguments,
        },
      }));
    }
  }

  _closeOpenBlocks() {
    // Close text block
    if (this._textBlockOpen) {
      this.push(sseFrame('content_block_stop', {
        type: 'content_block_stop',
        index: this._textBlockIndex,
      }));
      this._textBlockOpen = false;
    }

    // Close tool call blocks
    for (const [, entry] of this._toolCalls) {
      if (entry.started) {
        this.push(sseFrame('content_block_stop', {
          type: 'content_block_stop',
          index: entry.blockIndex,
        }));
      }
    }

    this._toolCalls.clear();
  }

  _emitMessageEnd(finishReason) {
    if (this._messageEnded) {
      return;
    }

    this._messageEnded = true;

    this.push(sseFrame('message_delta', {
      type: 'message_delta',
      delta: {
        stop_reason: finishReason ? mapStopReason(finishReason) : 'end_turn',
        stop_sequence: null,
      },
      usage: {
        output_tokens: this._outputTokens,
      },
    }));

    this.push(sseFrame('message_stop', {
      type: 'message_stop',
    }));
  }
}

/**
 * Creates a Transform stream that converts OpenAI SSE to Anthropic SSE.
 *
 * @param {object} options
 * @param {string} options.model - Model name
 * @param {number} options.inputTokens - Prompt tokens (if known)
 * @returns {OpenAIToAnthropicStream}
 */
export function createStreamConverter(options = {}) {
  return new OpenAIToAnthropicStream(options);
}

export async function convertOpenAIResponseToAnthropicSse(openaiResponse, { model, inputTokens } = {}) {
  const converter = createStreamConverter({
    model: model ?? openaiResponse?.model ?? 'unknown',
    inputTokens: inputTokens ?? openaiResponse?.usage?.prompt_tokens ?? 0,
  });
  const input = new PassThrough();
  const outputPromise = collectStream(converter);

  input.pipe(converter);
  input.end(buildSyntheticOpenAISse(openaiResponse));

  return outputPromise;
}
