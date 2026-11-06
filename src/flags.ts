import type { Endpoints } from './core/discovery.js';
import { isBridgeError } from './core/errors.js';
import { call, type Fetch } from './core/http.js';
import { ROUTES } from './core/routes.js';
import { storageKey, type BridgeStorage } from './core/storage.js';
import { Store, randomId, type Readable } from './core/util.js';
import type { Session } from './session.js';

/**
 * Flags: Bridge's answers, never its rules.
 *
 * Every gate in the Child App (a page, a button, a link) is a flag, and the
 * flag's rule says why: a privilege, a plan feature or a rollout. Bridge
 * works out the results for the signed-in person (or, for a visitor, the
 * app's public flags) and the SDK fetches them in one call, revalidated with
 * an ETag. Nothing here reads a role, a privilege or the plan.
 *
 * A flag Bridge did not answer for gives the fallback you pass: gates fail
 * closed.
 */

/** One flag's result, as Bridge answered it (OFREP). */
export type FlagResult =
  | {
      readonly key: string;
      readonly value: unknown;
      readonly reason: string;
      readonly variant?: string;
      readonly metadata?: Readonly<Record<string, unknown>>;
    }
  | { readonly key: string; readonly errorCode: string; readonly errorDetails?: string };

/** Why a flag has its value, to explain a hidden page or offer an upgrade. */
export interface FlagReason {
  /** OFREP's reason: `TARGETING_MATCH`, `DEFAULT`, `DISABLED`, `ERROR` and so on. */
  readonly reason: string;
  /** Bridge's own words for which part of the rule decided, when it says. */
  readonly why: string | null;
  /** The plan feature the rule needs, when a missing plan feature is why it is off: offer an upgrade. */
  readonly entitlement: string | null;
}

export type FlagsStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * The flags The Bridge keeps for every app, which the SDK's own screens gate
 * on. Their rules are yours to change; pass other keys to a plugin to use
 * your own flags instead.
 */
export const STANDARD_FLAGS = Object.freeze({
  /** May manage billing: choose a plan, open the portal. */
  billingManage: 'bridge-billing-manage',
  /** May manage the team: invite, change roles, remove members. */
  teamManage: 'bridge-team-manage',
  /** The app is active for this workspace: off means show the paywall. */
  appActive: 'bridge-app-active',
});

export interface FlagsDeps {
  readonly issuer: string;
  readonly endpoints: () => Endpoints;
  readonly fetch: Fetch;
  readonly storage: BridgeStorage;
  readonly session: Session;
  readonly onError: (error: unknown) => void;
}

/** A context value Bridge may read as a hint. Bridge takes who the person is from their token, never from here. */
export type Hint = string | number | boolean | null;

/** Reads an OFREP bulk answer. */
export function resultsOf(body: unknown): Map<string, FlagResult> {
  const flags = (body as { flags?: unknown } | undefined)?.flags;
  const results = new Map<string, FlagResult>();
  if (!Array.isArray(flags)) return results;
  for (const each of flags as unknown[]) {
    const result = each as Partial<FlagResult> | null;
    if (typeof result?.key === 'string') results.set(result.key, result as FlagResult);
  }
  return results;
}

/** A set of results, read the same way in the browser and on a server. */
export class FlagSet {
  constructor(private readonly results: ReadonlyMap<string, FlagResult> = new Map()) {}

  /** A flag's value, or `fallback` when Bridge gave none or one of another type. */
  get<T>(key: string, fallback: T): T {
    const result = this.results.get(key);
    if (result === undefined || !('value' in result)) return fallback;
    const value = result.value;
    if (fallback === undefined || fallback === null) return value as T;
    if (typeof value !== typeof fallback || (typeof fallback === 'object' && value === null)) return fallback;
    return value as T;
  }

  /** Whether a boolean flag is on. Off unless Bridge said on. */
  enabled(key: string): boolean {
    return this.get<boolean>(key, false) === true;
  }

  reason(key: string): FlagReason {
    const result = this.results.get(key);
    if (result === undefined) return { reason: 'FLAG_NOT_FOUND', why: null, entitlement: null };
    if (!('value' in result)) return { reason: 'ERROR', why: result.errorDetails ?? result.errorCode, entitlement: null };
    const metadata = result.metadata ?? {};
    return {
      reason: result.reason,
      why: typeof metadata['why'] === 'string' ? metadata['why'] : null,
      entitlement: typeof metadata['entitlement'] === 'string' ? metadata['entitlement'] : null,
    };
  }

