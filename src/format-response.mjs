/**
 * OpenAI -> Anthropic response format conversion (non-streaming).
 * Converts a complete OpenAI chat completion response into Anthropic message format.
 */

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

function mapStopReason(finishReason) {
  if (finishReason === 'tool_calls') {
    return 'tool_use';
  }

  if (finishReason === 'length') {
    return 'max_tokens';
  }

  return 'end_turn';
}

function parseToolArguments(args) {
  if (typeof args === 'string' && args.length > 0) {
    try {
      return JSON.parse(args);
    } catch {
      return {};
    }
  }

  if (typeof args === 'object' && args !== null) {
    return args;
  }

  return {};
}

export function formatResponse(openaiResponse, { model } = {}) {
  if (!openaiResponse || typeof openaiResponse !== 'object') {
    return {
      id: `msg_proxy_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      model: model ?? 'unknown',
      content: [{ type: 'text', text: '' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }

  const choice = openaiResponse.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const content = [];

  const text = normalizeTextContent(message.content);
  if (text) {
    content.push({ type: 'text', text });
  }

  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const toolCall of toolCalls) {
    content.push({
      type: 'tool_use',
      id: toolCall.id ?? `toolu_${Date.now()}_${content.length}`,
      name: toolCall?.function?.name ?? 'unknown_tool',
      input: parseToolArguments(toolCall?.function?.arguments),
    });
  }

  if (content.length === 0) {
    content.push({ type: 'text', text: '' });
  }

  return {
    id: openaiResponse.id ?? `msg_proxy_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: model ?? openaiResponse.model ?? 'unknown',
    content,
    stop_reason: mapStopReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: openaiResponse.usage?.prompt_tokens ?? 0,
      output_tokens: openaiResponse.usage?.completion_tokens ?? 0,
    },
  };
}
