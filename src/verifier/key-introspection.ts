import { freezeActor, type Actor, type ActorKind } from './actor.js';
import { refuse, type Refusal } from './refusal.js';

/**
 * Checking keys, through the issuer's introspection endpoint.
 *
 * A key is a secret the verifier cannot check by itself, so it asks the
 * issuer: it POSTs `{ token }` to the introspection endpoint, which answers
 * whether the key is active and what it may reach. The issuer re-checks the
 * key on every call, so a revoked key stops working at once.
 *
 * The answer this module reads:
 *
 * | Field        | Means                                                        |
 * |--------------|--------------------------------------------------------------|
 * | `active`     | `true` only when the key is valid, unexpired and not revoked |
 * | `type`       | Always `api` for a key                                       |
 * | `sub`        | The key's id                                                 |
 * | `appId`      | The app the key belongs to                                   |
 * | `tenantId`   | The workspace the key is bound to, or null                   |
 * | `kind`       | Optional: which kind of key (see below)                      |
 * | `userId`     | Optional: the member a personal key acts for                 |
 * | `jobId`      | Optional: the one job a personal key was made for            |
 * | `privileges` | What the key may do                                          |
 * | `scope`      | Optional: the scopes granted, space separated                |
 * | `exp`, `iat` | Optional: expiry and issue time, in seconds                  |
 *
 * `kind` is one of `personal_key`, `service_account_key`, `app_key` or
 * `service`. An answer without it describes a key bound to one workspace
 * (`tenantId` set) as a service account key, and a key bound to none as an
 * app key.
 */
export interface IntrospectionAnswer {
  active?: unknown;
  type?: unknown;
  sub?: unknown;
  appId?: unknown;
  tenantId?: unknown;
  kind?: unknown;
  userId?: unknown;
  jobId?: unknown;
  privileges?: unknown;
  scope?: unknown;
  exp?: unknown;
  iat?: unknown;
}

const KEY_KIND_VALUES: ReadonlyMap<string, ActorKind> = new Map<string, ActorKind>([
  ['personal_key', 'personal_key'],
  ['service_account_key', 'service_account_key'],
  ['app_key', 'app_key'],
  ['service', 'service'],
]);

export interface KeyExpectations {
  /** The app this verifier checks credentials for. */
  appId: string;
  /** The app whose service keys may call across apps. Unset: service keys are refused. */
  trustedServiceAppId?: string;
  /** Now, in seconds since the epoch. */
  nowSeconds: number;
}

