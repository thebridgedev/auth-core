import { compactVerify, importJWK, type JSONWebKeySet, type JWK } from 'jose';
import type { Actor } from './actor.js';
import { createKeySet, type KeySet } from './key-set.js';
import {
  REVOCATION_ALGORITHMS,
  REVOCATION_CHECKPOINT_TYPE,
  REVOCATION_ENTRY_TYPE,
  REVOCATION_FORMAT_VERSION,
  RevocationIndex,
  parseRevocationCheckpoint,
  parseRevocationEntry,
  type RevocationCheckpoint,
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
 * app's published keys and never accepts an unsigned or altered one. Each
 * page of the list carries a checkpoint signed with the lane's key, saying
 * how far the lane goes and when; how far behind the copy is counts from that
 * signed time, so a cached, withheld or replayed page cannot make a stale
 * copy look current.
 *
 * It fails closed: until its copy has loaded every lane, while any lane is
 * out of step (a gap in the numbering, an entry or checkpoint that fails its
 * check, a list that went backwards), and once its copy is further behind
 * than the limit, its check throws, so the verifier refuses with
 * `unavailable` instead of accepting. A copy that has not been refreshed for
 * a while (a process that was frozen between invocations, for example)
 * fetches before it decides.
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
  /**
   * The app's key set, made with `createKeySet`, instead of `jwksUrl` or
   * `jwks`. Pass the same one to the verifier so the keys are fetched once.
   */
  keySet?: KeySet;
  /** How often to fetch new entries. @default 2000 */
  intervalMs?: number;
  /**
   * How long after a fetch that reached the end of every lane the copy is
   * trusted without fetching again. A check on an older copy fetches first
   * and decides after, so a process that was frozen, or a puller without
   * `start()`, never answers from what it knew before.
   * @default twice `intervalMs`
   */
  freshForMs?: number;
  /**
   * How far behind the copy may fall before every check refuses. Measured
   * from the time the lanes' signed checkpoints vouch for.
   * @default 300000 (5 minutes, one access-token lifetime)
   */
  maxLagMs?: number;
  /**
   * How far ahead of this clock a checkpoint may be dated. A checkpoint dated
   * further ahead is refused.
   * @default 5000
   */
  clockToleranceMs?: number;
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
  /** The number of the last entry accepted, or of the entry before the floor it started from. 0 before any. */
  readonly seq: number;
  /** The last entry the list said it had. */
  readonly head: number;
  /** The oldest entry the list said it still keeps. */
  readonly floor: number;
  /** The time, in ms, the lane's signed checkpoint vouches the copy is complete up to. Null before the first. */
  readonly caughtUpAt: number | null;
  /** When the last fetch that reached the end of the lane was sent, in ms. Null before the first. */
  readonly syncedAt: number | null;
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
  /**
   * Credentials checked by signature and issued before this time (ms) are
   * refused: the list no longer keeps entries this copy has not seen that
   * could name them. Null when the copy holds every entry that matters.
   */
  readonly refusesIssuedBefore: number | null;
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
const DEFAULT_CLOCK_TOLERANCE_MS = 5000;
const DEFAULT_PAGE_SIZE = 500;
const MAX_PAGES_PER_SYNC = 1000;

interface LaneState {
  readonly lane: string;
  readonly url: string;
  seq: number;
  head: number;
  floor: number;
  /** Credentials issued before this time (ms) are refused: entries this copy skipped could name them. */
  horizon: number;
  knownAt: number | null;
  syncedAt: number | null;
  loaded: boolean;
  problem: string | null;
  error: string | null;
}

interface LaneKey {
  readonly lane: string;
  readonly jwk: JWK;
  key?: CryptoKey | Uint8Array;
}

/** A signed item that is refused, with the reason. */
class SignedRefused extends Error {}

/** The published keys could not be loaded, so nothing can be checked yet. */
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
 * used twice is ignored too, so anything signed with it is refused.
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
 * const keySet = createKeySet({ url: jwksUrl });
 * const revocations = createRevocationPuller({ appId, keySet, lanes: { … } }).start();
 * const verifier = createCredentialVerifier({ appId, issuer, audience, keySet, revocationCheck: revocations.check });
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
  if (!options.keySet && !options.jwks && !options.jwksUrl) {
    throw new TypeError('createRevocationPuller: `jwksUrl`, `jwks` or `keySet` is required to check the entries.');
  }

  const appId = options.appId;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const freshForMs = options.freshForMs ?? 2 * intervalMs;
  const maxLagMs = options.maxLagMs ?? DEFAULT_MAX_LAG_MS;
  const clockToleranceMs = options.clockToleranceMs ?? DEFAULT_CLOCK_TOLERANCE_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const clock = options.now ?? (() => Date.now());
  const log = options.log ?? (() => {});
  const fetchImpl: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));
  // The list must never come from a cache: a stale page is a stale copy.
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(options.headers ?? {}),
    'Cache-Control': 'no-store',
  };
  const keySet: KeySet =
    options.keySet ??
    createKeySet({ url: options.jwksUrl, keys: options.jwks, fetch: fetchImpl, timeoutMs, now: clock });

  const lanes: LaneState[] = laneEntries.map(([lane, url]) => ({
    lane,
    url,
    seq: 0,
    head: 0,
    floor: 1,
    horizon: -Infinity,
    knownAt: null,
    syncedAt: null,
    loaded: false,
    problem: null,
    error: null,
  }));
  const index = new RevocationIndex();

  // ---- the lanes' public keys ---------------------------------------------

  const laneKeysOf = new WeakMap<object, Map<string, LaneKey>>();

  async function laneKey(kid: unknown, lane: string): Promise<CryptoKey | Uint8Array> {
    if (!isText(kid)) throw new SignedRefused('names no key');
    let set: JSONWebKeySet;
    try {
      // Fetches the key set again for a key id it does not hold (a rotated key), at most once per cooldown.
      set = await keySet.keys(kid);
    } catch {
      throw new KeySetUnavailable();
    }
    let keys = laneKeysOf.get(set);
    if (!keys) {
      keys = readLaneKeys(set);
      laneKeysOf.set(set, keys);
    }
    const found = keys.get(kid);
    if (!found) throw new SignedRefused('is signed with a key that is not published');
    if (found.lane !== lane) throw new SignedRefused("is signed with another lane's key");
    if (!found.key) found.key = await importJWK(found.jwk, 'ES256');
    return found.key;
  }

  /**
   * Check one signed item of a lane (an entry or a checkpoint): its signature
   * with the lane's key, its type, and that it reads as JSON. Returns the
   * payload, the reason it is refused, or `null` when the keys to check it
   * could not be loaded.
   */
  async function readSigned(jws: unknown, lane: string, typ: string, what: string, isA: string): Promise<unknown> {
    if (typeof jws !== 'string') return `${what} is not signed`;
    let payload: Uint8Array;
    try {
      const verified = await compactVerify(jws, (header) => laneKey(header.kid, lane), {
        algorithms: [...REVOCATION_ALGORITHMS],
      });
      if (verified.protectedHeader.typ !== typ) return `${what} is not ${isA}`;
      payload = verified.payload;
    } catch (error) {
      if (error instanceof KeySetUnavailable) return null;
      if (error instanceof SignedRefused) return `${what} ${error.message}`;
      const code = (error as { code?: unknown } | null)?.code;
      if (code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED') return `${what}'s signature does not match`;
      if (code === 'ERR_JOSE_ALG_NOT_ALLOWED') return `${what} is unsigned or signed with the wrong algorithm`;
      return `${what} failed its signature check`;
    }
    try {
      return { payload: JSON.parse(new TextDecoder().decode(payload)) as unknown };
    } catch {
      return `${what} is not readable`;
    }
  }

  /** An accepted entry, the reason it was refused, or `null` when the keys to check it could not be loaded. */
  async function readEntry(jws: unknown, lane: string): Promise<RevocationEntry | string | null> {
    const read = await readSigned(jws, lane, REVOCATION_ENTRY_TYPE, 'an entry', 'a revocation entry');
    if (read === null || typeof read === 'string') return read;
    const entry = parseRevocationEntry((read as { payload: unknown }).payload);
    if (!entry) return 'an entry is not in a format this version reads';
    if (entry.app !== appId) return 'an entry belongs to another app';
    if (entry.lane !== lane) return 'an entry belongs to another lane';
    return entry;
  }

  /** The lane's accepted checkpoint, the reason it was refused, or `null` when the keys could not be loaded. */
  async function readCheckpoint(jws: unknown, lane: string): Promise<RevocationCheckpoint | string | null> {
    if (jws === undefined || jws === null) return 'the list sent no signed checkpoint';
    const read = await readSigned(jws, lane, REVOCATION_CHECKPOINT_TYPE, 'the checkpoint', 'a revocation checkpoint');
    if (read === null || typeof read === 'string') return read;
    const checkpoint = parseRevocationCheckpoint((read as { payload: unknown }).payload);
    if (!checkpoint) return 'the checkpoint is not in a format this version reads';
    if (checkpoint.app !== appId) return 'the checkpoint belongs to another app';
    if (checkpoint.lane !== lane) return 'the checkpoint belongs to another lane';
    if (checkpoint.at > clock() + clockToleranceMs) return 'the checkpoint is dated in the future';
    return checkpoint;
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

      const checkpoint = await readCheckpoint(b.checkpoint, state.lane);
      if (checkpoint === null) {
        state.error = "the app's published keys could not be loaded";
        return;
      }
      if (typeof checkpoint === 'string') return fail(state, checkpoint);
      if (checkpoint.head < state.seq) return fail(state, 'the list went backwards');
      state.floor = checkpoint.floor;

      if (checkpoint.floor > state.seq + 1) {
        // The list no longer keeps entries this copy has not seen. Start again
        // from the oldest entry it keeps. Credentials issued before the dropped
        // entries stop counting are refused from now on, since one of them
        // could have named it; a copy that had loaded refuses everything until
        // it has caught up again.
        if (state.loaded) fail(state, 'the copy fell below the oldest entry the list keeps and is reloading from there');
        state.horizon = Math.max(state.horizon, checkpoint.floorAt);
        state.seq = checkpoint.floor - 1;
      }

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

      state.head = Math.max(checkpoint.head, state.seq);
      if (state.seq >= state.head) {
        // Complete as of the earlier of when this fetch was sent and when the
        // checkpoint was signed; a replayed checkpoint never moves it back.
        const vouched = Math.min(startedAt, checkpoint.at);
        state.knownAt = state.knownAt === null ? vouched : Math.max(state.knownAt, vouched);
        state.syncedAt = startedAt;
        state.loaded = true;
        state.problem = null;
        return;
      }
      if (b.entries.length === 0) return fail(state, 'the list says it has entries it did not send');
    }
  }

  // ---- syncing every lane -------------------------------------------------

  let inFlight: Promise<void> | null = null;
  let inFlightStartedAt = -Infinity;
  let lastAttemptAt = -Infinity;
  let lastFailureAt = -Infinity;

  function sync(): Promise<void> {
    if (!inFlight) {
      inFlightStartedAt = clock();
      inFlight = Promise.all(lanes.map((state) => syncLane(state).catch(() => undefined)))
        .then(() => undefined)
        .finally(() => {
          inFlight = null;
          lastAttemptAt = clock();
          if (lanes.some((state) => state.error !== null || state.problem !== null)) lastFailureAt = lastAttemptAt;
        });
    }
    return inFlight;
  }

  /** Wait for a sync that was sent at or after `since`: join one, or start one once an older one ends. */
  async function syncSentSince(since: number): Promise<void> {
    if (inFlight && inFlightStartedAt >= since) return inFlight;
    if (inFlight) await inFlight;
    return sync();
  }

  function ready(): boolean {
    return lanes.every((state) => state.knownAt !== null);
  }

  function lagAt(now: number): number {
    let oldest = Infinity;
    for (const state of lanes) {
      if (state.knownAt === null) return Infinity;
      oldest = Math.min(oldest, state.knownAt);
    }
    return now - oldest;
  }

  /** When the oldest lane last reached its end, by this clock. -Infinity before every lane has. */
  function syncedAt(): number {
    let oldest = Infinity;
    for (const state of lanes) {
      if (state.syncedAt === null) return -Infinity;
      oldest = Math.min(oldest, state.syncedAt);
    }
    return oldest;
  }

  /**
   * Whether the list is known to be failing right now: a sync failed within
   * the last interval and timeout, or a retry after a failure is under way.
   * Checks then answer from the copy, within its limit, instead of each
   * waiting for the list.
   */
  function listFailing(now: number): boolean {
    if (lastFailureAt === -Infinity) return false;
    if (now - lastFailureAt < intervalMs + timeoutMs) return true;
    return inFlight !== null && inFlightStartedAt >= lastFailureAt && now - inFlightStartedAt < intervalMs + timeoutMs;
  }

  function horizon(): number {
    return lanes.reduce((latest, state) => Math.max(latest, state.horizon), -Infinity);
  }

  function checkWithin(limitMs: number): RevocationCheck {
    if (typeof limitMs !== 'number' || !(limitMs > 0)) {
      throw new TypeError('checkWithin: the limit must be a positive number of milliseconds.');
    }
    const refreshAfterMs = Math.min(freshForMs, limitMs);
    return async (actor: Actor): Promise<RevocationVerdict> => {
      const now = clock();
      const broken = () => lanes.find((state) => state.problem !== null);
      if (broken() || lagAt(now) > limitMs) {
        // About to refuse: catch up first, but never ask the list more than once per interval.
        if (inFlight || now - lastAttemptAt >= Math.min(intervalMs, limitMs)) await syncSentSince(now - refreshAfterMs);
      } else if (now - syncedAt() > refreshAfterMs && !listFailing(now)) {
        // Not refreshed lately, though nothing says the list is down: a process
        // that was frozen, or a puller without a timer. Refresh before deciding.
        await syncSentSince(now - refreshAfterMs);
      }

      const problem = broken();
      if (problem) {
        throw new RevocationListUnavailableError(
          `The revocation list cannot be trusted right now: in lane ${problem.lane}, ${problem.problem}.`,
        );
      }
      const after = clock();
      const lag = lagAt(after);
      if (lag > limitMs) {
        throw new RevocationListUnavailableError(
          ready()
            ? `The revocation list is ${Math.round(lag / 1000)} seconds behind.`
            : 'The revocation list has not loaded yet.',
        );
      }
      // Top up in the background, at most once per interval.
      if (after - syncedAt() > intervalMs && !inFlight && after - lastAttemptAt >= intervalMs) void sync();

      const issuedBefore = horizon();
      if (issuedBefore > -Infinity && actor.credential.checkedBy === 'signature') {
        const issuedAt = actor.credential.issuedAt;
        if (issuedAt === null || issuedAt * 1000 < issuedBefore) {
          return Object.freeze({
            revoked: true,
            message: 'The credential was issued before the oldest entry the revocation list still keeps; a new one is needed.',
          });
        }
      }
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
      const issuedBefore = horizon();
      return {
        ready: ready(),
        lagMs: lagAt(now),
        refusesIssuedBefore: issuedBefore > -Infinity ? issuedBefore : null,
        lanes: lanes.map((state) => ({
          lane: state.lane,
          seq: state.seq,
          head: state.head,
          floor: state.floor,
          caughtUpAt: state.knownAt,
          syncedAt: state.syncedAt,
          problem: state.problem,
          error: state.error,
        })),
      };
    },
  };
  return puller;
}
