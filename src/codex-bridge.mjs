import { spawn } from 'node:child_process';

const DEFAULT_MODEL = 'gpt-5.4';
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Call the Codex CLI (codex exec) using the user's Codex Pro subscription.
 * Returns an OpenAI-compatible response shape for compatibility with existing code.
 */
export async function callCodexCli({
  messages = [],
  tools = [],
  model = DEFAULT_MODEL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  codexPath = 'codex',
} = {}) {
  const prompt = buildPrompt(messages, tools);

  const args = [
    'exec',
    '--json',
    '--model', model,
    '--ephemeral',
    '-s', 'read-only',
    '--skip-git-repo-check',
    '-',
  ];

  const result = await spawnCodex(codexPath, args, timeoutMs, prompt);

  return parseCodexOutput(result, model);
}

function buildPrompt(messages, tools) {
  const parts = [];

  for (const msg of messages) {
    const role = msg.role === 'system' ? '[System]' : msg.role === 'assistant' ? '[Assistant]' : '[User]';
    const content = typeof msg.content === 'string'
      ? msg.content
      : Array.isArray(msg.content)
        ? msg.content.map(c => c.text || c.content || JSON.stringify(c)).join('\n')
        : JSON.stringify(msg.content);
    parts.push(`${role}\n${content}`);
  }

  if (tools.length > 0) {
    parts.push('\n[Available Tools]');
    for (const tool of tools) {
      const fn = tool.function || tool;
      parts.push(`- ${fn.name}: ${fn.description || ''}`);
    }
  }

  return parts.join('\n\n');
}

function spawnCodex(codexPath, args, timeoutMs, stdinText = '') {
  return new Promise((resolve) => {
    const lines = [];
    let stderr = '';

    const proc = spawn(codexPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: timeoutMs,
      env: { ...process.env },
    });

    proc.stdin.end(stdinText);

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      for (const line of text.split('\n')) {
        if (line.trim()) lines.push(line.trim());
      }
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    proc.on('close', (code) => {
      resolve({ lines, stderr, exitCode: code });
    });

    proc.on('error', (err) => {
      resolve({ lines: [], stderr: err.message, exitCode: 1 });
    });
  });
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') {
    return null;
  }

  const promptTokens = usage.input_tokens || 0;
  const completionTokens = usage.output_tokens || 0;

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

function normalizeMessageText(item) {
  if (!item || typeof item !== 'object') {
    return '';
  }

  if (typeof item.text === 'string') {
    return item.text;
  }

  if (!Array.isArray(item.content)) {
    return '';
  }

  return item.content
    .map((part) => {
      if (typeof part === 'string') {
        return part;
      }

      if (part?.type === 'output_text' || part?.type === 'text') {
        return part.text ?? '';
      }

      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function normalizeToolCall(toolCall, fallbackIndex = 0) {
  if (!toolCall || typeof toolCall !== 'object') {
    return null;
  }

  const name = toolCall.function?.name ?? toolCall.name ?? null;
  if (!name) {
    return null;
  }

  const rawArguments = toolCall.function?.arguments ?? toolCall.arguments ?? '';

  return {
    id: toolCall.id ?? toolCall.call_id ?? `call_${fallbackIndex + 1}`,
    type: 'function',
    function: {
      name,
      arguments: typeof rawArguments === 'string' ? rawArguments : JSON.stringify(rawArguments),
    },
  };
}

function collectToolCalls(candidate) {
  if (!candidate || typeof candidate !== 'object') {
    return [];
  }

  if (Array.isArray(candidate.tool_calls)) {
    return candidate.tool_calls
      .map((toolCall, index) => normalizeToolCall(toolCall, index))
      .filter(Boolean);
  }

  if (candidate.type === 'function_call' || candidate.type === 'tool_call' || candidate.type === 'custom_tool_call') {
    const toolCall = normalizeToolCall(candidate);
    return toolCall ? [toolCall] : [];
  }

  if (Array.isArray(candidate.content)) {
    return candidate.content.flatMap((part, index) => {
      if (part?.type === 'tool_call' || part?.type === 'function_call' || part?.type === 'custom_tool_call') {
        const toolCall = normalizeToolCall(part, index);
        return toolCall ? [toolCall] : [];
      }

      return [];
    });
  }

  return [];
}

function parseCodexOutput({ lines, stderr, exitCode }, model) {
  if (exitCode !== 0 && lines.length === 0) {
    return {
      error: { message: `codex exec failed (exit ${exitCode}): ${stderr.slice(0, 200)}` },
      choices: [],
      usage: null,
      model,
    };
  }

  let text = '';
  let usage = null;
  const toolCalls = [];
  const seenToolCalls = new Set();

  for (const line of lines) {
    try {
      const event = JSON.parse(line);

      if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
        const nextText = normalizeMessageText(event.item);
        if (nextText) {
          text += (text ? '\n' : '') + nextText;
        }
      }

      for (const toolCall of collectToolCalls(event.item)) {
        const key = `${toolCall.id}:${toolCall.function.name}:${toolCall.function.arguments}`;
        if (!seenToolCalls.has(key)) {
          seenToolCalls.add(key);
          toolCalls.push(toolCall);
        }
      }

      if (!usage && event.usage) {
        usage = normalizeUsage(event.usage);
      }

      if (event.type === 'turn.completed' && event.usage) {
        usage = normalizeUsage(event.usage);
      }
    } catch {
      // skip non-JSON lines
    }
  }

  return {
    id: `codex-${Date.now()}`,
    model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: text || null,
        tool_calls: toolCalls,
      },
      finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
    }],
    usage,
  };
}

/**
 * Check if the codex CLI is available and authenticated.
 */
export async function isCodexAvailable(codexPath = 'codex') {
  return new Promise((resolve) => {
    const proc = spawn(codexPath, ['login', 'status'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    });

    let stdout = '';
    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.on('close', (code) => {
      resolve(code === 0 && stdout.includes('Logged in'));
    });
    proc.on('error', () => resolve(false));
  });
}
