/**
 * Fixtures for the revocation puller: lane signing keys, signed entries and a
 * stand-in for the server that serves the list.
 *
 * Every key is generated inside the test run. Nothing here may use a
 * Node-only API: the same fixtures run on Node and in an edge runtime.
 */
import { CompactSign, exportJWK, generateKeyPair, type JWK } from 'jose';
import { APP, decodeSegment, encodeSegment } from './fixtures.js';

export const LIST_URL = 'https://auth.example.test/revocations';
export const REVOCATION_JWKS_URL = 'https://auth.example.test/.well-known/jwks.json';
export const LANES = ['sessions', 'members', 'billing', 'apps'] as const;
export type Lane = (typeof LANES)[number];

export function laneUrls(lanes: readonly string[] = LANES): Record<string, string> {
  return Object.fromEntries(lanes.map((lane) => [lane, `${LIST_URL}/${lane}`]));
}

export interface LaneKey {
  kid: string;
  lane: string;
  privateKey: CryptoKey;
  /** The public key as published in the app's key set, bound to its lane. */
  publicJwk: JWK & { lane?: string };
}

export async function makeLaneKey(lane: string, kid = `${lane}-key-1`): Promise<LaneKey> {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: 'ES256', use: 'sig', lane };
  return { kid, lane, privateKey, publicJwk };
}

const encoder = new TextEncoder();

export interface SignOptions {
  kid?: string;
  typ?: string | null;
}

/** Sign an entry's payload the way a writer does: a compact JWS, ES256. */
export async function signEntry(key: LaneKey, payload: Record<string, unknown>, options: SignOptions = {}): Promise<string> {
  const header: Record<string, unknown> = { alg: 'ES256', kid: options.kid ?? key.kid };
  if (options.typ !== null) header.typ = options.typ ?? 'revocation+jws';
  return new CompactSign(encoder.encode(JSON.stringify(payload)))
    .setProtectedHeader(header as { alg: string })
    .sign(key.privateKey);
}

/** An unsigned entry (`alg: none`). */
export function unsignedEntry(payload: Record<string, unknown>): string {
  return `${encodeSegment({ alg: 'none', typ: 'revocation+jws' })}.${encodeSegment(payload)}.`;
}

/** What a writer asks for; the list adds the app, lane, number and time. */
export type Revocation = Record<string, unknown> & { kind: string };

const CUTOFF_SKEW_MS = 2000;
const WITHOUT_CUTOFF = new Set(['token', 'session', 'key']);

interface Stored {
  seq: number;
  jws: string;
}

/**
 * A stand-in for the list server: one app, one numbered list per lane, each
 * entry signed with its lane's key. `serve` lets a test change what is
 * served, to drop, alter or add entries.
 */
export function fakeRevocationList(keys: Record<string, LaneKey>, app = APP) {
  const lanes = new Map<string, Stored[]>();
  const requests: { lane: string; after: number; limit: number; v: string | null }[] = [];
  let down = false;
  let jwks: { keys: JWK[] } = { keys: Object.values(keys).map((key) => key.publicJwk) };
  let keySetFetches = 0;
  const state = {
    /** Changes the page a lane serves. Gets the entries after the cursor and the head. */
    serve: null as null | ((lane: string, page: Stored[], head: number) => { entries: unknown[]; head: number } | null),
  };

  async function revoke(lane: string, revocation: Revocation, keyOverride?: LaneKey): Promise<Stored> {
    const list = lanes.get(lane) ?? [];
    const seq = list.length + 1;
    const at = Date.now();
    const payload: Record<string, unknown> = { v: 1, app, lane, seq, at, ...revocation };
    if (!WITHOUT_CUTOFF.has(revocation.kind) && payload.before === undefined) payload.before = at + CUTOFF_SKEW_MS;
    const key = keyOverride ?? keys[lane];
    if (!key) throw new Error(`no key for lane ${lane}`);
    const stored = { seq, jws: await signEntry(key, payload) };
    list.push(stored);
    lanes.set(lane, list);
    return stored;
  }

  const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.href === REVOCATION_JWKS_URL) {
      keySetFetches += 1;
      return Response.json(jwks);
    }
    if (!url.href.startsWith(`${LIST_URL}/`)) return new Response('not found', { status: 404 });
    if (down) throw new TypeError('fetch failed');
    const lane = url.pathname.split('/').pop() ?? '';
    const after = Number(url.searchParams.get('after'));
    const limit = Number(url.searchParams.get('limit'));
    requests.push({ lane, after, limit, v: url.searchParams.get('v') });
    const list = lanes.get(lane) ?? [];
    const page = list.filter((entry) => entry.seq > after).slice(0, limit);
    const custom = state.serve?.(lane, page, list.length) ?? null;
    const entries = custom ? custom.entries : page.map((entry) => entry.jws);
    const head = custom ? custom.head : list.length;
    return Response.json({ v: 1, app, lane, head, entries });
  };

  return {
    fetch: fetchImpl as typeof fetch,
    revoke,
    requests,
    state,
    entries: (lane: string) => lanes.get(lane) ?? [],
    setDown(value: boolean) {
      down = value;
    },
    setKeys(keySet: { keys: JWK[] }) {
      jwks = keySet;
    },
    get jwks() {
      return jwks;
    },
    get keySetFetches() {
      return keySetFetches;
    },
  };
}

/** Change a signed entry's payload and keep its original signature. */
export function alterEntry(jws: string, change: (payload: Record<string, unknown>) => void): string {
  const [header, payload, signature] = jws.split('.');
  const decoded = decodeSegment(payload);
  change(decoded);
  return `${header}.${encodeSegment(decoded)}.${signature}`;
}
