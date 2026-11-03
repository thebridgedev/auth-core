import type { JWTPayload } from 'jose';
import { freezeActor, type Actor, type ActorKind } from './actor.js';
import { refuse, type Refusal } from './refusal.js';

/**
 * The claims of a checked access token that the verifier reads, in one place.
 *
 * | Claim        | Means                                                              |
 * |--------------|--------------------------------------------------------------------|
 * | `sub`        | Who is calling: the user's id, the job's id, or the key's id       |
 * | `aid`        | The app the token was issued for                                   |
 * | `tid`        | The workspace, when the token is bound to one                      |
 * | `kind`       | What kind of caller (below). Absent means a person's token         |
 * | `uid`        | For a personal key's token: the user the key acts for              |
 * | `jid`        | For a personal key made for one job: that job                      |
 * | `privileges` | What the caller may do (an array of privilege names)               |
 * | `scope`      | The scopes granted, space separated                                |
 * | `role`       | A person's role in the workspace                                   |
 * | `jti`, `sid` | The token's id and the sign-in session it belongs to               |
 *
 * `kind` is one of:
 *
 * - `person` (or absent): a signed-in person. `sub` is the user's id.
 * - `job`: a background job. `sub` is the job's id; `tid` is required.
 * - `personal_key`, `service_account_key`, `app_key`: a short-lived token the
 *   issuer gave in exchange for a key, so the key itself is presented only
 *   once. `sub` is the key's id. It becomes the same Actor the key itself
 *   would: a personal key's and a service account key's token name their
 *   workspace (`tid`), an app key's names none; a personal key's token names
 *   the user it acts for (`uid`), and the job (`jid`) when the key was made for
 *   one.
 *
 * Any other `kind`, including a service's, is refused.
 */
const KIND_CLAIM = 'kind';

/** The kinds this version of the verifier reads from a token's `kind` claim. */
const TOKEN_KIND_VALUES: ReadonlyMap<string, ActorKind> = new Map<string, ActorKind>([
  ['person', 'person'],
  ['job', 'job'],
  ['personal_key', 'personal_key'],
  ['service_account_key', 'service_account_key'],
  ['app_key', 'app_key'],
]);

function optionalString(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readPrivileges(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((p) => typeof p === 'string')) return undefined;
  return [...value];
}

function readScopes(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return [];
  if (typeof value !== 'string') return undefined;
  return value.split(' ').filter((s) => s.length > 0);
}

function invalid(message: string): { refusal: Refusal } {
  return { refusal: refuse('invalid_claims', message) };
}

/** Who stands behind the token, by kind: the person it acts for, the job it is narrowed to, its role. */
function readWho(
  kind: ActorKind,
  sub: string,
  payload: JWTPayload,
): { personId: string | null; jobId: string | null; role: string | null } | { refusal: Refusal } {
  switch (kind) {
    case 'person':
      return { personId: sub, jobId: null, role: optionalString(payload.role) ?? null };
    case 'job':
      return { personId: null, jobId: sub, role: null };
    case 'personal_key': {
      const userId = optionalString(payload.uid);
      const jobId = optionalString(payload.jid);
      if (!userId) return invalid("A personal key's token must name the user the key acts for.");
      if (jobId === undefined) return invalid('The token names its job in a malformed way.');
      return { personId: userId, jobId, role: null };
    }
    default:
      // A service account key or an app key: no person behind it, never one job.
      if (payload.jid !== undefined) return invalid('Only a personal key can be made for one job.');
      return { personId: null, jobId: null, role: null };
  }
}

/**
 * Build an Actor from the payload of a token whose signature, algorithm,
 * type, issuer, audience and lifetime the verifier has already checked.
 */
export function actorFromTokenClaims(
  payload: JWTPayload,
  expectedAppId: string,
): { actor: Actor } | { refusal: Refusal } {
  const sub = optionalString(payload.sub);
  if (!sub) return invalid('The token does not name who is calling.');

  const appId = optionalString(payload.aid);
  if (!appId) return invalid('The token does not name its app.');
  if (appId !== expectedAppId) {
    return { refusal: refuse('wrong_app', 'The token was issued for a different app.') };
  }

  const rawKind = payload[KIND_CLAIM];
  const kind: ActorKind | undefined =
    rawKind === undefined
      ? 'person'
      : typeof rawKind === 'string'
        ? TOKEN_KIND_VALUES.get(rawKind)
        : undefined;
  if (!kind) {
    return { refusal: refuse('wrong_type', 'This kind of token is not accepted here.') };
  }

  const workspaceId = optionalString(payload.tid);
  if (workspaceId === undefined) return invalid('The token names its workspace in a malformed way.');
  const bound = kind === 'job' || kind === 'personal_key' || kind === 'service_account_key';
  if (bound && workspaceId === null) return invalid('This kind of token must name its workspace.');
  if (kind === 'app_key' && workspaceId !== null) {
    return invalid("An app key's token reaches the whole app and cannot name a workspace.");
  }

  const privileges = readPrivileges(payload.privileges);
  if (!privileges) return invalid('The token lists its privileges in a malformed way.');

  const scopes = readScopes(payload.scope);
  if (!scopes) return invalid('The token lists its scopes in a malformed way.');

  const who = readWho(kind, sub, payload);
  if ('refusal' in who) return who;

  const actor: Actor = {
    kind,
    id: sub,
    appId,
    workspaceId,
    privileges,
    scopes,
    personId: who.personId,
    jobId: who.jobId,
    role: who.role,
    credential: {
      type: 'token',
      checkedBy: 'signature',
      expiresAt: optionalNumber(payload.exp),
      issuedAt: optionalNumber(payload.iat),
      tokenId: optionalString(payload.jti) ?? null,
      sessionId: optionalString(payload.sid) ?? null,
    },
    claims: { ...payload },
  };
  return { actor: freezeActor(actor) };
}
