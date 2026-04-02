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
    prompt,
  ];

  const result = await spawnCodex(codexPath, args, timeoutMs);

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

function spawnCodex(codexPath, args, timeoutMs) {
  return new Promise((resolve) => {
    const lines = [];
    let stderr = '';

    const proc = spawn(codexPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: timeoutMs,
      env: { ...process.env },
    });

    proc.stdin.end();

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

  for (const line of lines) {
    try {
      const event = JSON.parse(line);

      if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
        text += (text ? '\n' : '') + (event.item.text || '');
      }

      if (event.type === 'turn.completed' && event.usage) {
        usage = {
          prompt_tokens: event.usage.input_tokens || 0,
          completion_tokens: event.usage.output_tokens || 0,
          total_tokens: (event.usage.input_tokens || 0) + (event.usage.output_tokens || 0),
        };
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
        tool_calls: [],
      },
      finish_reason: 'stop',
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
