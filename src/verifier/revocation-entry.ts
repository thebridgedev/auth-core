import { KEY_KINDS, type Actor } from './actor.js';
import type { RevocationVerdict } from './revocation.js';

/**
 * The revocation list's entry format, version 1, and how an entry is matched
 * against an Actor.
 *
 * The list is one per app, split into lanes: one lane per writer. Each lane
 * is numbered on its own, from 1, with no gaps. An entry is a compact JWS
 * (ES256) whose payload is one JSON object:
 *
 * | Field       | Means                                                                 |
 * |-------------|-----------------------------------------------------------------------|
 * | `v`         | The format version: `1`                                               |
 * | `app`       | The app the entry belongs to                                          |
 * | `lane`      | The lane that wrote it                                                |
 * | `seq`       | Its number in the lane: 1, 2, 3 …                                     |
 * | `at`        | When it was written, in milliseconds since the epoch                  |
 * | `kind`      | What it takes away (below)                                            |
 * | `id`        | Which one: a token id, session id, key id, client id, person id, …    |
 * | `workspace` | The workspace it is limited to, where the kind allows one            |
 * | `scope`     | For `billing`: `workspace` or `app`                                   |
 * | `version`   | For `billing`: the workspace's or app's new billing version           |
 * | `before`    | Credentials issued before this time (ms) are refused                  |
 *
 * What each kind takes away:
 *
 * | Kind        | Refuses                                                                   |
 * |-------------|---------------------------------------------------------------------------|
 * | `token`     | The token whose `jti` is `id`                                             |
 * | `session`   | Every token of the sign-in session `id` (`sid`)                           |
 * | `key`       | The key `id`                                                              |
 * | `client`    | Tokens issued to the client `id` (`client_id`) before `before`           |
 * | `person`    | The person's tokens and personal keys issued before `before`, in `workspace` only when it is set |
 * | `workspace` | Every credential bound to workspace `id` issued before `before`          |
 * | `role`      | Tokens carrying role `id` in `workspace`, issued before `before`         |
 * | `billing`   | Credentials of the workspace `id` (scope `workspace`) or of the whole app (scope `app`) issued before `before`, so they are renewed with the new plan |
 * | `ownership` | Nothing by itself: who owns the app `id` changed. It reaches `onEntry` listeners, which drop what they cached about it |
 *
 * A credential that does not say when it was issued is refused by every
 * entry with a `before` that matches it: nothing proves it is newer.
 */

/** The format version this package reads and asks the list for. */
export const REVOCATION_FORMAT_VERSION = 1;

/** The JWS `typ` every entry carries. */
export const REVOCATION_ENTRY_TYPE = 'revocation+jws';

/** The one algorithm entries are signed with. */
export const REVOCATION_ALGORITHMS: readonly string[] = Object.freeze(['ES256']);

export type RevocationKind =
  | 'token'
  | 'session'
  | 'key'
  | 'client'
  | 'person'
  | 'workspace'
  | 'role'
  | 'billing'
  | 'ownership';

/** One checked entry of the revocation list. */
export interface RevocationEntry {
  readonly v: 1;
  readonly app: string;
  readonly lane: string;
  readonly seq: number;
  readonly at: number;
  readonly kind: RevocationKind;
  readonly id: string | null;
  readonly workspace: string | null;
  readonly scope: 'workspace' | 'app' | null;
  readonly version: number | null;
  readonly before: number | null;
}

const WITHOUT_CUTOFF: ReadonlySet<RevocationKind> = new Set(['token', 'session', 'key']);

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isWholeNumber(value: unknown, min: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min;
}

/**
 * Read an entry's payload. Anything this version does not understand fully
 * is refused (null): an unknown kind, a missing field, a field of the wrong
 * type. A refused entry stops its lane rather than being skipped, so nothing
 * is ever silently ignored.
 */
