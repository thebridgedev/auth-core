import { compactVerify, importJWK, type JSONWebKeySet, type JWK } from 'jose';
import type { Actor } from './actor.js';
import {
  REVOCATION_ALGORITHMS,
  REVOCATION_ENTRY_TYPE,
  REVOCATION_FORMAT_VERSION,
  RevocationIndex,
  parseRevocationEntry,
  type RevocationEntry,
} from './revocation-entry.js';
import type { RevocationCheck, RevocationVerdict } from './revocation.js';

/**
 * The revocation puller: a verifier's own copy of the app's revocation list.
 *
 * Tokens are checked by signature, without asking the issuer each time, so a
 * token stays valid until it expires. The revocation list is how access is
 * taken away sooner: every change that takes access away writes a signed,
 * numbered entry, and every verifier follows the list and refuses what it
 * names within seconds.
 *
 * The puller keeps a copy in memory and, every few seconds, fetches only the
 * entries it has not seen yet. It checks every entry's signature against the
 * app's published keys and never accepts an unsigned or altered one. It fails
 * closed: until its copy has loaded every lane, while any lane is out of step
 * (a gap in the numbering, an entry that fails its check, a list that went
 * backwards), and when its copy falls further behind than the limit, its
 * check throws, so the verifier refuses with `unavailable` instead of
 * accepting.
 *
 * Uses only `fetch` and Web Crypto, so it runs on servers and at the edge.
 */

/** Thrown by a puller's check while its copy of the list cannot be trusted. The verifier refuses with `unavailable`. */
export class RevocationListUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RevocationListUnavailableError';
  }
}

export interface RevocationPullerOptions {
  /** The app whose list this is. Entries for any other app are refused. */
  appId: string;
  /**
   * The lanes to follow, each with the URL its entries are served from. Every
   * lane must load before any check passes. The puller adds the query
   * parameters `v`, `after` and `limit` to each URL.
   */
  lanes: Readonly<Record<string, string>>;
  /** Where the app's public keys are published (a JSON Web Key Set URL), including the lanes' keys. */
  jwksUrl?: string;
  /** The published keys themselves, instead of `jwksUrl`. */
  jwks?: JSONWebKeySet;
  /** How often to fetch new entries. @default 2000 */
  intervalMs?: number;
  /**
   * How far behind the copy may fall before every check refuses. Measured
   * from the last fetch that reached the end of every lane.
   * @default 300000 (5 minutes, one access-token lifetime)
   */
  maxLagMs?: number;
  /** How long to wait for one fetch. @default 5000 */
  timeoutMs?: number;
  /** How many entries to ask for per fetch. @default 500 */
  pageSize?: number;
  /** Headers sent with every list fetch, for example the app's key. Never logged. */
  headers?: Readonly<Record<string, string>>;
  /** The fetch used for the list and the key set. @default the global fetch */
  fetch?: typeof fetch;
  /**
   * Called once for every accepted entry, in order. For code that keeps
   * something derived from what an entry changes, such as a cache of who owns
   * an app, and must drop it.
   */
  onEntry?: (entry: RevocationEntry) => void;
  /** Optional debug logger. Never receives a credential or a header. */
  log?: (message: string, details?: Record<string, unknown>) => void;
  /** The clock, in milliseconds. For tests. @default Date.now */
  now?: () => number;
}

export interface RevocationLaneStatus {
  readonly lane: string;
  /** The number of the last entry accepted. 0 before any. */
  readonly seq: number;
  /** The last entry the list said it had. */
  readonly head: number;
  /** When a fetch that reached the end of the lane was sent, in ms. Null before the first. */
  readonly caughtUpAt: number | null;
  /** Why the lane cannot be trusted right now, or null. */
  readonly problem: string | null;
  /** Why the last fetch failed, or null. The copy only falls behind while this lasts. */
  readonly error: string | null;
}

export interface RevocationListStatus {
  /** Every lane has loaded at least once. */
  readonly ready: boolean;
  /** How far behind the copy is, in ms. Infinity until it is ready. */
  readonly lagMs: number;
  readonly lanes: readonly RevocationLaneStatus[];
}