  /** Every result Bridge gave. */
  all(): ReadonlyMap<string, FlagResult> {
    return this.results;
  }
}

export class Flags {
  private readonly results = new Store<ReadonlyMap<string, FlagResult>>(new Map());
  private readonly statusStore = new Store<FlagsStatus>('idle');
  private etag: string | null = null;
  private context = '';
  private hints: Readonly<Record<string, Hint>> = {};
  private inflight: Promise<void> | null = null;
  private again = false;
  private anonymousId: string | null = null;

  constructor(private readonly deps: FlagsDeps) {}

  /** Whether results have loaded. */
  get status(): Readable<FlagsStatus> {
    return this.statusStore;
  }

  /** A flag's value, or `fallback` when Bridge gave none or one of another type. */
  get<T>(key: string, fallback: T): T {
    return new FlagSet(this.results.get()).get(key, fallback);
  }

  /** Whether a boolean flag is on. Off unless Bridge said on. */
  enabled(key: string): boolean {
    return this.get<boolean>(key, false) === true;
  }

  /** Why a flag has its value. */
  reason(key: string): FlagReason {
    return new FlagSet(this.results.get()).reason(key);
  }

  /** Every result Bridge gave. */
  all(): ReadonlyMap<string, FlagResult> {
    return this.results.get();
  }

  /** Called now and whenever results change. */
  subscribe(listener: (results: ReadonlyMap<string, FlagResult>) => void): () => void {
    return this.results.subscribe(listener);
  }

  /**
   * Tells Bridge more about this page, for rules that read it (a country, a
   * page, an experiment group). These are hints: a rule on who the person is
   * reads their token, never a hint.
   */
  async setHints(hints: Readonly<Record<string, Hint>>): Promise<void> {
    this.hints = { ...hints };
    this.etag = null;
    await this.load();
  }

  /** Fetches results now. Several calls at once make one request. */
  load(): Promise<void> {
    if (this.inflight !== null) {
      this.again = true;
      return this.inflight;
    }
    this.inflight = (async () => {
      do {
        this.again = false;
        await this.fetchOnce();
      } while (this.again);
    })().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** Drops results that were for another person or workspace. */
  reset(): void {
    this.etag = null;
    this.context = '';
    this.results.set(new Map());
    this.statusStore.set('idle');
  }

  private async fetchOnce(): Promise<void> {
    const state = this.deps.session.state.get();
    const endpoints = this.deps.endpoints();
    const signedIn = state.status === 'signed-in';
    const context = signedIn ? `person:${state.user.id}:${state.workspace?.id ?? ''}` : 'visitor';
    if (context !== this.context) {
      this.etag = null;
      if (this.context !== '') this.results.set(new Map());
      this.context = context;
    }
    if (!signedIn && !endpoints.offers(ROUTES.flagsVisitorEvaluate)) {
      this.statusStore.set('ready');
      return;
    }
    if (this.results.get().size === 0) this.statusStore.set('loading');
    try {
      const token = signedIn ? await this.deps.session.accessToken() : null;
      const route = signedIn ? ROUTES.flagsEvaluate : ROUTES.flagsVisitorEvaluate;
      const evaluationContext = signedIn ? { ...this.hints } : { targetingKey: await this.visitorId(), ...this.hints };
      const answer = await call<unknown>(this.deps.fetch, endpoints.url(route), { method: 'POST', token, etag: this.etag, body: { context: evaluationContext } });
      // Answers for a context that changed meanwhile are dropped; the next load asks again.
      if (context !== this.context) return;
      this.etag = answer.etag;
      if (!answer.notModified) this.results.set(resultsOf(answer.body));
      this.statusStore.set('ready');
    } catch (error) {
      if (isBridgeError(error, 'signed-out') && signedIn) return;
      // Results already held stay: they were Bridge's answers for this same person. None held: every flag gives its fallback.
      this.statusStore.set('error');
      this.deps.onError(error);
    }
  }

  private async visitorId(): Promise<string> {
    if (this.anonymousId !== null) return this.anonymousId;
    const key = storageKey(this.deps.issuer, 'visitor');
    let id = await this.deps.storage.get(key);
    if (id === null || id === '') {
      id = randomId();
      await this.deps.storage.set(key, id);
    }
    this.anonymousId = id;
    return id;
  }
}
