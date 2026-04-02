import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

test('claude-gate advise prints formatted advisor output', async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'claude-gate-cli-'));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const logPath = path.join(tempDir, 'metrics.jsonl');
  await writeFile(logPath, [
    JSON.stringify({
      session_id: 'session-a',
      query_source: 'agent:custom',
      input_tokens: 8_000,
      cache_hit_rate: 0.4,
      is_retry: true,
      speed: 'fast',
      ttfb_ms: 1200,
    }),
    JSON.stringify({
      session_id: 'session-a',
      query_source: 'agent:default',
      input_tokens: 22_000,
      cache_hit_rate: 0.42,
      is_retry: true,
      speed: 'fast',
      ttfb_ms: 1300,
    }),
    JSON.stringify({
      session_id: 'session-a',
      query_source: 'repl_main_thread',
      input_tokens: 36_000,
      cache_hit_rate: 0.41,
      is_retry: true,
      speed: 'fast',
      ttfb_ms: 1100,
    }),
    JSON.stringify({
      session_id: 'session-a',
      query_source: 'repl_main_thread',
      input_tokens: 50_000,
      cache_hit_rate: 0.43,
      is_retry: true,
      speed: null,
      ttfb_ms: 1200,
    }),
  ].join('\n'));

  const { stdout } = await execFileAsync(process.execPath, [
    path.join(process.cwd(), 'bin', 'claude-gate'),
    'advise',
    '--log',
    logPath,
  ], {
    cwd: process.cwd(),
  });

  assert.match(stdout, /⚠ 캐시 히트율 42%/);
  assert.match(stdout, /⚠ Agent Worker 비율 50%/);
  assert.match(stdout, /⚠ 세션당 최대 재시도 4회/);
  assert.match(stdout, /⚠ 컨텍스트 증가율 14\.0K\/턴/);
  assert.match(stdout, /⚠ Fast mode 활성 턴 75%/);
  assert.match(stdout, /✓ 평균 TTFB 1\.2s/);
});