export interface RevocationPuller {
  /**
   * The check to give the verifier as `revocationCheck`. Throws while the
   * copy cannot be trusted or is more than `maxLagMs` behind.
   */
  readonly check: RevocationCheck;
  /**
   * The same check with a stricter limit, for example 30 seconds for writes
   * and sensitive actions.
   */
  checkWithin(maxLagMs: number): RevocationCheck;
  /** Fetch new entries now. Never rejects; `status()` says how it went. */
  sync(): Promise<void>;
  /** Start fetching every `intervalMs`. Without it, checks still fetch when the copy is behind. */
  start(): RevocationPuller;
  /** Stop fetching on a timer. */
  stop(): void;
  status(): RevocationListStatus;
}

const DEFAULT_INTERVAL_MS = 2000;
const DEFAULT_MAX_LAG_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_PAGE_SIZE = 500;
const MAX_PAGES_PER_SYNC = 1000;
const KEY_SET_TTL_MS = 60 * 60 * 1000;
const KEY_SET_COOLDOWN_MS = 30 * 1000;

interface LaneState {
  readonly lane: string;
  readonly url: string;
  seq: number;
  head: number;
  caughtUpAt: number | null;
  problem: string | null;
  error: string | null;
}

interface LaneKey {
  readonly lane: string;
  readonly jwk: JWK;
  key?: CryptoKey | Uint8Array;
}

/** An entry that is refused, with the reason. */
class EntryRefused extends Error {}

/** The published keys could not be loaded, so no entry can be checked yet. */
class KeySetUnavailable extends Error {}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function timeoutSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(ms)
    : undefined;
}

/**
 * The lanes' public keys, from the app's key set. A lane key is an EC P-256
 * key with a `kid` and a `lane` member naming the lane it signs for; every
 * other key in the set (such as the token signing keys) is ignored. A key id
 * used twice is ignored too, so an entry signed with it is refused.
 */
function readLaneKeys(set: unknown): Map<string, LaneKey> {
  const found = new Map<string, LaneKey>();
  const seen = new Set<string>();
  const keys = (set as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys)) return found;
  for (const candidate of keys) {
    const k = candidate as Record<string, unknown> | null;
    if (!k || typeof k !== 'object' || !isText(k.kid) || !isText(k.lane)) continue;
    if (seen.has(k.kid)) {
      found.delete(k.kid);
      continue;
    }
    seen.add(k.kid);
    const usable =
      k.kty === 'EC' &&
      k.crv === 'P-256' &&
      isText(k.x) &&
      isText(k.y) &&
      k.d === undefined &&
      (k.alg === undefined || k.alg === 'ES256') &&
      (k.use === undefined || k.use === 'sig');
    if (!usable) continue;
    found.set(k.kid, { lane: k.lane, jwk: { kty: 'EC', crv: 'P-256', x: k.x as string, y: k.y as string } });
  }
  return found;
}

/**
 * Create a revocation puller for one app.
 *
 * ```ts
 * const revocations = createRevocationPuller({
 *   appId,
 *   jwksUrl,
 *   lanes: { members: 'https://…/revocations/members', … },
 * }).start();
 * const verifier = createCredentialVerifier({ appId, issuer, jwksUrl, revocationCheck: revocations.check });
 * ```
 */
