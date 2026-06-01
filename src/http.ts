import { BillingLockedError, HttpError } from './errors.js';
import { emitBillingLock } from './billing/lock-signal.js';
import type { BillingLockedPayload } from './billing/types.js';
import type { Logger } from './logger.js';

function isBillingLockedPayload(body: unknown): body is BillingLockedPayload {
  return (
    typeof body === 'object' &&
    body !== null &&
    (body as { reason?: unknown }).reason === 'billing_locked'
  );
}

function isTokenVersionStale(status: number, body: unknown): boolean {
  return (
    status === 401 &&
    typeof body === 'object' &&
    body !== null &&
    (body as { code?: unknown }).code === 'TOKEN_VERSION_STALE'
  );
}

export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  credentials?: RequestCredentials;
  /** Called when a 401 TOKEN_VERSION_STALE is detected. Should return a fresh
   *  access token (or null if refresh fails). When provided the request is
   *  retried once with the new token; without it the HttpError is thrown as usual. */
  onTokenStale?: () => Promise<string | null>;
}

export async function httpFetch<T>(url: string, options: HttpOptions, logger: Logger): Promise<T> {
  const { method = 'GET', headers = {}, body, credentials, onTokenStale } = options;

  const buildFetchOptions = (hdrs: Record<string, string>): RequestInit => {
    const init: RequestInit = {
      method,
      headers: { 'Content-Type': 'application/json', ...hdrs },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    if (credentials) init.credentials = credentials;
    return init;
  };

  logger.debug(`${method} ${url}`);

  const response = await fetch(url, buildFetchOptions(headers));

  if (!response.ok) {
    let errorBody: unknown;
    try {
      errorBody = await response.json();
    } catch {
      errorBody = await response.text().catch(() => null);
    }

    if (response.status === 402 && isBillingLockedPayload(errorBody)) {
      emitBillingLock(errorBody);
      throw new BillingLockedError(errorBody);
    }

    // TOKEN_VERSION_STALE on REST 401s: refresh and retry once (same mechanism
    // as the WebSocket user.state_changed path; dedup gate in BridgeAuth
    // prevents a double HTTP call if both paths fire simultaneously).
    if (isTokenVersionStale(response.status, errorBody) && onTokenStale) {
      const freshToken = await onTokenStale().catch(() => null);
      if (freshToken) {
        const retryResponse = await fetch(url, buildFetchOptions({ ...headers, Authorization: `Bearer ${freshToken}` }));
        if (retryResponse.ok) {
          const retryText = await retryResponse.text();
          if (!retryText) return undefined as T;
          return JSON.parse(retryText) as T;
        }
      }
    }

    const message = typeof errorBody === 'object' && errorBody && 'message' in errorBody
      ? String((errorBody as any).message)
      : `HTTP ${response.status}: ${response.statusText}`;
    throw new HttpError(message, response.status, errorBody);
  }

  const text = await response.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}
