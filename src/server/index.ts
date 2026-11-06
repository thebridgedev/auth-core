/**
 * @nebulr-group/bridge-auth-core/server
 *
 * For the Child App's own server: check the tokens and keys its API is
 * called with, read flag results for the caller, and count usage ("count
 * this").
 *
 * Token checks follow the app's revocation list, so a session that ended, a
 * member who was removed or a key that was revoked is refused within seconds,
 * not when its token expires. While the list cannot be read, checks answer
 * `unavailable` (503), never yes.
 *
 * Runs on Node and edge runtimes: it uses only `fetch` and Web Crypto.
 */
import { Discovery, type IssuerMetadata } from '../core/discovery.js';
import { BridgeError } from '../core/errors.js';
import { call, platformFetch, withoutRedirects, type Fetch } from '../core/http.js';
import { REVOCATION_LANES, ROUTES } from '../core/routes.js';
import { randomId } from '../core/util.js';
import { FlagSet, resultsOf, type Hint } from '../flags.js';
import {
  createCredentialVerifier,
  createKeySet,
  createRevocationPuller,
  readCredentials,
  type Actor as VerifiedActor,
  type CredentialVerifier,
  type HeadersLike,
  type RevocationListStatus,
  type RevocationPuller,
} from '../verifier/index.js';

/** Who is calling the Child App's API. */
export interface Actor {
  /** `person` for a signed-in person; a key's kind (`personal_key`, `service_account_key`, `app_key`) for a key; `job` for a job. */
  readonly kind: VerifiedActor['kind'];
  /** The person's id, or the key's or job's id. */
  readonly id: string;
  /** The person behind the call: the person, or the member who made a personal key. Null otherwise. */
  readonly personId: string | null;
  /** The workspace the call is for. Null when the credential names none. */
  readonly workspaceId: string | null;
  /** The sign-in session the token belongs to, for a person. */
  readonly sessionId: string | null;
  readonly appId: string;
  /** The workspace's standing, such as `active`. A workspace that is not active should only read. */
  readonly standing: string | null;
}

export interface BridgeServerOptions {
  /** The issuer, as for the browser SDK. */
  readonly issuer: string;
  /** The app's own key, for counting usage. Keep it on the server. */
  readonly appKey?: string;
  /**
   * The audience Bridge's access tokens name. Read from the issuer's
   * metadata; give it here only for an issuer that does not publish it.
   */
  readonly audience?: string;
  readonly fetch?: Fetch;
  /** How far behind the revocation list may fall before checks answer `unavailable`. @default 300000 (5 minutes) */
  readonly maxLagMs?: number;
  /** The tighter limit for `verify(..., { strict: true })`, for writes and sensitive actions. @default 30000 */
  readonly strictLagMs?: number;
  /** How often to fetch new revocation entries. @default 2000 */
  readonly revocationIntervalMs?: number;
  /** How often counted usage is sent. @default 5000 */
  readonly usageFlushMs?: number;
  /** The most reports kept while Bridge cannot take them; past it, the oldest are dropped and logged. @default 10000 */
  readonly maxQueuedReports?: number;
  /** The first wait before the issuer's metadata is read again after a failure; it doubles up to a minute. @default 1000 */
  readonly discoveryRetryMs?: number;
  /** Debug messages. Never receives a credential. */
  readonly log?: (message: string, details?: Record<string, unknown>) => void;
}

export interface VerifyOptions {
  /** Refuse unless the revocation list is at most `strictLagMs` behind. For writes and sensitive actions. */
  readonly strict?: boolean;
}

/** A request, or anything with its headers: a Fetch `Request`, Node's `IncomingMessage`, or `{ headers }`. */
export interface RequestLike {
  readonly headers: HeadersLike;
}

interface UsageReport {
  readonly id: string;
  readonly metric: string;
  readonly quantity: number;
  readonly workspace: string;
  readonly time: string;
}

const METRIC = /^[a-z][a-z0-9_]{0,63}(\.[a-z][a-z0-9_]{0,63}){0,3}$/;
/** As Bridge reads them: a report's one-time id, and a workspace id. */
const REPORT_ID = /^[\x21-\x7e]{1,200}$/;
const WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_BATCH = 1000;

/** Bridge refused the batch itself: sending it again would be refused again. */
function refusedForGood(error: unknown): boolean {
  return error instanceof BridgeError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
}

function publicActor(actor: VerifiedActor): Actor {
  const standing = actor.claims['wst'];
  return Object.freeze({
    kind: actor.kind,
    id: actor.id,
    personId: actor.personId,
    workspaceId: actor.workspaceId,
    sessionId: actor.credential.sessionId,
    appId: actor.appId,
    standing: typeof standing === 'string' ? standing : null,
  });
}

function bearerOf(headers: HeadersLike): string | null {
  const found = readCredentials(headers).find((credential) => credential.type === 'token');
  return found?.value ?? null;
}