export function parseRevocationEntry(payload: unknown): RevocationEntry | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  if (p.v !== REVOCATION_FORMAT_VERSION) return null;
  if (!isText(p.app) || !isText(p.lane)) return null;
  if (!isWholeNumber(p.seq, 1) || !isWholeNumber(p.at, 0)) return null;

  const kind = p.kind as RevocationKind;
  const id = p.id === undefined ? null : p.id;
  const workspace = p.workspace === undefined ? null : p.workspace;
  const before = p.before === undefined ? null : p.before;
  if (id !== null && !isText(id)) return null;
  if (workspace !== null && !isText(workspace)) return null;
  if (before !== null && !isWholeNumber(before, 0)) return null;

  let scope: RevocationEntry['scope'] = null;
  let version: number | null = null;

  switch (kind) {
    case 'token':
    case 'session':
    case 'key':
    case 'client':
    case 'workspace':
    case 'ownership':
      if (id === null || workspace !== null) return null;
      break;
    case 'person':
      if (id === null) return null;
      break;
    case 'role':
      if (id === null || workspace === null) return null;
      break;
    case 'billing':
      if (p.scope !== 'workspace' && p.scope !== 'app') return null;
      scope = p.scope;
      if (!isWholeNumber(p.version, 1)) return null;
      version = p.version;
      if (workspace !== null) return null;
      if (scope === 'workspace' ? id === null : id !== null) return null;
      break;
    default:
      return null;
  }
  if (WITHOUT_CUTOFF.has(kind) ? before !== null : before === null) return null;
  if (kind !== 'billing' && (p.scope !== undefined || p.version !== undefined)) return null;

  return Object.freeze({
    v: 1,
    app: p.app,
    lane: p.lane,
    seq: p.seq,
    at: p.at,
    kind,
    id: id as string | null,
    workspace: workspace as string | null,
    scope,
    version,
    before: before as number | null,
  });
}

const NOT_REVOKED: RevocationVerdict = Object.freeze({ revoked: false });

function revoked(message: string): RevocationVerdict {
  return Object.freeze({ revoked: true, message });
}

const SEP = '\u0000';

/**
 * Every accepted entry, indexed for the checks the verifier makes on each
 * request. Cutoffs keep only the latest time per subject: a credential issued
 * before the latest cutoff is refused, whatever came before it.
 */
export class RevocationIndex {
  private readonly tokens = new Set<string>();
  private readonly sessions = new Set<string>();
  private readonly keys = new Set<string>();
  private readonly clients = new Map<string, number>();
  private readonly people = new Map<string, number>();
  private readonly workspaces = new Map<string, number>();
  private readonly roles = new Map<string, number>();
  private appCutoff: number | null = null;

  add(entry: RevocationEntry): void {
    const later = (map: Map<string, number>, key: string, at: number) => {
      const current = map.get(key);
      if (current === undefined || at > current) map.set(key, at);
    };
    const id = entry.id ?? '';
    const before = entry.before ?? 0;
    switch (entry.kind) {
      case 'token':
        this.tokens.add(id);
        break;
      case 'session':
        this.sessions.add(id);
        break;
      case 'key':
        this.keys.add(id);
        break;
      case 'client':
        later(this.clients, id, before);
        break;
      case 'person':
        later(this.people, entry.workspace === null ? id : `${id}${SEP}${entry.workspace}`, before);
        break;
      case 'workspace':
        later(this.workspaces, id, before);
        break;
      case 'role':
        later(this.roles, `${id}${SEP}${entry.workspace}`, before);
        break;
      case 'billing':
        if (entry.scope === 'app') {
          if (this.appCutoff === null || before > this.appCutoff) this.appCutoff = before;
        } else {
          later(this.workspaces, id, before);
        }
        break;
      case 'ownership':
        // Changes who owns an app. It refuses no credential by itself.
        break;
    }
  }

  /** Whether any accepted entry takes this Actor's access away. */
  check(actor: Actor): RevocationVerdict {
    const credential = actor.credential;
    if (credential.tokenId !== null && this.tokens.has(credential.tokenId)) {
      return revoked('The token was revoked.');
    }
    if (credential.sessionId !== null && this.sessions.has(credential.sessionId)) {
      return revoked('The sign-in session was ended.');
    }
    if (KEY_KINDS.includes(actor.kind) && this.keys.has(actor.id)) {
      return revoked('The key was revoked.');
    }

    // A credential that does not say when it was issued cannot be newer than any cutoff.
    const issuedAt = credential.issuedAt === null ? -Infinity : credential.issuedAt * 1000;
    const cut = (cutoff: number | undefined | null) => cutoff !== undefined && cutoff !== null && issuedAt < cutoff;

    const clientId = actor.claims.client_id;
    if (typeof clientId === 'string' && cut(this.clients.get(clientId))) {
      return revoked("The client's access was taken away.");
    }
    if (actor.personId !== null) {
      if (cut(this.people.get(actor.personId))) return revoked("The person's access was taken away.");
      if (actor.workspaceId !== null && cut(this.people.get(`${actor.personId}${SEP}${actor.workspaceId}`))) {
        return revoked("The person's access to the workspace was taken away.");
      }
    }
    if (actor.workspaceId !== null) {
      if (cut(this.workspaces.get(actor.workspaceId))) {
        return revoked('Access to the workspace changed; a new credential is needed.');
      }
      if (actor.role !== null && cut(this.roles.get(`${actor.role}${SEP}${actor.workspaceId}`))) {
        return revoked('The role changed; a new credential is needed.');
      }
    }
    if (cut(this.appCutoff)) return revoked("The app's plan changed; a new credential is needed.");
    return NOT_REVOKED;
  }
}
