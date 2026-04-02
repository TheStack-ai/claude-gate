import { createReadStream, watch, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import os from 'node:os';

const DEFAULT_LOG_PATH = path.join(os.homedir(), '.claude-proxy', 'logs', 'metrics.jsonl');

// ── ANSI helpers ──

const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const GREEN = `${ESC}32m`;
const RED = `${ESC}31m`;
const YELLOW = `${ESC}33m`;
const CYAN = `${ESC}36m`;
const WHITE = `${ESC}37m`;
const BG_RESET = `${ESC}49m`;

const clear = () => process.stdout.write(`${ESC}2J${ESC}H`);
const moveTo = (row, col) => process.stdout.write(`${ESC}${row};${col}H`);
const hideCursor = () => process.stdout.write(`${ESC}?25l`);
const showCursor = () => process.stdout.write(`${ESC}?25h`);

// ── Label translation ──

export function translateQuerySource(qs, agentSeq) {
  if (qs === 'repl_main_thread') return '대표님 직접 대화';
  if (qs === 'compact') return '맥락 압축';
  if (qs === 'verification_agent') return '검증 작업';
  if (typeof qs === 'string' && qs.startsWith('agent:')) return `AI 보조작업 (#${agentSeq})`;
  return qs || '알 수 없음';
}

export function translateRoutedTo(routedTo) {
  if (routedTo === 'anthropic') return 'Claude';
  if (routedTo === 'openai') return 'Codex';
  if (routedTo === 'openai_fallback') return 'Codex';
  return routedTo || '?';
}

function routeTag(routedTo) {
  if (routedTo === 'openai') return `${GREEN}절약!${RESET}`;
  if (routedTo === 'openai_fallback') return `${YELLOW}529복구!${RESET}`;
  return '';
}

function statusIcon(status) {
  if (status >= 200 && status < 400) return `${GREEN}✓${RESET}`;
  if (status === 529) return `${YELLOW}⟳${RESET}`;
  return `${RED}✗${RESET}`;
}

// ── Progress bar ──

export function progressBar(ratio, width = 20) {
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

// ── Session state ──

export function createSessionState() {
  return {
    turns: 0,
    directCount: 0,
    agentCount: 0,
    codexRoutedCount: 0,
    fallbackCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    codexSavedTokens: 0,
    cacheHitSum: 0,
    retryCount: 0,
    agentSeq: 0,
    recentEvents: [],
    startedAt: Date.now(),
  };
}

export function ingestRecord(state, record) {
  state.turns += 1;

  const isAgent = typeof record.query_source === 'string' && record.query_source.startsWith('agent:');
  if (isAgent) {
    state.agentCount += 1;
    state.agentSeq += 1;
  } else {
    state.directCount += 1;
  }

  if (record.routed_to === 'openai') {
    state.codexRoutedCount += 1;
    state.codexSavedTokens += (record.input_tokens || 0) + (record.output_tokens || 0);
  }
  if (record.routed_to === 'openai_fallback') {
    state.fallbackCount += 1;
    state.codexSavedTokens += (record.input_tokens || 0) + (record.output_tokens || 0);
  }

  state.totalInputTokens += record.input_tokens || 0;
  state.totalOutputTokens += record.output_tokens || 0;
  state.cacheHitSum += record.cache_hit_rate || 0;
  if (record.is_retry) state.retryCount += 1;

  const time = record.ts ? new Date(record.ts).toLocaleTimeString('ko-KR', { hour12: false }) : '--:--:--';
  state.recentEvents.push({
    time,
    label: translateQuerySource(record.query_source, state.agentSeq),
    target: translateRoutedTo(record.routed_to),
    tag: routeTag(record.routed_to),
    icon: statusIcon(record.status || 200),
    routedTo: record.routed_to,
  });

  if (state.recentEvents.length > 10) state.recentEvents.shift();
}

// ── Render ──

function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function elapsedStr(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}시간 ${m % 60}분`;
  if (m > 0) return `${m}분 ${s % 60}초`;
  return `${s}초`;
}

function renderFrame(state, cols) {
  const w = Math.min(cols - 2, 62);
  const pad = (str, len) => {
    const visible = str.replace(/\x1b\[[0-9;]*m/g, '');
    return str + ' '.repeat(Math.max(0, len - visible.length));
  };
  const hr = '─'.repeat(w);
  const lines = [];

  lines.push(`${CYAN}╭${'─'.repeat(w)}╮${RESET}`);
  lines.push(`${CYAN}│${RESET}${BOLD}${pad('              Claude Proxy', w)}${CYAN}│${RESET}`);
  lines.push(`${CYAN}│${RESET}${DIM}${pad(`             ${elapsedStr(Date.now() - state.startedAt)}째 실행 중`, w)}${RESET}${CYAN}│${RESET}`);
  lines.push(`${CYAN}│${pad('', w)}│${RESET}`);

  // Live events
  lines.push(`${CYAN}│${RESET}  ${BOLD}💬 지금 일어나는 일${RESET}${' '.repeat(Math.max(0, w - 22))}${CYAN}│${RESET}`);
  lines.push(`${CYAN}│${RESET}  ${DIM}${hr.slice(0, w - 4)}${RESET}  ${CYAN}│${RESET}`);

  if (state.recentEvents.length === 0) {
    lines.push(`${CYAN}│${RESET}${DIM}${pad('  요청 대기 중...', w)}${RESET}${CYAN}│${RESET}`);
  } else {
    for (const evt of state.recentEvents.slice(-8)) {
      const entry = `  ${DIM}${evt.time}${RESET}  ${pad(evt.label, 18)} → ${BOLD}${evt.target}${RESET}  ${evt.icon} ${evt.tag}`;
      lines.push(`${CYAN}│${RESET}${pad(entry, w)}${CYAN}│${RESET}`);
    }
  }

  lines.push(`${CYAN}│${pad('', w)}│${RESET}`);

  // Session summary
  lines.push(`${CYAN}│${RESET}  ${BOLD}📊 이번 세션 요약${RESET}${' '.repeat(Math.max(0, w - 21))}${CYAN}│${RESET}`);
  lines.push(`${CYAN}│${RESET}  ${DIM}${hr.slice(0, w - 4)}${RESET}  ${CYAN}│${RESET}`);

  const directPct = state.turns > 0 ? Math.round(state.directCount / state.turns * 100) : 0;
  const agentPct = state.turns > 0 ? Math.round(state.agentCount / state.turns * 100) : 0;

  lines.push(`${CYAN}│${RESET}${pad(`  총 대화 횟수       ${state.turns}회`, w)}${CYAN}│${RESET}`);
  lines.push(`${CYAN}│${RESET}${pad(`  ├ 대표님 직접      ${state.directCount}회 (${directPct}%)   → 전부 Claude`, w)}${CYAN}│${RESET}`);
  lines.push(`${CYAN}│${RESET}${pad(`  └ AI 보조작업      ${state.agentCount}회 (${agentPct}%)   → ${state.codexRoutedCount}회 Codex로 절약`, w)}${CYAN}│${RESET}`);
  lines.push(`${CYAN}│${pad('', w)}│${RESET}`);

  const claudeRatio = state.turns > 0 ? state.directCount / state.turns : 0;
  const codexRatio = state.turns > 0 ? (state.codexRoutedCount + state.fallbackCount) / state.turns : 0;

  lines.push(`${CYAN}│${RESET}${pad(`  Claude 사용량      ${progressBar(claudeRatio)}  ${Math.round(claudeRatio * 100)}%`, w)}${CYAN}│${RESET}`);
  lines.push(`${CYAN}│${RESET}${pad(`  Codex 활용         ${GREEN}${progressBar(codexRatio)}${RESET}  ${Math.round(codexRatio * 100)}%`, w)}${CYAN}│${RESET}`);
  lines.push(`${CYAN}│${pad('', w)}│${RESET}`);

  // Savings
  lines.push(`${CYAN}│${RESET}  ${BOLD}💰 절약 효과${RESET}${' '.repeat(Math.max(0, w - 15))}${CYAN}│${RESET}`);
  lines.push(`${CYAN}│${RESET}  ${DIM}${hr.slice(0, w - 4)}${RESET}  ${CYAN}│${RESET}`);

  lines.push(`${CYAN}│${RESET}${pad(`  절약한 Claude 토큰     ${GREEN}${formatTokens(state.codexSavedTokens)}개${RESET}`, w)}${CYAN}│${RESET}`);
  lines.push(`${CYAN}│${RESET}${pad(`  529 에러 복구          ${state.fallbackCount > 0 ? YELLOW : ''}${state.fallbackCount}회${state.fallbackCount > 0 ? ' (멈출 뻔한 작업 살림)' : ''}${RESET}`, w)}${CYAN}│${RESET}`);

  const avgCacheHit = state.turns > 0 ? (state.cacheHitSum / state.turns * 100).toFixed(1) : '0.0';
  lines.push(`${CYAN}│${RESET}${pad(`  캐시 히트율            ${avgCacheHit}%`, w)}${CYAN}│${RESET}`);

  lines.push(`${CYAN}│${pad('', w)}│${RESET}`);
  lines.push(`${CYAN}╰${'─'.repeat(w)}╯${RESET}`);
  lines.push(`${DIM}  Ctrl+C로 종료${RESET}`);

  return lines;
}

// ── Main loop ──

export async function startDashboard(options = {}) {
  const logPath = options.logPath || DEFAULT_LOG_PATH;
  const sessionFilter = options.session || null;
  const state = createSessionState();
  const cols = process.stdout.columns || 80;

  // Initial read of existing log
  try {
    statSync(logPath);
    const rl = createInterface({ input: createReadStream(logPath), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (sessionFilter && record.session_id !== sessionFilter) continue;
        ingestRecord(state, record);
      } catch {}
    }
  } catch {}

  // Setup terminal
  hideCursor();
  clear();

  const draw = () => {
    const currentCols = process.stdout.columns || 80;
    moveTo(1, 1);
    const lines = renderFrame(state, currentCols);
    process.stdout.write(lines.join('\n') + '\n');
  };

  draw();

  // Watch for log changes
  let fileSize = 0;
  try { fileSize = statSync(logPath).size; } catch {}

  const pollInterval = setInterval(async () => {
    let currentSize;
    try { currentSize = statSync(logPath).size; } catch { return; }
    if (currentSize <= fileSize) return;

    // Read new bytes
    const stream = createReadStream(logPath, { start: fileSize });
    fileSize = currentSize;
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (sessionFilter && record.session_id !== sessionFilter) continue;
        ingestRecord(state, record);
      } catch {}
    }
    draw();
  }, 1000);

  // Timer update
  const timerInterval = setInterval(draw, 5000);

  // Resize
  const onResize = () => { clear(); draw(); };
  process.stdout.on('resize', onResize);

  // Cleanup
  const cleanup = () => {
    clearInterval(pollInterval);
    clearInterval(timerInterval);
    process.stdout.off('resize', onResize);
    showCursor();
    clear();
    console.log('dashboard 종료.');
  };

  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });

  return { state, cleanup };
}
