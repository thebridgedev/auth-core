import type { JWTPayload } from 'jose';
import { freezeActor, type Actor, type ActorKind } from './actor.js';
import { refuse, type Refusal } from './refusal.js';

/**
 * The claims of a checked access token that the verifier reads, in one place.
 *
 * | Claim        | Means                                                        |
 * |--------------|--------------------------------------------------------------|
 * | `sub`        | Who is calling: the user's id, or the job's id               |
 * | `aid`        | The app the token was issued for                             |
 * | `tid`        | The workspace, when the token is bound to one                |
 * | `privileges` | What the caller may do (an array of privilege names)         |
 * | `scope`      | The scopes granted, space separated                          |
 * | `role`       | The person's role in the workspace                           |
 * | `kind`       | `job` for a job's token. Absent means a person's token       |
 * | `jti`, `sid` | The token's id and the sign-in session it belongs to         |
 *
 * Tokens issued to keys are not read here yet: keys are checked by the
 * introspection endpoint until the key model settles their token format.
 */
const KIND_CLAIM = 'kind';

/** The token kinds this version of the verifier reads from a token's `kind` claim. */
const TOKEN_KIND_VALUES: ReadonlyMap<string, ActorKind> = new Map<string, ActorKind>([
  ['person', 'person'],
  ['job', 'job'],
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

/**
 * Build an Actor from the payload of a token whose signature, algorithm,
 * issuer, audience and lifetime the verifier has already checked.
 */
export function actorFromTokenClaims(
  payload: JWTPayload,
  expectedAppId: string,
): { actor: Actor } | { refusal: Refusal } {
  const sub = optionalString(payload.sub);
  if (!sub) return { refusal: refuse('invalid_claims', 'The token does not name who is calling.') };

  const appId = optionalString(payload.aid);
  if (!appId) return { refusal: refuse('invalid_claims', 'The token does not name its app.') };
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
  if (workspaceId === undefined) {
    return { refusal: refuse('invalid_claims', 'The token names its workspace in a malformed way.') };
  }
  if (kind === 'job' && workspaceId === null) {
    return { refusal: refuse('invalid_claims', "A job's token must name its workspace.") };
  }

  const privileges = readPrivileges(payload.privileges);
  if (!privileges) return { refusal: refuse('invalid_claims', 'The token lists its privileges in a malformed way.') };

  const scopes = readScopes(payload.scope);
  if (!scopes) return { refusal: refuse('invalid_claims', 'The token lists its scopes in a malformed way.') };

  const role = optionalString(payload.role);

  const actor: Actor = {
    kind,
    id: sub,
    appId,
    workspaceId,
    privileges,
    scopes,
    personId: kind === 'person' ? sub : null,
    jobId: kind === 'job' ? sub : null,
    role: kind === 'person' ? (role ?? null) : null,
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
