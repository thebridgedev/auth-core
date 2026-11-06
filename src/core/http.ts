import { BridgeError, errorFromAnswer } from './errors.js';

/**
 * The one way the SDK calls Bridge: JSON in and out, a bearer token in the
 * `Authorization` header and never in a body or URL, refusals as
 * `BridgeError`, and ETags for answers that can be revalidated.
 */

export type Fetch = typeof fetch;

export interface CallOptions {
  readonly method: string;
  readonly body?: unknown;
  /** The bearer token. Sent only in the `Authorization` header. */
  readonly token?: string | null;
  /** The app key, for the app's own server. Sent only in the `x-api-key` header. */
  readonly apiKey?: string | null;
  /** Sent as `If-None-Match`; a 304 answer comes back as `notModified`. */
  readonly etag?: string | null;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

export interface Answer<T> {
  readonly status: number;
  /** The parsed body; undefined for an empty body or a 304. */
  readonly body: T;
  readonly etag: string | null;
  readonly notModified: boolean;
}

/**
 * The platform `fetch`, bound so it can be stored and called as a method.
 * A browser's `fetch` throws "Illegal invocation" when called with `this`
 * set to anything but the window.
 */
export function platformFetch(): Fetch {
  if (typeof fetch === 'undefined') {
    return (() => Promise.reject(new BridgeError('misconfigured', 'There is no fetch in this runtime: pass one as `fetch`.'))) as unknown as Fetch;
  }
  const found = fetch;
  return ((input: Parameters<Fetch>[0], init?: Parameters<Fetch>[1]) => found.call(globalThis, input, init)) as Fetch;
}

async function readBody(response: Response): Promise<unknown> {
  const raw = await response.text();
  if (raw === '') return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export async function call<T>(fetchFn: Fetch, url: string, options: CallOptions): Promise<Answer<T>> {
  const headers: Record<string, string> = { Accept: 'application/json', ...options.headers };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.token) headers['Authorization'] = `Bearer ${options.token}`;
  if (options.apiKey) headers['x-api-key'] = options.apiKey;
  if (options.etag) headers['If-None-Match'] = options.etag;

  let response: Response;
  try {
    response = await fetchFn(url, {
      method: options.method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (cause) {
    if (options.signal?.aborted) throw cause;
    throw new BridgeError('network', `Could not reach Bridge (${options.method} ${new URL(url).pathname}).`, { cause });
  }

  const etag = response.headers.get('etag');
  if (response.status === 304) return { status: 304, body: undefined as T, etag: etag ?? options.etag ?? null, notModified: true };
  const body = await readBody(response);
  if (!response.ok) throw errorFromAnswer(response.status, body, response.headers);
  return { status: response.status, body: body as T, etag, notModified: false };
}
