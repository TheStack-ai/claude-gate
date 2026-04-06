import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

export function createMockRequest({ body, headers = {}, method = 'POST', url = '/v1/messages' }) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  const req = new PassThrough();

  req.method = method;
  req.url = url;
  req.headers = {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  };

  return {
    req,
    send() {
      req.end(payload);
    },
  };
}

export class MockResponse extends EventEmitter {
  constructor() {
    super();
    this.statusCode = null;
    this.headers = {};
    this.headersSent = false;
    this.writableEnded = false;
    this.chunks = [];
  }

  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode;
    this.headers = { ...headers };
    this.headersSent = true;
  }

  write(chunk) {
    if (chunk) {
      this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return true;
  }

  end(chunk) {
    if (chunk) {
      this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    this.writableEnded = true;
    this.emit('finish');
    this.emit('close');
  }

  get body() {
    return Buffer.concat(this.chunks);
  }
}

export function parseSseEvents(raw) {
  return raw
    .split('\n\n')
    .filter(Boolean)
    .map((frame) => {
      const eventLine = frame.split('\n').find((line) => line.startsWith('event: '));
      const dataLine = frame.split('\n').find((line) => line.startsWith('data: '));
      return {
        event: eventLine?.slice('event: '.length) ?? null,
        data: dataLine ? JSON.parse(dataLine.slice('data: '.length)) : null,
      };
    })
    .filter((frame) => frame.event && frame.data);
}
