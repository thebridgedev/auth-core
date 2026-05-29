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

export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  credentials?: RequestCredentials;
}

export async function httpFetch<T>(url: string, options: HttpOptions, logger: Logger): Promise<T> {
  const { method = 'GET', headers = {}, body, credentials } = options;

  const fetchOptions: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
  };

  if (body !== undefined) {
    fetchOptions.body = JSON.stringify(body);
  }

  if (credentials) {
    fetchOptions.credentials = credentials;
  }

  logger.debug(`${method} ${url}`);

  const response = await fetch(url, fetchOptions);

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
    const message = typeof errorBody === 'object' && errorBody && 'message' in errorBody
      ? String((errorBody as any).message)
      : `HTTP ${response.status}: ${response.statusText}`;
    throw new HttpError(message, response.status, errorBody);
  }

  const text = await response.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}
