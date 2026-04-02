/**
 * Anthropic -> OpenAI request format conversion for shadow evaluation.
 * Operates on parsed JSON — never touches the original request body.
 */

function convertMessages(messages, system) {
  const result = [];

  if (system) {
    if (typeof system === 'string') {
      result.push({ role: 'system', content: system });
    } else if (Array.isArray(system)) {
      const text = system
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n');
      if (text) {
        result.push({ role: 'system', content: text });
      }
    }
  }

  if (!Array.isArray(messages)) {
    return result;
  }

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      if (typeof msg.content === 'string') {
        result.push({ role: 'assistant', content: msg.content });
        continue;
      }

      if (Array.isArray(msg.content)) {
        const textParts = [];
        const toolCalls = [];

        for (const block of msg.content) {
          if (block.type === 'text') {
            textParts.push(block.text);
          } else if (block.type === 'tool_use') {
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: {
                name: block.name,
                arguments: typeof block.input === 'string'
                  ? block.input
                  : JSON.stringify(block.input ?? {}),
              },
            });
          }
          // thinking, image, etc. — skip (Anthropic-only)
        }

        const assistantMsg = {
          role: 'assistant',
          content: textParts.join('\n') || null,
        };
        if (toolCalls.length > 0) {
          assistantMsg.tool_calls = toolCalls;
        }
        result.push(assistantMsg);
        continue;
      }

      result.push({ role: 'assistant', content: String(msg.content ?? '') });
      continue;
    }

    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        result.push({ role: 'user', content: msg.content });
        continue;
      }

      if (Array.isArray(msg.content)) {
        const allText = msg.content.every(b => b.type === 'text');
        if (allText) {
          result.push({ role: 'user', content: msg.content.map(b => b.text).join('\n') });
          continue;
        }

        const textParts = [];
        const toolResults = [];

        for (const block of msg.content) {
          if (block.type === 'text') {
            textParts.push(block.text);
          } else if (block.type === 'tool_result') {
            toolResults.push(block);
          }
        }

        if (textParts.length > 0) {
          result.push({ role: 'user', content: textParts.join('\n') });
        }

        for (const tr of toolResults) {
          let content = '';
          if (typeof tr.content === 'string') {
            content = tr.content;
          } else if (Array.isArray(tr.content)) {
            content = tr.content
              .filter(b => b.type === 'text')
              .map(b => b.text)
              .join('\n');
          }
          result.push({ role: 'tool', tool_call_id: tr.tool_use_id, content });
        }

        if (textParts.length === 0 && toolResults.length === 0) {
          result.push({ role: 'user', content: '' });
        }
        continue;
      }

      result.push({ role: 'user', content: String(msg.content ?? '') });
      continue;
    }

    // Other roles — pass through
    result.push({
      role: msg.role,
      content: typeof msg.content === 'string' ? msg.content : String(msg.content ?? ''),
    });
  }

  return result;
}

function convertTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) {
    return undefined;
  }

  return tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description ?? '',
      parameters: tool.input_schema ?? {},
    },
  }));
}

export function convertAnthropicToOpenAI(anthropicBody, openaiConfig = {}) {
  const model = openaiConfig.default_model ?? 'gpt-5.4';
  const result = { model };

  result.messages = convertMessages(anthropicBody.messages, anthropicBody.system);

  const tools = convertTools(anthropicBody.tools);
  if (tools) {
    result.tools = tools;
  }

  if (anthropicBody.max_tokens != null) {
    result.max_tokens = anthropicBody.max_tokens;
  }

  if (anthropicBody.temperature != null) {
    result.temperature = anthropicBody.temperature;
  }

  if (anthropicBody.top_p != null) {
    result.top_p = anthropicBody.top_p;
  }

  // Anthropic-only fields (metadata, thinking, speed, stream, top_k,
  // stop_sequences, system) are intentionally omitted.

  return result;
}
