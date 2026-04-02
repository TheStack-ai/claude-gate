const DEFAULT_MAX_ENTRIES = 100;
const DEFAULT_TTL_MS = 5 * 60 * 1000;

function cloneHeaderValue(value) {
  if (Array.isArray(value)) {
    return value.slice();
  }

  return value;
}

function cloneHeaders(headers = {}) {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, cloneHeaderValue(value)]),
  );
}

function cloneBody(body) {
  if (Buffer.isBuffer(body)) {
    return Buffer.from(body);
  }

  if (body && typeof body === 'object') {
    return structuredClone(body);
  }

  return body;
}

export function requestIdFromHeaders(headers = {}) {
  const value = headers['x-client-request-id'] ?? headers['X-Client-Request-Id'] ?? null;
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value;
}

export function cloneCachedResponse(response = {}) {
  return {
    ...response,
    headers: cloneHeaders(response.headers),
    body: cloneBody(response.body),
  };
}

export class RetryResponseCache {
  constructor(options = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? {};
    this.entries = new Map();
  }

  has(requestId) {
    return this.get(requestId) !== null;
  }

  get(requestId) {
    if (!requestId) {
      return null;
    }

    this.#purgeExpired();
    const entry = this.entries.get(requestId);
    if (!entry) {
      return null;
    }

    this.entries.delete(requestId);
    this.entries.set(requestId, entry);

    const ageMs = this.now() - entry.storedAt;
    this.log.info?.('[claude-gate] retry response cache hit', {
      event: 'retry_response_cache_hit',
      request_id: requestId,
      age_ms: ageMs,
      ttl_ms: this.ttlMs,
      size: this.entries.size,
    });

    return cloneCachedResponse(entry.response);
  }

  set(requestId, response) {
    if (!requestId) {
      return null;
    }

    this.#purgeExpired();
    if (this.entries.has(requestId)) {
      this.entries.delete(requestId);
    }

    const entry = {
      storedAt: this.now(),
      response: cloneCachedResponse(response),
    };

    this.entries.set(requestId, entry);
    this.#evictOverflow();

    return cloneCachedResponse(entry.response);
  }

  delete(requestId) {
    return this.entries.delete(requestId);
  }

  clear() {
    this.entries.clear();
  }

  get size() {
    this.#purgeExpired();
    return this.entries.size;
  }

  #purgeExpired() {
    const cutoff = this.now() - this.ttlMs;

    for (const [requestId, entry] of this.entries) {
      if (entry.storedAt <= cutoff) {
        this.entries.delete(requestId);
      }
    }
  }

  #evictOverflow() {
    while (this.entries.size > this.maxEntries) {
      const oldestRequestId = this.entries.keys().next().value;
      if (!oldestRequestId) {
        return;
      }

      this.entries.delete(oldestRequestId);
    }
  }
}

export function createRetryResponseCache(options) {
  return new RetryResponseCache(options);
}
