import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';

import { callCodexCli } from '../src/codex-bridge.mjs';

async function makeFakeCodex(t, scriptBody) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'codex-bridge-test-'));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const scriptPath = path.join(tempDir, 'fake-codex.mjs');
  await writeFile(scriptPath, scriptBody, 'utf8');
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

test('callCodexCli sends the built prompt over stdin and parses tool_calls arrays', async (t) => {
  const fakeCodexPath = await makeFakeCodex(t, `#!/usr/bin/env node
import process from 'node:process';

const chunks = [];
for await (const chunk of process.stdin) {
  chunks.push(chunk);
}

const prompt = Buffer.concat(chunks).toString('utf8');

if (process.argv.at(-1) !== '-') {
  process.stderr.write('expected_stdin_prompt');
  process.exit(2);
}

if (!prompt.includes('[User]') || !prompt.includes('read the file') || !prompt.includes('[Available Tools]')) {
  process.stderr.write('missing_prompt_content');
  process.exit(3);
}

process.stdout.write(JSON.stringify({
  type: 'item.completed',
  item: {
    type: 'agent_message',
    text: 'I will inspect the file.',
  },
}) + '\\n');
process.stdout.write(JSON.stringify({
  type: 'item.completed',
  item: {
    tool_calls: [{
      id: 'call_1',
      type: 'function',
      function: {
        name: 'Read',
        arguments: '{"path":"/tmp/demo.txt"}',
      },
    }],
  },
}) + '\\n');
process.stdout.write(JSON.stringify({
  type: 'turn.completed',
  usage: {
    input_tokens: 12,
    output_tokens: 5,
  },
}) + '\\n');
`);

  const result = await callCodexCli({
    codexPath: fakeCodexPath,
    model: 'gpt-5.4-mini',
    messages: [{ role: 'user', content: 'read the file' }],
    tools: [{ function: { name: 'Read', description: 'Read a file' } }],
  });

  assert.equal(result.model, 'gpt-5.4-mini');
  assert.equal(result.choices[0].message.content, 'I will inspect the file.');
  assert.equal(result.choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(result.choices[0].message.tool_calls, [{
    id: 'call_1',
    type: 'function',
    function: {
      name: 'Read',
      arguments: '{"path":"/tmp/demo.txt"}',
    },
  }]);
  assert.deepEqual(result.usage, {
    prompt_tokens: 12,
    completion_tokens: 5,
    total_tokens: 17,
  });
});

test('callCodexCli normalizes function_call items into OpenAI tool_calls', async (t) => {
  const fakeCodexPath = await makeFakeCodex(t, `#!/usr/bin/env node
import process from 'node:process';

for await (const _ of process.stdin) {
}

process.stdout.write(JSON.stringify({
  type: 'item.completed',
  item: {
    type: 'function_call',
    call_id: 'call_2',
    name: 'Write',
    arguments: '{"path":"/tmp/out.txt","text":"ok"}',
  },
}) + '\\n');
`);

  const result = await callCodexCli({
    codexPath: fakeCodexPath,
    messages: [{ role: 'user', content: 'write it' }],
  });

  assert.deepEqual(result.choices[0].message.tool_calls, [{
    id: 'call_2',
    type: 'function',
    function: {
      name: 'Write',
      arguments: '{"path":"/tmp/out.txt","text":"ok"}',
    },
  }]);
  assert.equal(result.choices[0].finish_reason, 'tool_calls');
});