export function createBridgeServer(options: BridgeServerOptions) {
  // The app key reaches the whole app: it must never be in a page. The package's browser build of this entry throws too.
  if (options.appKey && typeof window !== 'undefined' && typeof document !== 'undefined') {
    throw new BridgeError('misconfigured', 'createBridgeServer holds the app key and runs only on a server, never in a browser.');
  }
  const fetchFn = options.fetch ?? platformFetch();
  // The key set, the revocation lanes and key introspection are read only where the metadata says, never via a redirect.
  const guardedFetch = withoutRedirects(fetchFn);
  const strictLagMs = options.strictLagMs ?? 30_000;
  const maxQueued = options.maxQueuedReports ?? 10_000;
  let metadata: IssuerMetadata | null = null;
  let verifier: CredentialVerifier | null = null;
  let puller: RevocationPuller | null = null;
  // Read when it can be, shared by token checks, flags and usage. A failed read is tried again later, never kept.
  const discovery = new Discovery(options.issuer, fetchFn, { retryMinMs: options.discoveryRetryMs ?? 1000 });
  let settingUp: Promise<void> | null = null;

  async function build(): Promise<void> {
    const endpoints = await discovery.get();
    if (verifier !== null) return;
    const found = endpoints.metadata;
    const audience = found.audience ?? options.audience;
    if (audience === undefined || audience === '') {
      throw new BridgeError('misconfigured', "The issuer's metadata does not name the access tokens' audience: pass `audience`.");
    }
    const jwksUrl = found.endpoints.jwks;
    if (jwksUrl === undefined) throw new BridgeError('misconfigured', "The issuer's metadata lists no key set (jwks).");
    const lanes: Record<string, string> = {};
    for (const lane of REVOCATION_LANES) {
      const url = found.revocationLanes[lane];
      if (url === undefined) throw new BridgeError('misconfigured', `The issuer's metadata lists no "${lane}" lane of the revocation list.`);
      lanes[lane] = url;
    }
    const keySet = createKeySet({ url: jwksUrl, fetch: guardedFetch });
    const made = createRevocationPuller({
      appId: found.appId,
      lanes,
      keySet,
      fetch: guardedFetch,
      ...(options.maxLagMs === undefined ? {} : { maxLagMs: options.maxLagMs }),
      ...(options.revocationIntervalMs === undefined ? {} : { intervalMs: options.revocationIntervalMs }),
      ...(options.log === undefined ? {} : { log: options.log }),
    }).start();
    verifier = createCredentialVerifier({
      appId: found.appId,
      issuer: found.issuer,
      audience,
      keySet,
      ...(found.endpoints.introspect === undefined ? {} : { introspectionUrl: found.endpoints.introspect }),
      revocationCheck: made.check,
      fetch: guardedFetch,
      ...(options.log === undefined ? {} : { log: options.log }),
    });
    puller = made;
    metadata = found;
  }

  /** Sets up the token checks once the metadata can be read. Calls made while it cannot fail at once, until the next try. */
  function setUp(): Promise<void> {
    if (verifier !== null) return Promise.resolve();
    settingUp ??= build().finally(() => {
      settingUp = null;
    });
    return settingUp;
  }

  const ready = setUp();
  ready.catch(() => undefined);

  /** Checks the request's credential: `Authorization: Bearer <token>`, or `x-api-key: <key>`. */
  async function check(request: RequestLike, verifyOptions: VerifyOptions = {}): Promise<{ ok: true; actor: Actor } | { ok: false; error: BridgeError }> {
    try {
      await setUp();
    } catch (cause) {
      // Not set up yet (Bridge unreachable, or its metadata unusable): never a yes.
      const reason = cause instanceof Error ? cause.message : String(cause);
      return { ok: false, error: new BridgeError('unavailable', `Credentials cannot be checked yet: ${reason}`, { status: 503, code: 'unavailable', cause }) };
    }
    const verification = await (verifier as CredentialVerifier).verifyRequest(request);
    if (!verification.ok) {
      const { reason, message } = verification.refusal;
      if (reason === 'unavailable') return { ok: false, error: new BridgeError('unavailable', message, { status: 503, code: reason }) };
      return { ok: false, error: new BridgeError('signed-out', message, { status: 401, code: reason }) };
    }
    if (verifyOptions.strict) {
      try {
        const verdict = await (puller as RevocationPuller).checkWithin(strictLagMs)(verification.actor);
        if (verdict.revoked) return { ok: false, error: new BridgeError('signed-out', verdict.message ?? 'Access was taken away.', { status: 401, code: 'revoked' }) };
      } catch {
        return { ok: false, error: new BridgeError('unavailable', 'The revocation list is too far behind for this action; try again shortly.', { status: 503, code: 'unavailable' }) };
      }
    }
    return { ok: true, actor: publicActor(verification.actor) };
  }

  // Counting usage.
  let queue: UsageReport[] = [];
  let dropped = 0;
  let sending: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function sendQueued(): Promise<void> {
    while (queue.length > 0) {
      const batch = queue.slice(0, MAX_BATCH);
      // Until the metadata can be read, the reports wait (within the queue's limit).
      const endpoints = await discovery.get().catch(() => null);
      if (endpoints === null) return;
      try {
        await call(fetchFn, endpoints.url(ROUTES.usageReport), { method: 'POST', apiKey: options.appKey ?? null, body: { reports: batch } });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!refusedForGood(error)) {
          // Kept, and sent again whole with the same ids: Bridge counts each id once.
          options.log?.('Usage could not be sent; it is kept and sent again.', { reports: batch.length, error: message });
          return;
        }
        // Refused as it is: set aside, so the reports behind it are still counted.
        options.log?.('Usage reports were refused by Bridge and dropped.', { reports: batch.length, error: message });
      }
      const done = new Set(batch);
      queue = queue.filter((report) => !done.has(report));
    }
    if (dropped > 0) {
      options.log?.('Usage reports were dropped while the queue was full.', { dropped });
      dropped = 0;
    }
  }

  function flush(): Promise<void> {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    sending ??= sendQueued().finally(() => {
      sending = null;
      if (queue.length > 0) schedule();
    });
    return sending;
  }

  function schedule(): void {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, options.usageFlushMs ?? 5000);
    // Never keeps a Node process alive on its own.
    (timer as { unref?: () => void }).unref?.();
  }

  return {
    ready,
    /** What the issuer published. Available once `ready` resolves. */
    metadata: (): IssuerMetadata => {
      if (metadata === null) throw new BridgeError('misconfigured', 'The server is not ready yet: wait for `ready`.');
      return metadata;
    },
    check,
    /** Checks the request's credential and returns its Actor, or throws a `BridgeError` (401, or 503 while Bridge cannot be checked). */
    async verify(request: RequestLike, verifyOptions: VerifyOptions = {}): Promise<Actor> {
      const result = await check(request, verifyOptions);
      if (!result.ok) throw result.error;
      return result.actor;
    },
    flags: {
      /**
       * The caller's flag results, worked out by Bridge for the person whose
       * token came with the request. A request without a person's token gets
       * an empty set: every flag gives its fallback, as it does while Bridge
       * cannot answer.
       */
      async forRequest(request: RequestLike, hints: Readonly<Record<string, Hint>> = {}): Promise<FlagSet> {
        const token = bearerOf(request.headers);
        if (token === null) return new FlagSet();
        try {
          const endpoints = await discovery.get();
          const answer = await call<unknown>(fetchFn, endpoints.url(ROUTES.flagsEvaluate), { method: 'POST', token, body: { context: hints } });
          return new FlagSet(resultsOf(answer.body));
        } catch (error) {
          // Gates fail closed: every flag gives its fallback while Bridge cannot answer.
          options.log?.('Flag results could not be read; every flag gives its fallback.', { error: error instanceof Error ? error.message : String(error) });
          return new FlagSet();
        }
      },
    },
    usage: {
      /**
       * Counts usage of a metric for the caller's workspace ("count this").
       * Sent in batches every few seconds; a batch that fails is sent again
       * with the same ids, so nothing is counted twice.
       */
      count(actor: Actor, metric: string, quantity = 1, countOptions: { readonly id?: string; readonly workspace?: string } = {}): void {
        if (options.appKey === undefined || options.appKey === '') throw new BridgeError('misconfigured', 'Counting usage needs the app key: pass `appKey`.');
        if (!METRIC.test(metric)) throw new BridgeError('invalid', `"${metric}" is not a metric name: lower case, dot-separated, such as api.calls.`);
        if (!Number.isFinite(quantity) || quantity < 0) throw new BridgeError('invalid', 'The quantity is a number of 0 or more.');
        const workspace = countOptions.workspace ?? actor.workspaceId;
        if (workspace === null) throw new BridgeError('invalid', 'This caller acts in no workspace: name the workspace the usage is for.');
        if (!WORKSPACE_ID.test(workspace)) throw new BridgeError('invalid', `"${workspace}" is not a workspace id.`);
        const id = countOptions.id ?? randomId();
        if (!REPORT_ID.test(id)) throw new BridgeError('invalid', 'A report id is 1 to 200 visible characters, with no spaces.');
        if (queue.length >= maxQueued) {
          // Full while Bridge cannot take reports: the oldest go, so memory stays bounded.
          queue.shift();
          dropped += 1;
          if (dropped === 1) options.log?.('The usage queue is full; the oldest reports are being dropped.', { limit: maxQueued });
        }
        queue.push({ id, metric, quantity, workspace, time: new Date().toISOString() });
        if (queue.length >= MAX_BATCH) void flush();
        else schedule();
      },
      /** Sends what is counted now. Call it before a short-lived process ends. */
      flush,
      /** How many reports wait to be sent. */
      pending: () => queue.length,
    },
    /** How the revocation list is followed, for a health check. */
    status(): RevocationListStatus | null {
      return puller?.status() ?? null;
    },
    /** Sends counted usage, and stops following the revocation list. */
    async close(): Promise<void> {
      await flush();
      puller?.stop();
    },
  };
}

export type BridgeServer = ReturnType<typeof createBridgeServer>;

export { BridgeError, isBridgeError } from '../core/errors.js';
export type { BridgeErrorKind } from '../core/errors.js';
export { FlagSet } from '../flags.js';
export type { FlagReason, FlagResult, Hint } from '../flags.js';
