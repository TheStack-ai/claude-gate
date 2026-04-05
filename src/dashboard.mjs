import { createReadStream, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import os from 'node:os';

const DEFAULT_LOG_PATH = path.join(os.homedir(), '.cc-mux', 'logs', 'metrics.jsonl');

// ── ANSI helpers ──

const ESC = '\x1b[';

function shouldUseAnsi() {
  return Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb';
}

function createAnsi(enabled) {
  const color = (code) => (enabled ? `${ESC}${code}m` : '');
  return {
    enabled,
    RESET: color('0'),
    BOLD: color('1'),
    DIM: color('2'),
    GREEN: color('32'),
    RED: color('31'),
    YELLOW: color('33'),
    CYAN: color('36'),
    MAGENTA: color('35'),
    clear() {
      if (enabled) process.stdout.write(`${ESC}2J${ESC}H`);
    },
    moveTo(row, col) {
      if (enabled) process.stdout.write(`${ESC}${row};${col}H`);
    },
    hideCursor() {
      if (enabled) process.stdout.write(`${ESC}?25l`);
    },
    showCursor() {
      if (enabled) process.stdout.write(`${ESC}?25h`);
    },
  };
}

const ANSI = createAnsi(shouldUseAnsi());
const { RESET, BOLD, DIM, GREEN, RED, YELLOW, CYAN, MAGENTA } = ANSI;

const MODEL_PRICING = Object.freeze({
  opus: { input: 15, output: 75 },
  sonnet: { input: 3, output: 15 },
  haiku: { input: 0.8, output: 4 },
});

// ── i18n ──

const TRANSLATIONS = {
  en: {
    locale: 'en-GB',
    title: 'CC Mux',
    sections: {
      live: 'Live',
      routing: 'Routing',
      session: 'Session',
    },
    status: {
      running: (elapsed, startTime) => `${elapsed} running  started ${startTime}`,
      waiting: 'Waiting for API calls...',
      claudeReqs: 'Claude',
      codexReqs: 'Codex',
      routingRatio: 'Codex ratio',
      codexTokens: 'Codex handled',
      savings: 'Saved',
      fallback529: '529 recovered',
      apiCalls: 'API calls',
      totalTokens: 'Total tokens',
      avgLatency: 'Avg latency',
      claudeAvgLatency: 'Claude avg',
      codexAvgLatency: 'Codex avg',
      claudeCost: 'Claude cost',
      retries: 'Retries',
      savingsNote: 'estimated',
      dashboardStopped: 'Dashboard stopped.',
      keyHints: 'q quit  r refresh  Ctrl+C exit',
    },
  },
  ko: {
    locale: 'ko-KR',
    title: 'CC Mux',
    sections: {
      live: '실시간',
      routing: '라우팅',
      session: '세션',
    },
    status: {
      running: (elapsed, startTime) => `${elapsed}째 실행 중  시작 ${startTime}`,
      waiting: 'API 호출 대기 중...',
      claudeReqs: 'Claude',
      codexReqs: 'Codex',
      routingRatio: 'Codex 비율',
      codexTokens: 'Codex 처리',
      savings: '절감액',
      fallback529: '529 복구',
      apiCalls: 'API 호출',
      totalTokens: '총 토큰',
      avgLatency: '평균 응답',
      claudeAvgLatency: 'Claude 평균',
      codexAvgLatency: 'Codex 평균',
      claudeCost: 'Claude 비용',
      retries: '재시도',
      savingsNote: '모델별 추정',
      dashboardStopped: 'dashboard 종료.',
      keyHints: 'q 종료  r 새로고침  Ctrl+C 종료',
    },
  },
};

function normalizeLang(lang) {
  return typeof lang === 'string' && lang.toLowerCase() === 'ko' ? 'ko' : 'en';
}

function getTranslations(lang) {
  return TRANSLATIONS[normalizeLang(lang)];
}

// ── Helpers ──

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function shortModelName(model) {
  if (typeof model !== 'string' || model.length === 0) return 'unknown';
  return model.replace(/^claude-/, '');
}

function modelFamily(model) {
  const short = shortModelName(model).toLowerCase();
  if (short.includes('opus')) return 'opus';
  if (short.includes('sonnet')) return 'sonnet';
  if (short.includes('haiku')) return 'haiku';
  return 'unknown';
}

export function translateQuerySource(model) {
  return shortModelName(model);
}

export function translateRoutedTo() {
  return '';
}

function resolveLatencyMs(record) {
  return toNumber(record.latency_ms ?? record.ttfb_ms ?? record.duration_ms);
}

function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function formatCost(amount) {
  if (!Number.isFinite(amount) || amount === 0) return '$0';
  const abs = Math.abs(amount);
  let digits = 3;
  if (abs >= 100) digits = 0;
  else if (abs >= 10) digits = 1;
  else if (abs >= 1) digits = 2;
  return `$${amount.toFixed(digits)}`;
}

function formatSeconds(ms) {
  return `${(toNumber(ms) / 1000).toFixed(1)}s`;
}

function formatPercent(ratio) {
  return `${(toNumber(ratio) * 100).toFixed(0)}%`;
}

function elapsedStr(ms, lang = 'en') {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (lang === 'ko') {
    if (h > 0) return `${h}시간 ${m % 60}분`;
    if (m > 0) return `${m}분 ${s % 60}초`;
    return `${s}초`;
  }
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function isRealApiCall(record) {
  if (!record.model) return false;
  const status = Number(record.status);
  if (status === 404) return false;
  return true;
}

// ── Display width (CJK/emoji = 2 columns) ──

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

function displayWidth(str) {
  const clean = stripAnsi(str);
  let w = 0;
  for (const ch of clean) {
    const cp = ch.codePointAt(0);
    if (
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe6f) ||
      (cp >= 0xff01 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f000 && cp <= 0x1ffff) ||
      (cp >= 0x20000 && cp <= 0x3ffff)
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

function fitText(str, len) {
  const dw = displayWidth(str);
  if (dw <= len) return str + ' '.repeat(len - dw);
  if (len <= 3) return str.slice(0, len);
  return `${str.slice(0, len - 3)}...`;
}

// ── Progress bar ──

export function progressBar(ratio, width = 20) {
  const clamped = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(clamped * width);
  const empty = width - filled;
  return `${GREEN}${'█'.repeat(filled)}${RESET}${DIM}${'░'.repeat(empty)}${RESET}`;
}

// ── Session state ──

export function createSessionState(options = {}) {
  return {
    lang: normalizeLang(options.lang),
    apiCalls: 0,
    claudeCount: 0,
    codexCount: 0,
    fallback529Count: 0,
    retryCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    codexInputTokens: 0,
    codexOutputTokens: 0,
    totalLatencyMs: 0,
    claudeLatencyMs: 0,
    codexLatencyMs: 0,
    claudeCost: 0,
    codexSavings: 0,
    recentEvents: [],
    startedAt: Date.now(),
  };
}

export function ingestRecord(state, record) {
  // Skip non-API noise (404s, health checks, etc.)
  if (!isRealApiCall(record)) return;

  const inputTokens = toNumber(record.input_tokens);
  const outputTokens = toNumber(record.output_tokens);
  const latencyMs = resolveLatencyMs(record);
  const status = Number(record.status) || 0;
  const routedTo = record.routed_to || 'anthropic';
  const model = shortModelName(record.model);
  const t = getTranslations(state.lang);

  state.apiCalls += 1;
  state.totalInputTokens += inputTokens;
  state.totalOutputTokens += outputTokens;
  state.totalLatencyMs += latencyMs;
  if (record.is_retry) state.retryCount += 1;

  const family = modelFamily(record.model);
  const pricing = MODEL_PRICING[family] || MODEL_PRICING.opus;
  const cost = (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
  if (routedTo === 'openai' || routedTo === 'openai_fallback') {
    state.codexCount += 1;
    state.codexInputTokens += inputTokens;
    state.codexOutputTokens += outputTokens;
    state.codexSavings += cost;
    state.codexLatencyMs += latencyMs;
    if (routedTo === 'openai_fallback') state.fallback529Count += 1;
  } else {
    state.claudeCount += 1;
    state.claudeCost += cost;
    state.claudeLatencyMs += latencyMs;
    if (status === 529) state.fallback529Count += 1;
  }

  // Live event
  const time = record.ts
    ? new Date(record.ts).toLocaleTimeString(t.locale, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '--:--:--';

  let routeTag;
  if (routedTo === 'openai') {
    routeTag = `${GREEN}Codex${RESET}`;
  } else if (status === 529) {
    routeTag = `${YELLOW} 529 ${RESET}`;
  } else {
    routeTag = `${DIM}Claude${RESET}`;
  }

  let statusIcon;
  if (status >= 200 && status < 400) statusIcon = `${GREEN}✓${RESET}`;
  else if (status === 529) statusIcon = `${YELLOW}⟳${RESET}`;
  else statusIcon = `${RED}✗${RESET}`;

  state.recentEvents.push({
    time,
    routeTag,
    model,
    tokens: formatTokens(inputTokens + outputTokens),
    latency: formatSeconds(latencyMs),
    statusIcon,
  });

  if (state.recentEvents.length > 8) state.recentEvents.shift();
}

// ── Render ──

function renderFrame(state, cols, keyboardEnabled) {
  const t = getTranslations(state.lang);
  const w = Math.max(44, Math.min(cols - 2, 60));
  const pad = (str, len) => str + ' '.repeat(Math.max(0, len - displayWidth(str)));
  const hr = `${DIM}${'─'.repeat(w - 4)}${RESET}`;
  const lines = [];

  const codexRatio = state.apiCalls > 0 ? state.codexCount / state.apiCalls : 0;
  const claudeAvgLatency = state.claudeCount > 0 ? state.claudeLatencyMs / state.claudeCount : 0;
  const codexAvgLatency = state.codexCount > 0 ? state.codexLatencyMs / state.codexCount : 0;
  const totalTokens = state.totalInputTokens + state.totalOutputTokens;
  const startTimeStr = new Date(state.startedAt).toLocaleTimeString(t.locale, { hour12: false, hour: '2-digit', minute: '2-digit' });

  // Header
  lines.push(`${CYAN}╭${'─'.repeat(w)}╮${RESET}`);
  lines.push(`${CYAN}│${RESET}${BOLD}${pad(`  ${t.title}`, w)}${CYAN}│${RESET}`);
  lines.push(`${CYAN}│${RESET}${DIM}${pad(`  ${t.status.running(elapsedStr(Date.now() - state.startedAt, state.lang), startTimeStr)}`, w)}${RESET}${CYAN}│${RESET}`);
  lines.push(`${CYAN}├${'─'.repeat(w)}┤${RESET}`);

  // Routing section
  lines.push(`${CYAN}│${RESET}${pad(`  ${BOLD}${t.sections.routing}${RESET}`, w)}${CYAN}│${RESET}`);
  lines.push(`${CYAN}│${RESET}  ${hr}  ${CYAN}│${RESET}`);

  // Combined routing bar
  const barWidth = Math.min(20, w - 30);
  const codexFill = Math.round(codexRatio * barWidth);
  const claudeFill = barWidth - codexFill;
  const routingBar = `${DIM}${'█'.repeat(claudeFill)}${RESET}${GREEN}${'█'.repeat(codexFill)}${RESET}`;
  lines.push(`${CYAN}│${RESET}${pad(`  ${fitText(t.status.claudeReqs, 12)}${fitText(String(state.claudeCount), 6)}`, w)}${CYAN}│${RESET}`);
  lines.push(`${CYAN}│${RESET}${pad(`  ${fitText(t.status.codexReqs, 12)}${GREEN}${fitText(String(state.codexCount), 6)}${RESET}`, w)}${CYAN}│${RESET}`);
  const ratioColor = codexRatio > 0 ? GREEN : DIM;
  lines.push(`${CYAN}│${RESET}${pad(`  ${fitText(t.status.routingRatio, 12)}${ratioColor}${formatPercent(codexRatio)}${RESET}  ${routingBar}`, w)}${CYAN}│${RESET}`);

  if (state.fallback529Count > 0) {
    lines.push(`${CYAN}│${RESET}${pad(`  ${fitText(t.status.fallback529, 16)}${YELLOW}${state.fallback529Count}${RESET}`, w)}${CYAN}│${RESET}`);
  }

  lines.push(`${CYAN}├${'─'.repeat(w)}┤${RESET}`);

  // Cost section (merged from routing + session)
  const savingsColor = state.codexSavings > 0 ? GREEN : DIM;
  lines.push(`${CYAN}│${RESET}${pad(`  ${fitText(t.status.claudeCost, 16)}${formatCost(state.claudeCost)}`, w)}${CYAN}│${RESET}`);
  lines.push(`${CYAN}│${RESET}${pad(`  ${fitText(t.status.savings, 16)}${savingsColor}-${formatCost(state.codexSavings)}${RESET} ${DIM}${t.status.savingsNote}${RESET}`, w)}${CYAN}│${RESET}`);
  lines.push(`${CYAN}│${RESET}${pad(`  ${fitText(t.status.totalTokens, 16)}${formatTokens(totalTokens)} tok`, w)}${CYAN}│${RESET}`);

  // Latency comparison
  lines.push(`${CYAN}│${RESET}${pad(`  ${fitText(t.status.claudeAvgLatency, 16)}${formatSeconds(claudeAvgLatency)}`, w)}${CYAN}│${RESET}`);
  if (state.codexCount > 0) {
    lines.push(`${CYAN}│${RESET}${pad(`  ${fitText(t.status.codexAvgLatency, 16)}${formatSeconds(codexAvgLatency)}`, w)}${CYAN}│${RESET}`);
  }

  if (state.retryCount > 0) {
    lines.push(`${CYAN}│${RESET}${pad(`  ${fitText(t.status.retries, 16)}${YELLOW}${state.retryCount}${RESET}`, w)}${CYAN}│${RESET}`);
  }

  lines.push(`${CYAN}├${'─'.repeat(w)}┤${RESET}`);

  // Live activity
  lines.push(`${CYAN}│${RESET}${pad(`  ${BOLD}${t.sections.live}${RESET}  ${DIM}${state.apiCalls} calls${RESET}`, w)}${CYAN}│${RESET}`);
  lines.push(`${CYAN}│${RESET}  ${hr}  ${CYAN}│${RESET}`);

  if (state.recentEvents.length === 0) {
    lines.push(`${CYAN}│${RESET}${DIM}${pad(`  ${t.status.waiting}`, w)}${RESET}${CYAN}│${RESET}`);
  } else {
    for (const evt of state.recentEvents) {
      const line = `  ${DIM}${evt.time}${RESET} ${evt.routeTag} ${fitText(evt.tokens, 6)} ${fitText(evt.latency, 5)} ${evt.statusIcon}`;
      lines.push(`${CYAN}│${RESET}${pad(line, w)}${CYAN}│${RESET}`);
    }
  }

  // Footer
  lines.push(`${CYAN}├${'─'.repeat(w)}┤${RESET}`);
  const hints = keyboardEnabled ? t.status.keyHints : 'Ctrl+C exit';
  lines.push(`${CYAN}│${RESET}${DIM}${pad(`  ${hints}`, w)}${RESET}${CYAN}│${RESET}`);
  lines.push(`${CYAN}╰${'─'.repeat(w)}╯${RESET}`);

  return lines;
}

// ── Main loop ──

export async function startDashboard(options = {}) {
  const logPath = options.logPath || DEFAULT_LOG_PATH;
  const sessionFilter = options.session || null;
  const fresh = options.fresh || false;
  const lang = normalizeLang(options.lang);
  const state = createSessionState({ lang });
  const keyboardEnabled = Boolean(process.stdin.isTTY && typeof process.stdin.setRawMode === 'function');
  let fileSize = 0;
  let cleanedUp = false;
  let lastFrame = '';
  let refreshInFlight = null;

  if (!fresh) {
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
  }

  try { fileSize = statSync(logPath).size; } catch {}

  ANSI.hideCursor();
  ANSI.clear();

  const draw = (force = false) => {
    const currentCols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;
    const frame = renderFrame(state, currentCols, keyboardEnabled);
    // Truncate to terminal height to prevent scrolling
    const visible = frame.slice(0, rows - 1).join('\n');

    if (ANSI.enabled) {
      ANSI.clear();
      ANSI.moveTo(1, 1);
      process.stdout.write(visible + '\n');
    } else if (force || visible !== lastFrame) {
      if (lastFrame) process.stdout.write('\n');
      process.stdout.write(visible + '\n');
    }

    lastFrame = visible;
  };

  const refreshFromLog = async (forceDraw = false) => {
    if (refreshInFlight) {
      if (forceDraw) {
        await refreshInFlight;
        draw(true);
      }
      return;
    }

    refreshInFlight = (async () => {
      let changed = false;
      let currentSize;
      try {
        currentSize = statSync(logPath).size;
      } catch {
        if (forceDraw) draw(true);
        return;
      }

      if (currentSize > fileSize) {
        const stream = createReadStream(logPath, { start: fileSize });
        fileSize = currentSize;
        const rl = createInterface({ input: stream, crlfDelay: Infinity });
        for await (const line of rl) {
          if (!line.trim()) continue;
          try {
            const record = JSON.parse(line);
            if (sessionFilter && record.session_id !== sessionFilter) continue;
            ingestRecord(state, record);
            changed = true;
          } catch {}
        }
      }

      if (changed || forceDraw) {
        ANSI.clear();
        draw(true);
      }
    })();

    try {
      await refreshInFlight;
    } finally {
      refreshInFlight = null;
    }
  };

  draw(true);

  const pollInterval = setInterval(() => {
    void refreshFromLog(false);
  }, 1000);

  const timerInterval = setInterval(() => draw(!ANSI.enabled), 5000);

  const onResize = () => {
    ANSI.clear();
    draw(true);
  };
  process.stdout.on('resize', onResize);

  const onKeypress = (chunk) => {
    const key = String(chunk);
    if (key === '\u0003' || key.toLowerCase() === 'q') {
      cleanup();
      process.exit(0);
    }
    if (key.toLowerCase() === 'r') {
      void refreshFromLog(true);
    }
  };

  if (keyboardEnabled) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onKeypress);
  }

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;

    clearInterval(pollInterval);
    clearInterval(timerInterval);
    process.stdout.off('resize', onResize);

    if (keyboardEnabled) {
      process.stdin.off('data', onKeypress);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }

    ANSI.showCursor();
    ANSI.clear();
    console.log(getTranslations(lang).status.dashboardStopped);
  };

  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });

  return { state, cleanup };
}
