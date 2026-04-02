import http from 'node:http';
import https from 'node:https';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { createRequestClassifier } from './classifier.mjs';
import { MetricsLogger } from './logger.mjs';
import { createShadowEvaluator } from './shadow.mjs';

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const DEFAULT_CONFIG = Object.freeze({
  anthropic: {
    base_url: 'https://api.anthropic.com',
    api_key_env: 'ANTHROPIC_API_KEY',
  },
  openai: {
    base_url: 'https://api.openai.com/v1',
    api_key_env: 'OPENAI_API_KEY',
    default_model: 'gpt-5.4',
  },
  shadow: {
    enabled: true,
    target_query_sources: ['agent:custom', 'agent:default'],
    max_tool_count: 5,
    thinking_enabled: false,
  },
  routing: {
    enabled: false,
    rules: [],
  },
  fallback_529: {
    enabled: false,
    target_query_sources: ['agent:custom', 'agent:default'],
  },
});

function mergeConfig(base, overrides) {
  if (!overrides || typeof overrides !== 'object') {
    return structuredClone(base);
  }

  const merged = structuredClone(base);

  for (const [key, value] of Object.entries(overrides)) {
    if (Array.isArray(value)) {
      merged[key] = value.slice();
      continue;
    }

    if (value && typeof value === 'object' && merged[key] && typeof merged[key] === 'object' && !Array.isArray(merged[key])) {
      merged[key] = mergeConfig(merged[key], value);
      continue;
    }

    merged[key] = value;
  }

  return merged;
}

function normalizeHeaderValue(value) {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value ?? null;
}

function maskSecret(value) {
  if (!value) {
    return value;
  }

  if (value.length <= 8) {
    return '*'.repeat(value.length);
  }

  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function sanitizeHeadersForLog(headers = {}) {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => {
      const lowerKey = key.toLowerCase();
      if (lowerKey === 'x-api-key' || lowerKey === 'authorization' || lowerKey === 'proxy-authorization') {
        if (Array.isArray(value)) {
          return [key, value.map((entry) => maskSecret(String(entry)))];
        }

        return [key, maskSecret(String(value))];
      }

      return [key, value];
    }),
  );
}

function filterProxyHeaders(headers = {}, host) {
  const filtered = {};

  for (const [key, value] of Object.entries(headers)) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      continue;
    }

    filtered[key] = value;
  }

  filtered.host = host;
  return filtered;
}

function filterResponseHeaders(headers = {}) {
  const filtered = {};

  for (const [key, value] of Object.entries(headers)) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      continue;
    }

    if (value !== undefined) {
      filtered[key] = value;
    }
  }

  return filtered;
}

function selectTransport(url) {
  return url.protocol === 'https:' ? https : http;
}

function jsonErrorBody(error, requestId) {
  return JSON.stringify({
    error: 'proxy_upstream_error',
    request_id: requestId ?? null,
    message: error.message,
  });
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

export async function loadProxyConfig({ configPath = path.resolve(process.cwd(), '.proxy.config.json') } = {}) {
  try {
    const raw = await fs.readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      config: mergeConfig(DEFAULT_CONFIG, parsed),
      configPath,
      loadedFromDisk: true,
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        config: structuredClone(DEFAULT_CONFIG),
        configPath,
        loadedFromDisk: false,
      };
    }

    throw error;
  }
}

