// Frontend → backend context propagation (TBP-171).
//
// The frontend SDK serializes the eval context into a header on outgoing
// HTTP requests; the backend SDK / NestJS guard / Express middleware reads
// the same header and rehydrates the context for backend evals. Same flag,
// same answer, on both ends of the wire.
//
// Header name + format are part of the SDK ↔ backend contract — don't
// change without a coordinated rollout.

import { generateAnonymousId } from './identity.js';
import type { EvalContext } from './evaluator.js';

// Node-only global — runtime-guarded below via `typeof Buffer !== 'undefined'`.
// Declared here to keep auth-core dep-free (no @types/node) while still
// satisfying the type checker in browser-targeted lib settings.
declare const Buffer: any;

/** Canonical HTTP header carrying the serialized eval context. */
export const BRIDGE_CONTEXT_HEADER = 'x-bridge-context' as const;

/** Wire format version — bump when the JSON shape changes incompatibly. */
const WIRE_VERSION = 1;

interface WireContext {
  v: number;
  i?: string; // identity
  a?: Record<string, unknown>; // attributes
}

/** Serialize an eval context into a base64url-encoded JSON string. */
export function serializeContext(ctx: EvalContext): string {
  const wire: WireContext = { v: WIRE_VERSION };
  if (ctx.identity) wire.i = ctx.identity;
  // Omit empty attributes object — keep the wire small.
  if (ctx.attributes && Object.keys(ctx.attributes).length > 0) wire.a = ctx.attributes;
  return base64UrlEncode(JSON.stringify(wire));
}

/**
 * Parse the header value back into an EvalContext. Returns `undefined` if the
 * value is missing, malformed, or carries an unknown wire version. Callers
 * should treat undefined as "no context shipped" — never throw on the request
 * path.
 */
export function deserializeContext(headerValue: string | undefined | null): EvalContext | undefined {
  if (typeof headerValue !== 'string' || headerValue.length === 0) return undefined;
  let json: string;
  try {
    json = base64UrlDecode(headerValue);
  } catch {
    return undefined;
  }
  let parsed: WireContext;
  try {
    parsed = JSON.parse(json) as WireContext;
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  if (parsed.v !== WIRE_VERSION) return undefined;
  return {
    identity: typeof parsed.i === 'string' ? parsed.i : undefined,
    attributes: parsed.a && typeof parsed.a === 'object' ? { ...parsed.a } : {},
  };
}

/**
 * Generate a stable per-process server-instance ID for backend SDKs that
 * want to evaluate system-level flags (TBP-172). The first call mints a UUID
 * v4; subsequent calls return the same value for the lifetime of the process.
 *
 * The ID is INTENTIONALLY ephemeral across restarts — system flags should
 * target either a small set of stable identifiers (region, version, role) or
 * a hash of those, not the auto-generated process ID. The process ID is
 * primarily for telemetry / debugging where "which server replied to me"
 * matters.
 */
let _serverInstanceId: string | undefined;
export function serverInstanceId(): string {
  if (!_serverInstanceId) {
    _serverInstanceId = `srv_${generateAnonymousId().replace(/^anon_/, '')}`;
  }
  return _serverInstanceId;
}

/** Test-only — reset the cached server-instance id. */
export function __resetServerInstanceId(): void {
  _serverInstanceId = undefined;
}

// ── base64url helpers (no dep on Buffer; works in browser + node) ───────────

function base64UrlEncode(input: string): string {
  // Use globalThis.btoa when available (browsers, modern Node), fall back to Buffer.
  const g: any = globalThis as any;
  let b64: string;
  if (typeof g.btoa === 'function') {
    // btoa handles binary strings — convert UTF-8 to binary string first
    b64 = g.btoa(unescape(encodeURIComponent(input)));
  } else if (typeof Buffer !== 'undefined') {
    b64 = Buffer.from(input, 'utf-8').toString('base64');
  } else {
    throw new Error('No base64 encoder available');
  }
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(input: string): string {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (input.length % 4)) % 4);
  const g: any = globalThis as any;
  if (typeof g.atob === 'function') {
    return decodeURIComponent(escape(g.atob(padded)));
  }
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(padded, 'base64').toString('utf-8');
  }
  throw new Error('No base64 decoder available');
}