export function createRevocationPuller(options: RevocationPullerOptions): RevocationPuller {
  if (!options || !isText(options.appId)) {
    throw new TypeError('createRevocationPuller: `appId` is required.');
  }
  const laneEntries = Object.entries(options.lanes ?? {});
  if (laneEntries.length === 0) {
    throw new TypeError('createRevocationPuller: `lanes` must name at least one lane and its URL.');
  }
  for (const [lane, url] of laneEntries) {
    if (!isText(lane) || !isText(url)) {
      throw new TypeError('createRevocationPuller: every lane needs a name and a URL.');
    }
  }
  if (!options.jwks && !options.jwksUrl) {
    throw new TypeError('createRevocationPuller: `jwksUrl` or `jwks` is required to check the entries.');
  }

  const appId = options.appId;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const maxLagMs = options.maxLagMs ?? DEFAULT_MAX_LAG_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const clock = options.now ?? (() => Date.now());
  const log = options.log ?? (() => {});
  const fetchImpl: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const headers: Record<string, string> = { Accept: 'application/json', ...(options.headers ?? {}) };

  const lanes: LaneState[] = laneEntries.map(([lane, url]) => ({
    lane,
    url,
    seq: 0,
    head: 0,
    caughtUpAt: null,
    problem: null,
    error: null,
  }));
  const index = new RevocationIndex();

  // ---- the lanes' public keys ---------------------------------------------

  let laneKeys: Map<string, LaneKey> | null = options.jwks ? readLaneKeys(options.jwks) : null;
  let keysLoadedAt = options.jwks ? Infinity : -Infinity;
  let keysAttemptedAt = -Infinity;
  let keysLoading: Promise<void> | null = null;

  async function loadKeys(): Promise<void> {
    if (!options.jwksUrl) return;
    if (keysLoading) return keysLoading;
    keysAttemptedAt = clock();
    keysLoading = (async () => {
      try {
        const response = await fetchImpl(options.jwksUrl as string, {
          headers: { Accept: 'application/json' },
          signal: timeoutSignal(timeoutMs),
        });
        if (!response.ok) throw new Error(`the key set answered ${response.status}`);
        laneKeys = readLaneKeys(await response.json());
        keysLoadedAt = clock();
      } finally {
        keysLoading = null;
      }
    })();
    return keysLoading;
  }

  async function laneKey(kid: unknown, lane: string): Promise<CryptoKey | Uint8Array> {
    if (!isText(kid)) throw new EntryRefused('an entry names no key');
    // Fetch the key set again when it is old, or for a key id it does not
    // hold (a rotated key), but at most once per cooldown.
    const stale = clock() - keysLoadedAt > KEY_SET_TTL_MS;
    const unknown = !laneKeys?.has(kid);
    const due = clock() - keysAttemptedAt > KEY_SET_COOLDOWN_MS;
    if (laneKeys === null || ((stale || unknown) && due)) {
      try {
        await loadKeys();
      } catch {
        // Keep checking with the keys already loaded; without any, the copy only falls behind.
        if (laneKeys === null) throw new KeySetUnavailable();
      }
    }
    const found = laneKeys?.get(kid);
    if (!found) throw new EntryRefused('an entry is signed with a key that is not published');
    if (found.lane !== lane) throw new EntryRefused("an entry is signed with another lane's key");
    if (!found.key) found.key = await importJWK(found.jwk, 'ES256');
    return found.key;
  }

  // ---- reading one entry --------------------------------------------------

  /** An accepted entry, the reason it was refused, or `null` when the keys to check it could not be loaded. */
  async function readEntry(jws: unknown, lane: string): Promise<RevocationEntry | string | null> {
    if (typeof jws !== 'string') return 'an entry is not a signed entry';
    let payload: Uint8Array;
    try {
      const verified = await compactVerify(jws, (header) => laneKey(header.kid, lane), {
        algorithms: [...REVOCATION_ALGORITHMS],
      });
      if (verified.protectedHeader.typ !== REVOCATION_ENTRY_TYPE) return 'an entry is not a revocation entry';
      payload = verified.payload;
    } catch (error) {
      if (error instanceof KeySetUnavailable) return null;
      if (error instanceof EntryRefused) return error.message;
      const code = (error as { code?: unknown } | null)?.code;
      if (code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED') return "an entry's signature does not match";
      if (code === 'ERR_JOSE_ALG_NOT_ALLOWED') return 'an entry is unsigned or signed with the wrong algorithm';
      return 'an entry failed its signature check';
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(payload));
    } catch {
      return 'an entry is not readable';
    }
    const entry = parseRevocationEntry(parsed);
    if (!entry) return 'an entry is not in a format this version reads';
    if (entry.app !== appId) return 'an entry belongs to another app';
    if (entry.lane !== lane) return 'an entry belongs to another lane';
    return entry;
  }

  // ---- fetching a lane ----------------------------------------------------

  function fail(state: LaneState, problem: string): void {
    state.problem = problem;
    log('Revocation lane cannot be trusted', { lane: state.lane, problem });
  }

  async function syncLane(state: LaneState): Promise<void> {
    const startedAt = clock();
    for (let page = 0; page < MAX_PAGES_PER_SYNC; page++) {
      const url = new URL(state.url);
      url.searchParams.set('v', String(REVOCATION_FORMAT_VERSION));
      url.searchParams.set('after', String(state.seq));
      url.searchParams.set('limit', String(pageSize));

      let body: unknown;
      try {
        const response = await fetchImpl(url.href, { headers, signal: timeoutSignal(timeoutMs) });
        if (!response.ok) throw new Error(`the list answered ${response.status}`);
        body = await response.json();
      } catch (error) {
        state.error = error instanceof Error && error.message ? error.message : 'the list did not answer';
        return;
      }
      state.error = null;

      const b = body as Record<string, unknown> | null;
      if (!b || typeof b !== 'object' || !Array.isArray(b.entries)) {
        return fail(state, 'the list answered in a shape this version does not read');
      }
      if (b.v !== REVOCATION_FORMAT_VERSION) return fail(state, 'the list answered in another format version');
      if (b.app !== appId) return fail(state, 'the list answered for another app');
      if (b.lane !== state.lane) return fail(state, 'the list answered for another lane');
      if (typeof b.head !== 'number' || !Number.isSafeInteger(b.head) || b.head < 0) {
        return fail(state, 'the list did not say how far it goes');
      }
      if (b.head < state.seq) return fail(state, 'the list went backwards');

      for (const jws of b.entries) {
        const entry = await readEntry(jws, state.lane);
        if (entry === null) {
          state.error = "the app's published keys could not be loaded";
          return;
        }
        if (typeof entry === 'string') return fail(state, entry);
        if (entry.seq !== state.seq + 1) {
          return fail(state, `the numbering has a gap after entry ${state.seq}`);
        }
        index.add(entry);
        state.seq = entry.seq;
        try {
          options.onEntry?.(entry);
        } catch {
          log('A revocation entry listener threw', { lane: state.lane, seq: entry.seq });
        }
      }

      state.head = Math.max(b.head, state.seq);
      if (state.seq >= state.head) {
        state.caughtUpAt = startedAt;
        state.problem = null;
        return;
      }
      if (b.entries.length === 0) return fail(state, 'the list says it has entries it did not send');
    }
  }

  // ---- syncing every lane -------------------------------------------------

  let inFlight: Promise<void> | null = null;
  let lastAttemptAt = -Infinity;

  function sync(): Promise<void> {
    if (!inFlight) {
      inFlight = Promise.all(lanes.map((state) => syncLane(state).catch(() => undefined)))
        .then(() => undefined)
        .finally(() => {
          inFlight = null;
          lastAttemptAt = clock();
        });
    }
    return inFlight;
  }

  function ready(): boolean {
    return lanes.every((state) => state.caughtUpAt !== null);
  }

  function lagAt(now: number): number {
    let oldest = Infinity;
    for (const state of lanes) {
      if (state.caughtUpAt === null) return Infinity;
      oldest = Math.min(oldest, state.caughtUpAt);
    }
    return now - oldest;
  }

  function checkWithin(limitMs: number): RevocationCheck {
    if (typeof limitMs !== 'number' || !(limitMs > 0)) {
      throw new TypeError('checkWithin: the limit must be a positive number of milliseconds.');
    }
    return async (actor: Actor): Promise<RevocationVerdict> => {
      const behind = () => lanes.some((state) => state.problem !== null) || lagAt(clock()) > limitMs;
      // Catch up before deciding, but never ask the list more than once per interval.
      if (behind() && (inFlight || clock() - lastAttemptAt >= Math.min(intervalMs, limitMs))) {
        await sync();
      }
      const broken = lanes.find((state) => state.problem !== null);
      if (broken) {
        throw new RevocationListUnavailableError(
          `The revocation list cannot be trusted right now: in lane ${broken.lane}, ${broken.problem}.`,
        );
      }
      const lag = lagAt(clock());
      if (lag > limitMs) {
        throw new RevocationListUnavailableError(
          ready()
            ? `The revocation list is ${Math.round(lag / 1000)} seconds behind.`
            : 'The revocation list has not loaded yet.',
        );
      }
      if (lag > intervalMs && !inFlight) void sync();
      return index.check(actor);
    };
  }

  // ---- the timer ----------------------------------------------------------

  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  // Each start() begins a new run; a fetch from an earlier run never schedules another.
  let run = 0;

  const puller: RevocationPuller = {
    check: checkWithin(maxLagMs),
    checkWithin,
    sync,
    start() {
      if (running) return puller;
      running = true;
      const current = ++run;
      const tick = () => {
        void sync().finally(() => {
          if (!running || current !== run) return;
          timer = setTimeout(tick, intervalMs);
          // On Node, a puller must not keep the process alive by itself.
          (timer as { unref?: () => void }).unref?.();
        });
      };
      tick();
      return puller;
    },
    stop() {
      running = false;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
    status() {
      const now = clock();
      return {
        ready: ready(),
        lagMs: lagAt(now),
        lanes: lanes.map((state) => ({
          lane: state.lane,
          seq: state.seq,
          head: state.head,
          caughtUpAt: state.caughtUpAt,
          problem: state.problem,
          error: state.error,
        })),
      };
    },
  };
  return puller;
}
