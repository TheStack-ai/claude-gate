import http from 'node:http';
import https from 'node:https';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { createRequestClassifier } from './classifier.mjs';
import { respondWithOpenAICompletion, shouldHandle529Fallback, supportsOpenAIProxyResponse } from './fallback.mjs';
import { MetricsLogger } from './logger.mjs';
import { selectRoute } from './router.mjs';
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

function tryParseJsonBuffer(bodyBuffer) {
  if (!Buffer.isBuffer(bodyBuffer) || bodyBuffer.length === 0) {
    return null;
  }

  try {
    return JSON.parse(bodyBuffer.toString('utf8'));
  } catch {
    return null;
  }
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    req.on('data', (chunk) => {
      chunks.push(chunk);
    });

    req.on('end', () => {
      resolve(Buffer.concat(chunks));
    });

    req.on('aborted', () => {
      const error = new Error('client_aborted');
      error.proxyStatus = 499;
      reject(error);
    });

    req.on('error', reject);
  });
}

function normalizeExecutorResponseBody(body) {
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

export async function proxyRequest({
  req,
  res,
  config,
  logger,
  classifier,
  log,
  shadow,
  anthropicExecutor = null,
  openAIRequestImpl = null,
}) {
  const requestStartedAt = Date.now();
  const requestId = normalizeHeaderValue(req.headers['x-client-request-id']);
  const sessionId = normalizeHeaderValue(req.headers['x-claude-code-session-id']);
  const bodyBuffer = await readRequestBody(req);
  const classification = classifier.classify({
    headers: req.headers,
    bodyBuffer,
  });
  const parsedBody = tryParseJsonBuffer(bodyBuffer);
  const turn = logger.createTurnContext({
    sessionId,
    requestId,
    requestStartedAt,
    routedTo: 'anthropic',
  });

  turn.setClassification(classification);

  let finalized = false;
  const finalizeTurn = async (status) => {
    if (finalized) {
      return;
    }

    finalized = true;
    await turn.finalize({ status });
  };

  const route = selectRoute(classification, config);
  const canUseOpenAIResponse = supportsOpenAIProxyResponse(parsedBody);

  if (route?.target === 'openai' && canUseOpenAIResponse) {
    try {
      await respondWithOpenAICompletion({
        res,
        turn,
        bodyBuffer,
        config,
        model: route.model,
        requestImpl: openAIRequestImpl,
        routedTo: 'openai',
      });
      await finalizeTurn(200);
      return;
    } catch (error) {
      log.error?.('[claude-proxy] openai route failed; falling back to anthropic', {
        error: error.message,
        requestId,
        route: route.name,
      });
    }
  } else if (route?.target === 'openai' && !canUseOpenAIResponse) {
    log.info?.('[claude-proxy] skipping openai route for streaming request', {
      requestId,
      route: route.name,
      querySource: classification.querySource,
    });
  }

  const upstreamBaseUrl = new URL(config.anthropic.base_url);
  const upstreamUrl = new URL(req.url ?? '/', upstreamBaseUrl);
  const upstreamHeaders = filterProxyHeaders(req.headers, upstreamUrl.host);
  const transport = selectTransport(upstreamUrl);
  const abortController = new AbortController();
  let shadowCtx = null;

  res.on('close', () => {
    if (!res.writableEnded) {
      abortController.abort();
    }
  });

  try {
    if (typeof anthropicExecutor === 'function') {
      const upstreamResponse = await anthropicExecutor({
        url: upstreamUrl,
        method: req.method,
        headers: upstreamHeaders,
        bodyBuffer,
        signal: abortController.signal,
      });
      const statusCode = upstreamResponse?.statusCode ?? 502;
      const responseHeaders = upstreamResponse?.headers ?? {};
      const responseBody = normalizeExecutorResponseBody(upstreamResponse?.body);

      if (statusCode === 529) {
        const fallbackEligible = shouldHandle529Fallback({
          config,
          classification,
          responseBytes: 0,
          anthropicBody: parsedBody,
        });

        if (fallbackEligible) {
          try {
            await respondWithOpenAICompletion({
              res,
              turn,
              bodyBuffer,
              config,
              model: config?.openai?.default_model,
              requestImpl: openAIRequestImpl,
              routedTo: 'openai_fallback',
            });
            await finalizeTurn(200);
            return;
          } catch (error) {
            log.error?.('[claude-proxy] 529 fallback to openai failed; returning anthropic 529', {
              error: error.message,
              requestId,
            });
          }
        }

        turn.setResponseInfo({
          status: statusCode,
          headers: responseHeaders,
        });
        if (responseBody.length > 0) {
          turn.observeChunk(responseBody);
        }

        res.writeHead(statusCode, filterResponseHeaders(responseHeaders));
        res.end(responseBody);
        await finalizeTurn(statusCode);
        return;
      }

      turn.setResponseInfo({
        status: statusCode,
        headers: responseHeaders,
      });
      shadowCtx = shadow?.maybeStart(classification, bodyBuffer);
      if (responseBody.length > 0) {
        turn.observeChunk(responseBody);
        shadowCtx?.observeChunk(responseBody);
      }
      shadowCtx?.complete();

      res.writeHead(statusCode, filterResponseHeaders(responseHeaders));
      res.end(responseBody);
      await finalizeTurn(statusCode);
      return;
    }

    const status = await new Promise((resolve, reject) => {
      const upstreamRequest = transport.request(
        upstreamUrl,
        {
          method: req.method,
          headers: upstreamHeaders,
          signal: abortController.signal,
        },
        (upstreamResponse) => {
          void (async () => {
            try {
              if (upstreamResponse.statusCode === 529) {
                const chunks = [];

                upstreamResponse.on('data', (chunk) => {
                  chunks.push(chunk);
                });

                upstreamResponse.on('error', reject);

                upstreamResponse.on('end', async () => {
                  const responseBody = Buffer.concat(chunks);
                  const fallbackEligible = shouldHandle529Fallback({
                    config,
                    classification,
                    responseBytes: 0,
                    anthropicBody: parsedBody,
                  });

                  if (fallbackEligible) {
                    try {
                      await respondWithOpenAICompletion({
                        res,
                        turn,
                        bodyBuffer,
                        config,
                        model: config?.openai?.default_model,
                        requestImpl: openAIRequestImpl,
                        routedTo: 'openai_fallback',
                      });
                      resolve(200);
                      return;
                    } catch (error) {
                      log.error?.('[claude-proxy] 529 fallback to openai failed; returning anthropic 529', {
                        error: error.message,
                        requestId,
                      });
                    }
                  }

                  turn.setResponseInfo({
                    status: upstreamResponse.statusCode,
                    headers: upstreamResponse.headers,
                  });
                  if (responseBody.length > 0) {
                    turn.observeChunk(responseBody);
                  }

                  res.writeHead(upstreamResponse.statusCode ?? 529, filterResponseHeaders(upstreamResponse.headers));
                  res.end(responseBody);
                  resolve(upstreamResponse.statusCode ?? 529);
                });

                return;
              }

              turn.setResponseInfo({
                status: upstreamResponse.statusCode,
                headers: upstreamResponse.headers,
              });
              shadowCtx = shadow?.maybeStart(classification, bodyBuffer);

              res.writeHead(upstreamResponse.statusCode ?? 502, filterResponseHeaders(upstreamResponse.headers));
              upstreamResponse.on('data', (chunk) => {
                turn.observeChunk(chunk);
                shadowCtx?.observeChunk(chunk);
              });
              upstreamResponse.on('error', reject);
              upstreamResponse.on('end', () => {
                shadowCtx?.complete();
                resolve(upstreamResponse.statusCode ?? 200);
              });
              upstreamResponse.pipe(res);
            } catch (error) {
              reject(error);
            }
          })();
        },
      );

      upstreamRequest.on('error', reject);
      upstreamRequest.end(bodyBuffer);
    });

    await finalizeTurn(status);
  } catch (error) {
    const status = abortController.signal.aborted ? 499 : (error.proxyStatus ?? 502);

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

    await finalizeTurn(status);
  }
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

      const status = error.proxyStatus ?? 500;

      if (!res.headersSent) {
        res.writeHead(status, { 'content-type': 'application/json' });
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
