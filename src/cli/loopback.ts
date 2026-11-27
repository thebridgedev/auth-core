/// <reference types="node" />
/**
 * The one-request loopback listener for browser sign-in (RFC 8252): bound to
 * `127.0.0.1` on a port the system picks, it takes the browser's return to
 * `/callback`, checks `state` (in constant time) and the issuer the page names
 * (`iss`, RFC 9207), answers with a short page, and closes.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { BridgeError } from '../core/errors.js';
import { HANDOFF_CALLBACK_PATH } from '../handoff.js';

export interface CallbackParams {
  readonly code?: string;
  readonly state?: string;
  readonly iss?: string;
  readonly error?: string;
  readonly errorDescription?: string;
}

/** Reads the browser's return. Exposed for tests. */
export function readCallback(rawUrl: string): CallbackParams & { readonly pathname: string } {
  const url = new URL(rawUrl, 'http://127.0.0.1');
  const get = (name: string) => url.searchParams.get(name) ?? undefined;
  return { code: get('code'), state: get('state'), iss: get('iss'), error: get('error'), errorDescription: get('error_description'), pathname: url.pathname };
}

function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

/**
 * Checks the browser's return against this sign-in: the same `state`, the
 * issuer it signs in to, and a code. Throws a `BridgeError` saying what is
 * wrong; never returns a code it should not trade.
 */
export function checkCallback(params: CallbackParams, expected: { readonly state: string; readonly issuer: string }): { code: string } {
  // The state first: an error from a sign-in this process never started is not reported as its own.
  if (params.state === undefined || !sameText(params.state, expected.state)) {
    throw new BridgeError('invalid', 'The sign-in came back with another state, so it is not this sign-in. Run login again.', { code: 'state_mismatch' });
  }
  if (params.error !== undefined) {
    if (params.error === 'access_denied') throw new BridgeError('cancelled', 'Sign-in was refused in the browser.', { code: 'access_denied' });
    throw new BridgeError('invalid', `Sign-in failed (${params.error})${params.errorDescription ? `: ${params.errorDescription}` : ''}.`, { code: params.error });
  }
  // RFC 9207: the return names its issuer, and it is the one this sign-in is for.
  if (params.iss === undefined) throw new BridgeError('invalid', 'The sign-in came back without naming its issuer (iss), so it is not traded.', { code: 'issuer_missing' });
  if (params.iss !== expected.issuer) throw new BridgeError('invalid', 'The sign-in came back from another issuer, so it is not traded.', { code: 'issuer_mismatch' });
  if (params.code === undefined || params.code === '') throw new BridgeError('invalid', 'The sign-in came back without a code.', { code: 'invalid_callback' });
  return { code: params.code };
}

export interface Loopback {
  /** `http://127.0.0.1:<port>/callback`. */
  readonly redirectUri: string;
  /** The checked code, once the browser comes back. */
  readonly result: Promise<{ code: string }>;
  close(): void;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function page(title: string, message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style>:root{color-scheme:light dark}body{font-family:system-ui,-apple-system,sans-serif;display:flex;min-height:100vh;margin:0;align-items:center;justify-content:center}main{max-width:28rem;padding:2rem;text-align:center}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0;opacity:.75}</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body></html>`;
}

/** Starts the listener. `name` is the CLI's name, for the page the browser shows. */
export async function startLoopback(options: { readonly state: string; readonly issuer: string; readonly name: string; readonly timeoutMs?: number }): Promise<Loopback> {
  let settle!: { resolve: (value: { code: string }) => void; reject: (error: Error) => void };
  const result = new Promise<{ code: string }>((resolve, reject) => {
    settle = { resolve, reject };
  });
  result.catch(() => undefined);

  const server = createServer((req, res) => {
    const params = readCallback(req.url ?? '/');
    if (params.pathname !== HANDOFF_CALLBACK_PATH || (req.method ?? 'GET') !== 'GET') {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Not found');
      return;
    }
    const done = () => {
      server.close();
      server.closeAllConnections();
    };
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Connection', 'close');
    try {
      const checked = checkCallback(params, options);
      res.statusCode = 200;
      res.end(page('Signed in', `You can close this tab and go back to ${options.name} in your terminal.`), done);
      settle.resolve(checked);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      res.statusCode = 400;
      res.end(page('Sign-in failed', failure.message), done);
      settle.reject(failure);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;
  const timer = setTimeout(() => {
    settle.reject(new BridgeError('flow-expired', `No sign-in came back from the browser within ${Math.round(timeoutMs / 1000)} seconds. Run login again.`, { code: 'timeout' }));
    server.close();
    server.closeAllConnections();
  }, timeoutMs);
  timer.unref?.();
  void result.finally(() => clearTimeout(timer)).catch(() => undefined);

  return {
    redirectUri: `http://127.0.0.1:${String(port)}${HANDOFF_CALLBACK_PATH}`,
    result,
    close() {
      clearTimeout(timer);
      server.close();
      server.closeAllConnections();
    },
  };
}
