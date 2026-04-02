import { convertAnthropicToOpenAI } from './format.mjs';
import { callCodexCli } from './codex-bridge.mjs';

const DEFAULT_OPENAI_MODEL = 'gpt-5.4';

function normalizeTextContent(content) {
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

      if (part?.type === 'text') {
        return part.text ?? '';
      }

      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function mapFinishReason(finishReason) {
  if (finishReason === 'tool_calls') {
    return 'tool_use';
  }

  return 'end_turn';
}

function parseRequestBody(bodyBuffer) {
  try {
    return JSON.parse(bodyBuffer.toString('utf8'));
  } catch (error) {
    error.code = error.code ?? 'INVALID_JSON_BODY';
    throw error;
  }
}

function readResponseBody(response) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    response.on('data', (chunk) => {
      chunks.push(chunk);
    });

    response.on('end', () => {
      resolve(Buffer.concat(chunks));
    });

    response.on('error', reject);
  });
}

function parseResponseJson(bodyBuffer) {
  if (!Buffer.isBuffer(bodyBuffer) || bodyBuffer.length === 0) {
    return null;
  }

  try {
    return JSON.parse(bodyBuffer.toString('utf8'));
  } catch {
    return null;
  }
}

function normalizeResponseBody(body) {
  if (Buffer.isBuffer(body)) {
    return body;
  }

  if (typeof body === 'string') {
    return Buffer.from(body);
  }

  if (body == null) {
    return Buffer.alloc(0);
  }

  return Buffer.from(JSON.stringify(body));
}

function buildOpenAIRequestBody(bodyBuffer, config = {}, modelOverride) {
  const anthropicBody = parseRequestBody(bodyBuffer);
  const openaiBody = convertAnthropicToOpenAI(anthropicBody, config.openai);

  if (modelOverride) {
    openaiBody.model = modelOverride;
  }

  return {
    anthropicBody,
    openaiBody,
  };
}

export function supportsOpenAIProxyResponse(anthropicBody) {
  return anthropicBody?.stream !== true;
}

export function shouldHandle529Fallback({ config = {}, classification = {}, responseBytes = 0, anthropicBody = null } = {}) {
  if (!config?.fallback_529?.enabled) {
    return false;
  }

  if (responseBytes > 0) {
    return false;
  }

  const targetSources = config?.fallback_529?.target_query_sources;
  if (Array.isArray(targetSources) && targetSources.length > 0) {
    const qs = classification?.querySource;
    if (qs && !targetSources.includes(qs)) {
      return false;
    }
  }

  if (anthropicBody && !supportsOpenAIProxyResponse(anthropicBody)) {
    return false;
  }

  return true;
}

export function convertOpenAIToAnthropicResponse(openaiResponse, { model } = {}) {
  const choice = openaiResponse?.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const text = normalizeTextContent(message.content);
  const content = [];

  if (text) {
    content.push({
      type: 'text',
      text,
    });
  }

  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const toolCall of toolCalls) {
    let input = {};

    if (typeof toolCall?.function?.arguments === 'string' && toolCall.function.arguments.length > 0) {
      try {
        input = JSON.parse(toolCall.function.arguments);
      } catch {
        input = {};
      }
    }

    content.push({
      type: 'tool_use',
      id: toolCall.id ?? `toolu_${content.length + 1}`,
      name: toolCall?.function?.name ?? 'unknown_tool',
      input,
    });
  }

  if (content.length === 0) {
    content.push({
      type: 'text',
      text: '',
    });
  }

  return {
    id: openaiResponse?.id ?? `msg_openai_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: model ?? openaiResponse?.model ?? DEFAULT_OPENAI_MODEL,
    content,
    stop_reason: mapFinishReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: openaiResponse?.usage?.prompt_tokens ?? 0,
      output_tokens: openaiResponse?.usage?.completion_tokens ?? 0,
    },
  };
}

export async function requestOpenAIChatCompletion({
  bodyBuffer,
  config = {},
  model,
  requestImpl = null,
  codexFn = null,
  timeoutMs = 60_000,
} = {}) {
  const { anthropicBody, openaiBody } = buildOpenAIRequestBody(bodyBuffer, config, model);

  if (typeof requestImpl === 'function') {
    const response = await requestImpl({
      url: null,
      method: 'POST',
      headers: {},
      body: JSON.stringify(openaiBody),
      timeoutMs,
    });

    const statusCode = response?.statusCode ?? 502;
    const headers = response?.headers ?? {};
    const body = normalizeResponseBody(response?.body);

    return {
      anthropicBody,
      openaiRequestBody: openaiBody,
      statusCode,
      headers,
      body,
      json: parseResponseJson(body),
    };
  }

  const callFn = codexFn || callCodexCli;
  const json = await callFn({
    messages: openaiBody.messages || [],
    tools: openaiBody.tools || [],
    model: model || config?.openai?.default_model || 'gpt-5.4',
    timeoutMs,
  });

  if (json.error) {
    const error = new Error(`codex_cli_error: ${json.error.message}`);
    error.code = 'CODEX_CLI_ERROR';
    throw error;
  }

  const body = Buffer.from(JSON.stringify(json));

  return {
    anthropicBody,
    openaiRequestBody: openaiBody,
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body,
    json,
  };
}

export async function respondWithOpenAICompletion({
  res,
  turn = null,
  bodyBuffer,
  config,
  model,
  requestImpl = null,
  routedTo = 'openai',
} = {}) {
  const upstreamResponse = await requestOpenAIChatCompletion({
    bodyBuffer,
    config,
    model,
    requestImpl,
  });

  if (upstreamResponse.statusCode >= 400 || !upstreamResponse.json || upstreamResponse.json.error) {
    const error = new Error(`openai_upstream_error:${upstreamResponse.statusCode}`);
    error.code = 'OPENAI_UPSTREAM_ERROR';
    error.upstreamResponse = upstreamResponse;
    throw error;
  }

  const anthropicResponse = convertOpenAIToAnthropicResponse(upstreamResponse.json, {
    model,
  });
  const payload = Buffer.from(JSON.stringify(anthropicResponse));

  turn?.setRoutedTo?.(routedTo);
  turn?.setResponseInfo?.({
    status: 200,
    headers: {
      'content-type': 'application/json',
      'content-length': String(payload.length),
    },
  });
  if (turn?.record) {
    turn.record.model = anthropicResponse.model;
  }
  turn?.addUsage?.(anthropicResponse.usage);
  turn?.observeChunk?.(payload);

  res.writeHead(200, {
    'content-type': 'application/json',
    'content-length': payload.length,
  });
  res.end(payload);

  return {
    statusCode: 200,
    body: payload,
    anthropicResponse,
    upstreamResponse,
  };
}
