/**
 * Minimal, dependency-light HTTP client for the SendByte REST API.
 *
 * This intentionally mirrors the request/retry/error semantics of the official
 * `@sendbyte/node` SDK (exponential backoff with jitter, Retry-After support,
 * typed errors, auto idempotency key for sends) so the MCP server is just as
 * resilient, while staying self-contained: the MCP package ships and versions
 * independently and exposes a few endpoints the SDK does not yet wrap
 * (templates, analytics, content scan).
 */

import { randomUUID } from 'node:crypto';

const DEFAULT_BASE_URL = 'https://api.sendbyte.africa';
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BACKOFF_MS = 20_000;

export interface ClientOptions {
  /** Override the API host (self-hosted, staging, or local development). */
  baseUrl?: string;
  /** Injectable fetch for testing. Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Total attempts per request, including the first. Defaults to 3. */
  maxAttempts?: number;
  /** Per-attempt timeout in milliseconds. Defaults to 30000. */
  timeoutMs?: number;
}

/** A typed API error carrying the SendByte error shape (code, message, docs_url). */
export class SendByteError extends Error {
  readonly code: string;
  readonly status: number;
  readonly docsUrl?: string;

  constructor(code: string, message: string, status: number, docsUrl?: string) {
    super(message);
    this.name = 'SendByteError';
    this.code = code;
    this.status = status;
    if (docsUrl !== undefined) this.docsUrl = docsUrl;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** https is required; http is tolerated only for localhost/loopback dev hosts. */
function isSecureBaseUrl(baseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  const host = url.hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

function parseError(text: string, status: number): SendByteError {
  let json: Record<string, unknown> = {};
  if (text) {
    try {
      const parsed = JSON.parse(text);
      if (isRecord(parsed)) json = parsed;
    } catch {
      return new SendByteError('request_failed', `Request failed with status ${status}.`, status);
    }
  }
  const error = (json as { error?: { code?: string; message?: string; docs_url?: string } }).error;
  return new SendByteError(
    error?.code ?? 'request_failed',
    error?.message ?? `Request failed with status ${status}`,
    status,
    error?.docs_url
  );
}

function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function backoffDelay(attempt: number, retryAfter: string | null | undefined): number {
  const afterMs = parseRetryAfter(retryAfter);
  if (afterMs !== undefined) return Math.min(afterMs, DEFAULT_MAX_BACKOFF_MS);
  const base = Math.min(DEFAULT_MAX_BACKOFF_MS, 250 * 2 ** (attempt - 1));
  return Math.floor(Math.random() * base);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SendByteClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxAttempts: number;
  private readonly timeoutMs: number;

  constructor(apiKey: string, options: ClientOptions = {}) {
    if (!apiKey || (!apiKey.startsWith('sk_live_') && !apiKey.startsWith('sk_test_'))) {
      throw new SendByteError(
        'invalid_api_key',
        'API key must start with sk_live_ or sk_test_. Create one in the SendByte dashboard under API keys.',
        0
      );
    }
    this.apiKey = apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.fetchImpl = options.fetch ?? fetch;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    this.timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    if (apiKey.startsWith('sk_live_') && !isSecureBaseUrl(this.baseUrl)) {
      throw new SendByteError(
        'insecure_base_url',
        'Refusing to send a live API key (sk_live_) over an insecure base URL. Use https, or a test key for local http.',
        0
      );
    }
  }

  /** Build a query string from defined params (skips undefined/null). */
  static query(params: Record<string, string | number | undefined>): string {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) q.set(k, String(v));
    }
    const s = q.toString();
    return s ? `?${s}` : '';
  }

  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    // Auto-generate an idempotency key for sends and reuse it across retries so
    // a retried POST /v1/emails cannot double-send. Body-based, matching the API.
    let payload = body;
    if (
      method === 'POST' &&
      path === '/v1/emails' &&
      isRecord(payload) &&
      payload['idempotency_key'] === undefined
    ) {
      payload = { ...payload, idempotency_key: randomUUID() };
    }

    let lastError: SendByteError | undefined;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      let res: Response;
      try {
        res = await this.fetchOnce(method, path, payload);
      } catch (err) {
        lastError = new SendByteError(
          'request_failed',
          `Could not reach the SendByte API: ${err instanceof Error ? err.message : String(err)}`,
          0
        );
        if (attempt < this.maxAttempts) {
          await sleep(backoffDelay(attempt, undefined));
          continue;
        }
        throw lastError;
      }

      const text = await res.text();

      if (!res.ok) {
        if (isRetryableStatus(res.status) && attempt < this.maxAttempts) {
          lastError = parseError(text, res.status);
          await sleep(backoffDelay(attempt, res.headers.get('retry-after')));
          continue;
        }
        throw parseError(text, res.status);
      }

      if (!text) return {} as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new SendByteError(
          'invalid_response',
          `The API returned a 2xx response that was not valid JSON (status ${res.status}).`,
          res.status
        );
      }
    }

    throw (
      lastError ??
      new SendByteError('request_failed', 'Request failed after exhausting retries.', 0)
    );
  }

  private fetchOnce(method: string, path: string, payload: unknown): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    return this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'user-agent': 'sendbyte-mcp/0.1.0',
        ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      signal: controller.signal,
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
    }).finally(() => clearTimeout(timer));
  }
}