async function proxyRequest({ req, res, config, logger, classifier, log, shadow }) {
  const requestStartedAt = Date.now();
  const requestId = normalizeHeaderValue(req.headers['x-client-request-id']);
  const sessionId = normalizeHeaderValue(req.headers['x-claude-code-session-id']);
  const turn = logger.createTurnContext({
    sessionId,
    requestId,
    requestStartedAt,
    routedTo: 'anthropic',
  });

  const upstreamBaseUrl = new URL(config.anthropic.base_url);
  const upstreamUrl = new URL(req.url ?? '/', upstreamBaseUrl);
  const transport = selectTransport(upstreamUrl);
  const upstreamHeaders = filterProxyHeaders(req.headers, upstreamUrl.host);

  let resolveClassification;
  let rejectClassification;
  const classificationPromise = new Promise((resolve, reject) => {
    resolveClassification = resolve;
    rejectClassification = reject;
  });

  let shadowCtx = null;
  let finalized = false;
  const finalizeTurn = async (status) => {
    if (finalized) {
      return;
    }

    finalized = true;
    await classificationPromise.catch(() => null);
    await turn.finalize({ status });
  };

  const abortController = new AbortController();
  const upstreamRequest = transport.request(
    upstreamUrl,
    {
      method: req.method,
      headers: upstreamHeaders,
      signal: abortController.signal,
    },
    (upstreamResponse) => {
      turn.setResponseInfo({
        status: upstreamResponse.statusCode,
        headers: upstreamResponse.headers,
      });

      res.writeHead(upstreamResponse.statusCode ?? 502, filterResponseHeaders(upstreamResponse.headers));
      upstreamResponse.on('data', (chunk) => {
        turn.observeChunk(chunk);
        shadowCtx?.observeChunk(chunk);
      });

      upstreamResponse.on('error', async (error) => {
        log.error?.('[claude-proxy] upstream response error', {
          error: error.message,
          requestId,
        });
        res.destroy(error);
        await finalizeTurn(upstreamResponse.statusCode ?? 502);
      });

      upstreamResponse.on('end', async () => {
        shadowCtx?.complete();
        await finalizeTurn(upstreamResponse.statusCode ?? 200);
      });

      upstreamResponse.pipe(res);
    },
  );

  upstreamRequest.on('drain', () => {
    req.resume();
  });

  upstreamRequest.on('error', async (error) => {
    const status = abortController.signal.aborted ? 499 : 502;

    log.error?.('[claude-proxy] upstream request failed', {
      error: error.message,
      requestId,
      upstream: upstreamUrl.toString(),
      headers: sanitizeHeadersForLog(req.headers),
    });

    if (!res.headersSent) {
      res.writeHead(status, { 'content-type': 'application/json' });
    }

    if (!res.writableEnded) {
      res.end(jsonErrorBody(error, requestId));
    }

    rejectClassification(error);
    await finalizeTurn(status);
  });

  const requestChunks = [];

  req.on('data', (chunk) => {
    requestChunks.push(chunk);
    const canContinue = upstreamRequest.write(chunk);
    if (!canContinue) {
      req.pause();
    }
  });

  req.on('end', () => {
    const bodyBuffer = Buffer.concat(requestChunks);
    const classification = classifier.classify({
      headers: req.headers,
      bodyBuffer,
    });

    turn.setClassification(classification);
    resolveClassification(classification);
    shadowCtx = shadow?.maybeStart(classification, bodyBuffer);
    upstreamRequest.end();
  });

  req.on('aborted', () => {
    abortController.abort();
  });

  req.on('error', (error) => {
    rejectClassification(error);
    abortController.abort();
    res.destroy(error);
  });

  res.on('close', async () => {
    if (res.writableEnded) {
      return;
    }

    abortController.abort();
    await finalizeTurn(499);
  });
}

export async function startProxyServer(options = {}) {
  const logger = options.logger ?? new MetricsLogger();
  const classifier = options.classifier ?? createRequestClassifier();
  const configResult = options.config
    ? { config: mergeConfig(DEFAULT_CONFIG, options.config), configPath: null, loadedFromDisk: false }
    : await loadProxyConfig({ configPath: options.configPath });
  const config = configResult.config;
  const shadow = options.shadow ?? createShadowEvaluator({ config, log: options.log ?? console });
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 8080;
  const log = options.log ?? console;
  const sockets = new Set();

  let shuttingDown = false;
  let shutdownPromise = null;

  const server = http.createServer(async (req, res) => {
    if (shuttingDown) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'proxy_shutting_down' }));
      return;
    }

    try {
      await proxyRequest({ req, res, config, logger, classifier, log, shadow });
    } catch (error) {
      log.error?.('[claude-proxy] request handling failed', {
        error: error.message,
        headers: sanitizeHeadersForLog(req.headers),
      });

      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
      }

      if (!res.writableEnded) {
        res.end(JSON.stringify({ error: 'proxy_internal_error' }));
      }
    }
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
    });
  });

  await new Promise((resolve, reject) => {
    server.listen(port, host, (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });

  const shutdown = async (reason = 'shutdown') => {
    if (shutdownPromise) {
      return shutdownPromise;
    }

    shuttingDown = true;
    shutdownPromise = (async () => {
      const forceCloseTimer = setTimeout(() => {
        for (const socket of sockets) {
          socket.destroy();
        }
      }, 5_000);

      forceCloseTimer.unref?.();

      try {
        await closeServer(server);
        await logger.close();
      } finally {
        clearTimeout(forceCloseTimer);
        process.off('SIGINT', onSigint);
        process.off('SIGTERM', onSigterm);
        log.info?.('[claude-proxy] stopped', { reason });
      }
    })();

    return shutdownPromise;
  };

  const onSigint = () => {
    void shutdown('SIGINT');
  };

  const onSigterm = () => {
    void shutdown('SIGTERM');
  };

  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  return {
    server,
    host,
    port: server.address().port,
    config,
    classifier,
    logger,
    shadow,
    shutdown,
  };
}

export { DEFAULT_CONFIG };