function text(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function seconds(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Turn an introspection answer into an Actor, or say why the key is refused. */
export function actorFromIntrospection(
  answer: IntrospectionAnswer,
  expected: KeyExpectations,
): { actor: Actor } | { refusal: Refusal } {
  if (answer.active !== true) {
    return { refusal: refuse('inactive', 'The key is not active.') };
  }
  if (answer.type !== 'api') {
    return { refusal: refuse('wrong_type', 'The credential is not a key.') };
  }

  const id = text(answer.sub);
  if (!id) return { refusal: refuse('invalid_claims', 'The key has no id.') };

  const appId = text(answer.appId);
  if (!appId) return { refusal: refuse('invalid_claims', 'The key does not name its app.') };

  const workspaceId = text(answer.tenantId);
  if (workspaceId === undefined) {
    return { refusal: refuse('invalid_claims', 'The key names its workspace in a malformed way.') };
  }

  let kind: ActorKind | undefined;
  if (answer.kind === undefined || answer.kind === null) {
    kind = workspaceId ? 'service_account_key' : 'app_key';
  } else if (typeof answer.kind === 'string') {
    kind = KEY_KIND_VALUES.get(answer.kind);
  }
  if (!kind) return { refusal: refuse('wrong_type', 'This kind of key is not accepted here.') };

  if (kind === 'service') {
    if (!expected.trustedServiceAppId) {
      return { refusal: refuse('not_accepted', 'Service keys are not accepted here.') };
    }
    if (appId !== expected.trustedServiceAppId) {
      return { refusal: refuse('wrong_app', 'The key was issued for a different app.') };
    }
  } else if (appId !== expected.appId) {
    return { refusal: refuse('wrong_app', 'The key was issued for a different app.') };
  }

  const reachesOneWorkspace = kind === 'personal_key' || kind === 'service_account_key';
  if (reachesOneWorkspace && !workspaceId) {
    return { refusal: refuse('invalid_claims', 'This kind of key must name its workspace.') };
  }
  if (!reachesOneWorkspace && workspaceId) {
    return { refusal: refuse('invalid_claims', 'This kind of key cannot be bound to a workspace.') };
  }

  const personId = text(answer.userId);
  if (personId === undefined) {
    return { refusal: refuse('invalid_claims', 'The key names its member in a malformed way.') };
  }
  if (kind === 'personal_key' && !personId) {
    return { refusal: refuse('invalid_claims', 'A personal key must name the member it acts for.') };
  }

  const jobId = text(answer.jobId);
  if (jobId === undefined || (jobId && kind !== 'personal_key')) {
    return { refusal: refuse('invalid_claims', 'Only a personal key can be made for one job.') };
  }

  const privileges = answer.privileges ?? [];
  if (!Array.isArray(privileges) || !privileges.every((p) => typeof p === 'string')) {
    return { refusal: refuse('invalid_claims', 'The key lists its privileges in a malformed way.') };
  }

  const scope = answer.scope ?? '';
  if (typeof scope !== 'string') {
    return { refusal: refuse('invalid_claims', 'The key lists its scopes in a malformed way.') };
  }

  const expiresAt = seconds(answer.exp);
  if (expiresAt !== null && expiresAt <= expected.nowSeconds) {
    return { refusal: refuse('expired', 'The key has expired.') };
  }

  const actor: Actor = {
    kind,
    id,
    appId,
    workspaceId,
    privileges: [...(privileges as string[])],
    scopes: scope.split(' ').filter((s) => s.length > 0),
    personId: kind === 'personal_key' ? personId : null,
    jobId,
    role: null,
    credential: {
      type: 'key',
      checkedBy: 'introspection',
      expiresAt,
      issuedAt: seconds(answer.iat),
      tokenId: null,
      sessionId: null,
    },
    claims: { ...answer },
  };
  return { actor: freezeActor(actor) };
}

export interface IntrospectionClientOptions {
  url: string;
  fetch: typeof fetch;
  /** How long a successful answer is reused. `0` asks every time. @default 0 */
  cacheTtlMs?: number;
  /** How long to wait for the endpoint. @default 5000 */
  timeoutMs?: number;
}

export type IntrospectionResult =
  | { answer: IntrospectionAnswer }
  | { refusal: Refusal };

/**
 * Ask the introspection endpoint about a key. Answers that say the key is
 * active may be cached for `cacheTtlMs`, keyed by a hash of the key so the
 * cache never holds the key itself.
 */
export function createIntrospectionClient(options: IntrospectionClientOptions) {
  const cacheTtlMs = options.cacheTtlMs ?? 0;
  const timeoutMs = options.timeoutMs ?? 5000;
  const cache = new Map<string, { answer: IntrospectionAnswer; expiresAt: number }>();

  async function cacheKey(key: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
    let hex = '';
    for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, '0');
    return hex;
  }

  return async function introspect(key: string): Promise<IntrospectionResult> {
    const slot = cacheTtlMs > 0 ? await cacheKey(key) : null;
    if (slot) {
      const hit = cache.get(slot);
      if (hit && Date.now() < hit.expiresAt) return { answer: hit.answer };
      if (hit) cache.delete(slot);
    }

    let response: Response;
    try {
      const signal =
        typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(timeoutMs)
          : undefined;
      response = await options.fetch(options.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ token: key }),
        signal,
      });
    } catch {
      return { refusal: refuse('unavailable', 'The key could not be checked: the issuer did not answer.') };
    }

    if (!response.ok) {
      return { refusal: refuse('unavailable', 'The key could not be checked: the issuer answered with an error.') };
    }

    let answer: unknown;
    try {
      answer = await response.json();
    } catch {
      return { refusal: refuse('unavailable', 'The key could not be checked: the answer was not readable.') };
    }
    if (!answer || typeof answer !== 'object' || Array.isArray(answer)) {
      return { refusal: refuse('unavailable', 'The key could not be checked: the answer was not readable.') };
    }

    const typed = answer as IntrospectionAnswer;
    if (slot && typed.active === true) {
      cache.set(slot, { answer: typed, expiresAt: Date.now() + cacheTtlMs });
    }
    return { answer: typed };
  };
}
