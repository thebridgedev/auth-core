/**
 * The management client: the Child App's own server managing its Bridge app
 * with the app's key. It keeps the names of the 0.8 client (`tenants`,
 * `users`, `roles`, `flags`, `plans`, `events`, `workflows`) so moving to 1.0
 * is a rename of the setup call, and calls Bridge's version 2 API.
 *
 * Every address comes from the issuer's metadata; the client appends only the
 * route's own path. The app's key is sent as `x-api-key`, never anywhere
 * else, and never read here. A call for one workspace names it
 * (`Bridge-Workspace`).
 *
 * What the app's own key may do is decided by Bridge, by the key's
 * privileges: a call it may not make is refused (403), never quietly changed.
 * The app's own record, the look of its sign-in page and its setup progress
 * need the key to hold the privilege the dashboard asks for the same action.
 * Making and revoking keys has no call: a key may never make keys.
 */
import { Discovery, type IssuerMetadata } from '../core/discovery.js';
import { BridgeError } from '../core/errors.js';
import { call, platformFetch, type Fetch } from '../core/http.js';

type Json = Record<string, unknown>;
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Which part of Bridge's API a call goes to. */
export type ManagementArea = 'accounts' | 'billing' | 'flags' | 'events-and-logs' | 'communication' | 'identity-access' | 'app-registry';

/** The revision a change is made on: the `ETag` a read gave, or the flag's or segment's `revision`. */
export type Revision = string | number;

export interface ManagementRequest {
  /** The workspace the call is for: sent as `Bridge-Workspace`. */
  readonly workspace?: string;
  readonly body?: unknown;
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  /** The same key across retries of one write makes it happen once. */
  readonly idempotencyKey?: string;
  /** Sent as `If-Match`: the change is made only if the thing is still at this revision. */
  readonly ifMatch?: Revision;
}

export interface ManagementOptions {
  /** The app's issuer, as for the browser SDK. */
  readonly issuer?: string;
  /** Or the server `createBridgeServer` made, which has read the issuer's metadata already. */
  readonly server?: { readonly ready: Promise<void>; metadata(): IssuerMetadata };
  /** The app's own key. Keep it on the server. */
  readonly appKey: string;
  readonly fetch?: Fetch;
  /** How long one call may take, answer included, before it fails with `network`. @default 10000 */
  readonly timeoutMs?: number;
}

/** What `events.query` answers for one event, as in 0.8. */
export interface EventResult {
  id: string;
  type: string;
  tenantId?: string;
  userId?: string;
  data?: Record<string, unknown>;
  createdAt: string;
}

export interface EventQuery {
  /** The event's type. */
  type?: string;
  /** A workspace's id (0.8's name for it). `workspaceId` is the same. */
  tenantId?: string;
  workspaceId?: string;
  userId?: string;
  email?: string;
  /** An ISO time, or how long ago: `24h`, `7d`, `2w`, `1m` (30 days). */
  since?: string;
  until?: string;
  /** 1 to 100. @default 50 */
  limit?: number;
  /** The `next` of the page before. */
  cursor?: string;
}

/** A flag as Bridge answers it. `revision` is what a change names in `ifMatch`. */
export interface ManagedFlag {
  readonly id?: string;
  readonly key: string;
  readonly description?: string;
  readonly state: 'off' | 'on' | 'on-with-rule';
  readonly valueType?: 'boolean' | 'string' | 'number' | 'json';
  readonly onValue?: unknown;
  readonly offValue?: unknown;
  readonly rule?: Json | null;
  readonly public?: boolean;
  readonly revision: number;
  readonly [field: string]: unknown;
}

/** The fields of a flag a call may set. */
export interface FlagFields {
  readonly key?: string;
  readonly description?: string;
  readonly state?: ManagedFlag['state'];
  readonly valueType?: ManagedFlag['valueType'];
  readonly onValue?: unknown;
  readonly offValue?: unknown;
  /** The rule, or `null` to clear it. */
  readonly rule?: Json | null;
  /** Whether a visitor, who is not signed in, may see the flag. Off unless set. */
  readonly public?: boolean;
}

export interface Change {
  /** The revision the change is made on. Left out, the current one is read first. */
  readonly ifMatch?: Revision;
}

export const MANAGEMENT_TIMEOUT_MS = 10_000;

const ZERO_DECIMAL = new Set(['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf']);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function segment(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '') throw new BridgeError('invalid', `"${name}" is needed.`);
  return encodeURIComponent(value);
}

function ifMatchOf(revision: Revision): string {
  if (typeof revision === 'number') {
    if (!Number.isSafeInteger(revision) || revision < 0) throw new BridgeError('invalid', '"ifMatch" is a revision: a whole number, or the ETag a read gave.');
    return `"${String(revision)}"`;
  }
  const value = typeof revision === 'string' ? revision.trim() : '';
  if (value === '') throw new BridgeError('invalid', '"ifMatch" is a revision: a whole number, or the ETag a read gave.');
  return /^(?:W\/)?".*"$/.test(value) ? value : `"${value}"`;
}

/** The 0.8 client took `24h`, `7d`, `2w`, `1m` as well as a date for `since`. */
function sinceOf(since: string): string {
  const relative = /^(\d+)([hdwm])$/.exec(since.trim());
  if (relative === null) return since;
  const unit: Record<string, number> = { h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000, m: 30 * 86_400_000 };
  return new Date(Date.now() - Number(relative[1]) * (unit[relative[2] as string] as number)).toISOString();
}

const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

export function createBridgeManagement(options: ManagementOptions) {
  if (typeof options.appKey !== 'string' || options.appKey === '') throw new BridgeError('misconfigured', 'The management client needs the app key: pass `appKey`.');
  if (options.issuer === undefined && options.server === undefined) throw new BridgeError('misconfigured', 'Pass the `issuer`, or the `server` that createBridgeServer made.');
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    throw new BridgeError('misconfigured', 'The management client holds the app key and runs only on a server, never in a browser.');
  }
  const fetchFn = options.fetch ?? platformFetch();
  const discovery = options.issuer === undefined ? null : new Discovery(options.issuer, fetchFn);
  const timeoutMs = options.timeoutMs ?? MANAGEMENT_TIMEOUT_MS;

  async function metadata(): Promise<IssuerMetadata> {
    if (options.server !== undefined) {
      await options.server.ready;
      return options.server.metadata();
    }
    return (await (discovery as Discovery).get({ now: true })).metadata;
  }

  async function base(area: ManagementArea): Promise<string> {
    const { endpoints } = await metadata();
    const listed = area === 'events-and-logs' ? endpoints.events_and_logs : area === 'accounts' ? endpoints.accounts : area === 'billing' ? endpoints.billing : area === 'flags' ? endpoints.flags : undefined;
    if (listed !== undefined) return listed.replace(/\/+$/, '');
    if (area === 'communication' || area === 'identity-access' || area === 'events-and-logs' || area === 'app-registry') {
      // FALLBACK: the issuer lists no address for this part of the API; every part sits beside Accounts, at `…/v2/<part>`.
      const accounts = endpoints.accounts?.replace(/\/+$/, '');
      if (accounts !== undefined && accounts.endsWith('/accounts')) return `${accounts.slice(0, -'/accounts'.length)}/${area}`;
    }
    throw new BridgeError('misconfigured', `The issuer's metadata lists no "${area}" endpoint.`);
  }

  async function send<T = Json>(method: Method, area: ManagementArea, path: string, request: ManagementRequest = {}): Promise<{ body: T; etag: string | null }> {
    const url = new URL(`${await base(area)}${path}`);
    for (const [name, value] of Object.entries(request.query ?? {})) if (value !== undefined) url.searchParams.set(name, String(value));
    const headers: Record<string, string> = {};
    if (request.workspace !== undefined) headers['Bridge-Workspace'] = request.workspace;
    if (request.idempotencyKey !== undefined) headers['Idempotency-Key'] = request.idempotencyKey;
    if (request.ifMatch !== undefined) headers['If-Match'] = ifMatchOf(request.ifMatch);
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const answer = await call<T>(fetchFn, url.href, { method, apiKey: options.appKey, headers, signal, ...(request.body === undefined ? {} : { body: request.body }) });
      return { body: answer.body, etag: answer.etag };
    } catch (cause) {
      if (signal.aborted && !(cause instanceof BridgeError)) throw new BridgeError('network', `Bridge did not answer within ${String(timeoutMs)} ms.`, { cause });
      throw cause;
    }
  }

  const run = async <T = Json>(method: Method, area: ManagementArea, path: string, request?: ManagementRequest): Promise<T> => (await send<T>(method, area, path, request)).body;
  const at = (workspace: string, request: Omit<ManagementRequest, 'workspace'> = {}): ManagementRequest => {
    if (typeof workspace !== 'string' || workspace === '') throw new BridgeError('invalid', '"workspaceId" is needed.');
    return { ...request, workspace };
  };

  const app = {
    /** The app's own record, in 0.8's names: `redirectUris`, `allowedOrigins`, `defaultCallbackUri`, the profile addresses. */
    get: () => run<Json>('GET', 'app-registry', '/app'),
    /** Changes the fields you give. Needs the privilege to change the app's settings on your key. */
    update: (data: Json) => run<Json>('PATCH', 'app-registry', '/app', { body: data }),
  };

  const getBranding = () => run<Json>('GET', 'app-registry', '/branding');
  async function updateBranding(data: Json, change: Change = {}): Promise<Json> {
    let ifMatch = change.ifMatch;
    if (ifMatch === undefined) {
      const read = await send<Json>('GET', 'app-registry', '/branding');
      ifMatch = read.etag ?? (typeof read.body['version'] === 'number' ? read.body['version'] : undefined);
      if (ifMatch === undefined) throw new BridgeError('invalid', 'Bridge gave no version for the branding: pass `ifMatch`.');
    }
    return run<Json>('PATCH', 'app-registry', '/branding', { body: data, ifMatch });
  }

  const branding = {
    /** How the app's hosted sign-in page looks: scheme, colors, radius, font, logo, its own CSS, with the choices on offer and the `version` read. */
    get: getBranding,
    /**
     * Changes the fields you give (`scheme`, `colors`, `radius`, `font`, `css`), merged. Bridge makes a change only on
     * the version you read: it is read first, unless you name the one you saw in `ifMatch`. Needs the privilege to
     * change the app's settings on your key.
     */
    update: updateBranding,
    /** The app's own CSS, as Bridge saved it (checked and written out again), in 0.8's `{ content }`; `content` is empty when there is none. */
    async getCss(): Promise<{ content: string }> {
      const read = await getBranding();
      return { content: typeof read['css'] === 'string' ? read['css'] : '' };
    },
    /**
     * Replaces the app's CSS. Bridge keeps only what the sign-in page may draw (paint, spacing and text; no `url()`, no
     * selector on a field's value) and refuses the rest with every reason (400, in `error.message`).
     */
    async updateCss(data: { content: string }): Promise<void> {
      if (typeof data?.content !== 'string') throw new BridgeError('invalid', 'updateCss takes `{ content }`, the CSS as text.');
      await updateBranding({ css: data.content });
    },
    /** Removes the app's CSS. */
    async deleteCss(): Promise<void> {
      await updateBranding({ css: null });
    },
  };

  const onboarding = {
    /**
     * How far the app's setup has come, from its own record: first sign-in, first user, first real sign-in, first paid
     * subscription. Needs the privilege to read members on your key. `since` is an ISO time.
     */
    get: (query: { since?: string } = {}) => run<Json>('GET', 'events-and-logs', '/setup-signals', query.since === undefined ? {} : { query: { since: query.since } }),
  };

  const workspaces = {
    /** The app's workspaces. */
    list: (query?: ManagementRequest['query']) => run<Json[]>('GET', 'accounts', '/workspaces', query === undefined ? {} : { query }),
    get: (workspaceId: string) => run('GET', 'accounts', '/workspace', at(workspaceId)),
    /** Makes a workspace; `owner` names the person who owns it (an email address, or `{ email, firstName, lastName }`). */
    create: (data: { name: string; owner?: Json | string; locale?: string; logo?: string; metadata?: Json; onboarded?: boolean }) => run('POST', 'accounts', '/workspaces', { body: data }),
    update: (workspaceId: string, data: Json) => run('PATCH', 'accounts', '/workspace', at(workspaceId, { body: data })),
    /** Schedules the workspace's deletion; `restore` takes it back while it can. */
    delete: (workspaceId: string) => run('DELETE', 'accounts', '/workspace', at(workspaceId)),
    restore: (workspaceId: string) => run('POST', 'accounts', '/workspace/restore', at(workspaceId)),
    suspend: (workspaceId: string) => run('POST', 'accounts', '/workspace/suspend', at(workspaceId)),
    resume: (workspaceId: string) => run('POST', 'accounts', '/workspace/resume', at(workspaceId)),
    /** Sets the subscription as the app decides, with no payment: plan, currency, interval, trial end. */
    setSubscription: (workspaceId: string, subscription: { plan: string; currency?: string; interval?: string; trialEnd?: string }) =>
      run('PUT', 'billing', '/payer/subscription', at(workspaceId, { body: subscription })),
  };

  const users = {
    /** A workspace's members. */
    list: (workspaceId: string, query?: ManagementRequest['query']) => run<Json[]>('GET', 'accounts', '/members', at(workspaceId, query === undefined ? {} : { query })),
    get: (workspaceId: string, userId: string) => run('GET', 'accounts', `/members/${segment(userId, 'userId')}`, at(workspaceId)),
    /**
     * Adds a person to a workspace at once, and emails them as Bridge always did. `username` (0.8's name for it) and
     * `email` are the same.
     */
    invite: (workspaceId: string, data: { email?: string; username?: string; role?: string; firstName?: string; lastName?: string; phoneNumber?: string; muteNotifications?: boolean; customParams?: unknown; consentsToPrivacyPolicy?: boolean; onboarded?: boolean }) => {
      const { username, ...rest } = data;
      const email = rest.email ?? username;
      if (email === undefined || !EMAIL.test(email)) throw new BridgeError('invalid', 'The person needs an email address: pass `email`.');
      return run('POST', 'accounts', '/members', at(workspaceId, { body: { ...rest, email } }));
    },
    update: (workspaceId: string, userId: string, data: Json) => run('PATCH', 'accounts', `/members/${segment(userId, 'userId')}`, at(workspaceId, { body: data })),
    remove: (workspaceId: string, userId: string) => run('DELETE', 'accounts', `/members/${segment(userId, 'userId')}`, at(workspaceId)),
    /** What removing a member would take with them. */
    deletionPreview: (workspaceId: string, userId: string) => run('GET', 'accounts', `/members/${segment(userId, 'userId')}/deletion-preview`, at(workspaceId)),
    /** A person of the app, in whichever workspace. */
    find: (userId: string) => run('GET', 'accounts', `/users/${segment(userId, 'userId')}`),
    /** Stops a person signing in to the app, in every workspace. */
    suspend: (userId: string) => run('POST', 'accounts', `/users/${segment(userId, 'userId')}/suspend`),
    resume: (userId: string) => run('POST', 'accounts', `/users/${segment(userId, 'userId')}/resume`),
  };

  const invites = {
    list: (workspaceId: string) => run<Json[]>('GET', 'accounts', '/invites', at(workspaceId)),
    /** Invites an address; the person accepts it. */
    send: (workspaceId: string, invite: { email: string; role?: string; firstName?: string; lastName?: string }) => run('POST', 'accounts', '/invites', at(workspaceId, { body: invite })),
    cancel: (workspaceId: string, inviteId: string) => run('DELETE', 'accounts', `/invites/${segment(inviteId, 'inviteId')}`, at(workspaceId)),
  };

  const roles = {
    list: () => run<Json[]>('GET', 'accounts', '/roles'),
    create: (data: { key: string; name: string; description?: string; privileges?: string[]; isDefault?: boolean }) => run('POST', 'accounts', '/roles', { body: data }),
    update: (roleId: string, data: Json) => run('PATCH', 'accounts', `/roles/${segment(roleId, 'roleId')}`, { body: data }),
    delete: (roleId: string) => run('DELETE', 'accounts', `/roles/${segment(roleId, 'roleId')}`),
    listPrivileges: () => run<Json[]>('GET', 'accounts', '/privileges'),
    createPrivilege: (data: { key: string; description?: string }) => run('POST', 'accounts', '/privileges', { body: data }),
    updatePrivilege: (privilegeId: string, data: Json) => run('PATCH', 'accounts', `/privileges/${segment(privilegeId, 'privilegeId')}`, { body: data }),
    deletePrivilege: (privilegeId: string) => run('DELETE', 'accounts', `/privileges/${segment(privilegeId, 'privilegeId')}`),
  };

  const flagPath = (key: string): string => `/flags/${segment(key, 'key')}`;
  const readFlag = async (key: string): Promise<{ flag: ManagedFlag; etag: string }> => {
    const { body, etag } = await send<ManagedFlag>('GET', 'flags', flagPath(key));
    return { flag: body, etag: etag ?? `"${String(body.revision)}"` };
  };

  const flags = {
    list: () => run<ManagedFlag[]>('GET', 'flags', '/flags'),
    get: async (key: string): Promise<ManagedFlag> => (await readFlag(key)).flag,
    /** The flag with its ETag, which a later `update` names as `ifMatch`. */
    getWithETag: readFlag,
    /** Makes a flag. A key that exists is refused (`conflict`). */
    create: (data: FlagFields & { key: string }) => run<ManagedFlag>('POST', 'flags', '/flags', { body: data }),
    /**
     * Changes the fields you give. Bridge refuses a change made on an old revision, so nobody overwrites what they did
     * not see: the current revision is read first, unless you name the one you saw in `ifMatch`.
     */
    async update(key: string, data: FlagFields, change: Change = {}): Promise<ManagedFlag> {
      const ifMatch = change.ifMatch ?? (await readFlag(key)).etag;
      return run<ManagedFlag>('PATCH', 'flags', flagPath(key), { body: data, ifMatch });
    },
    /**
     * Switches a flag on or off. On keeps the flag's rule: a flag with a rule goes to `on-with-rule`, so the audience
     * does not widen to everyone; a flag with none goes to `on`.
     */
    async toggle(key: string, enabled: boolean): Promise<ManagedFlag> {
      const { flag, etag } = await readFlag(key);
      const hasRule = flag.rule !== null && flag.rule !== undefined;
      const state: ManagedFlag['state'] = !enabled ? 'off' : hasRule ? 'on-with-rule' : 'on';
      return run<ManagedFlag>('PATCH', 'flags', flagPath(key), { body: { state }, ifMatch: etag });
    },
    delete: (key: string, change: Change = {}) => run('DELETE', 'flags', flagPath(key), change.ifMatch === undefined ? {} : { ifMatch: change.ifMatch }),
    /** Switches the flag off, keeping its rule. Needs no revision. */
    kill: (key: string) => run<ManagedFlag>('POST', 'flags', `${flagPath(key)}/kill`),
    /** Switches a killed flag back to the state it had. */
    restore: (key: string) => run<ManagedFlag>('POST', 'flags', `${flagPath(key)}/restore`),
    /** Saved groups of people a flag's rule can name. */
    listSegments: () => run<Json[]>('GET', 'flags', '/segments'),
    createSegment: (data: { key: string; description?: string; conditions?: unknown }) => run('POST', 'flags', '/segments', { body: data }),
    async updateSegment(key: string, data: Json, change: Change = {}): Promise<Json> {
      let ifMatch = change.ifMatch;
      if (ifMatch === undefined) {
        const found = (await run<Json[]>('GET', 'flags', '/segments')).find((segmentRow) => segmentRow['key'] === key);
        if (found === undefined) throw new BridgeError('not-found', `There is no segment "${key}".`, { status: 404 });
        const revision = found['revision'];
        if (typeof revision !== 'number' && typeof revision !== 'string') throw new BridgeError('invalid', 'Bridge gave no revision for the segment: pass `ifMatch`.');
        ifMatch = revision;
      }
      return run('PATCH', 'flags', `/segments/${segment(key, 'key')}`, { body: data, ifMatch });
    },
    deleteSegment: (key: string) => run('DELETE', 'flags', `/segments/${segment(key, 'key')}`),
    /** All the app's flags and segments, as a bundle `import` takes. */
    export: () => run('GET', 'flags', '/export'),
    /** Makes and changes what the bundle holds, whole or not at all; nothing is deleted. `dryRun` answers what it would do. */
    import: (bundle: Json, importOptions: { dryRun?: boolean } = {}) => run('POST', 'flags', '/import', { body: { ...bundle, ...(importOptions.dryRun === undefined ? {} : { dryRun: importOptions.dryRun }) } }),
  };

  const planPath = (key: string): string => `/plans/${segment(key, 'planKey')}`;
  const plans = {
    list: () => run<Json[]>('GET', 'billing', '/plans'),
    get: (planKey: string) => run('GET', 'billing', planPath(planKey)),
    /** Prices are in minor units (1999 is 19.99 EUR), one per currency and interval. */
    create: (data: Json & { key: string; name: string }) => run('POST', 'billing', '/plans', { body: data }),
    /** Changes the fields you give. */
    update: (planKey: string, data: Json) => run('PATCH', 'billing', planPath(planKey), { body: data }),
    /** Replaces the plan whole. */
    replace: (planKey: string, data: Json) => run('PUT', 'billing', planPath(planKey), { body: data }),
    delete: (planKey: string) => run('DELETE', 'billing', planPath(planKey)),
    /** What deleting the plan would affect. */
    deletionPreview: (planKey: string) => run('GET', 'billing', `${planPath(planKey)}/deletion-preview`),
    /** Retires a plan nobody can pick any more, or (`false`) takes it back. */
    archive: (planKey: string, archived = true) => run('POST', 'billing', `${planPath(planKey)}/archive`, { body: { archived } }),
  };

  const events = {
    /** The app's events, newest first, as 0.8 gave them. */
    async query(params: EventQuery = {}): Promise<EventResult[]> {
      return (await events.list(params)).events;
    },
    /** One page of the app's events, with the `next` cursor for the page after. */
    async list(params: EventQuery = {}): Promise<{ events: EventResult[]; next: string | null }> {
      const answer = await run<{ events?: Json[]; next?: string | null }>('GET', 'events-and-logs', '/audit', {
        query: {
          type: params.type,
          workspaceId: params.workspaceId ?? params.tenantId,
          userId: params.userId,
          email: params.email,
          from: params.since === undefined ? undefined : sinceOf(params.since),
          to: params.until,
          limit: params.limit,
          cursor: params.cursor,
        },
      });
      const rows = answer?.events ?? [];
      return {
        events: rows.map((row) => {
          const data = row['data'];
          return {
            id: String(row['id'] ?? ''),
            type: String(row['type'] ?? ''),
            ...(asString(row['workspaceId']) === undefined ? {} : { tenantId: asString(row['workspaceId']) as string }),
            ...(asString(row['userId']) === undefined ? {} : { userId: asString(row['userId']) as string }),
            ...(data !== null && typeof data === 'object' ? { data: data as Record<string, unknown> } : {}),
            createdAt: String(row['time'] ?? row['occurredAt'] ?? ''),
          };
        }),
        next: answer?.next ?? null,
      };
    },
  };

  const workflows = {
    /**
     * Connects the app's payment provider with a key you hold and, when `plans` is given, makes the plans. A plan's
     * `price` is in whole currency units (19.99), as 0.8 took it; Bridge keeps minor units, so it is converted.
     */
    async setupPayments(params: { stripeSecretKey: string; stripePublicKey?: string; plans?: Array<{ key: string; name: string; price: number; currency?: string; interval?: 'month' | 'year' }> }) {
      if (typeof params?.stripeSecretKey !== 'string' || params.stripeSecretKey === '') throw new BridgeError('invalid', 'setupPayments: `stripeSecretKey` is needed. Nothing was saved.');
      for (const plan of params.plans ?? []) {
        if (typeof plan.price !== 'number' || !Number.isFinite(plan.price) || plan.price < 0) throw new BridgeError('invalid', `setupPayments: plan "${plan.key}" needs a price of 0 or more. Nothing was saved.`);
      }
      const connection = await run('POST', 'billing', '/connection', {
        body: { connector: 'stripe', secretKey: params.stripeSecretKey, ...(params.stripePublicKey === undefined ? {} : { publishableKey: params.stripePublicKey }) },
      });
      const created: Json[] = [];
      for (const plan of params.plans ?? []) {
        const currency = (plan.currency ?? 'usd').toLowerCase();
        const amount = ZERO_DECIMAL.has(currency) ? Math.round(plan.price) : Math.round(plan.price * 100);
        created.push(await plans.create({ key: plan.key, name: plan.name, prices: [{ currency, interval: plan.interval ?? 'month', amount }] }));
      }
      return { stripeConnected: true, plans: created, connection };
    },
    /**
     * Sets the sender of the email Bridge sends for the app. A new address is verified by email before it is used;
     * until then email keeps coming from Bridge's own sender.
     */
    async setupCommunication(params: { config: { fromAddress?: string; fromName?: string } }) {
      const { fromAddress, fromName } = params?.config ?? {};
      if (fromAddress === undefined && fromName === undefined) throw new BridgeError('invalid', 'setupCommunication: nothing to set: pass config.fromAddress, config.fromName, or both. Nothing was saved.');
      if (fromAddress !== undefined && !EMAIL.test(fromAddress)) throw new BridgeError('invalid', 'setupCommunication: config.fromAddress must be an email address, such as "no-reply@example.com". Nothing was saved.');
      if (fromName !== undefined && fromName.trim() === '') throw new BridgeError('invalid', 'setupCommunication: config.fromName must not be empty. Nothing was saved.');
      let current: Json = {};
      if (fromAddress === undefined || fromName === undefined) {
        try {
          current = (await run<Json | null>('GET', 'communication', '/sender')) ?? {};
        } catch (error) {
          if (!(error instanceof BridgeError && error.status === 404)) throw error;
        }
      }
      const address = fromAddress ?? asString(current['address']);
      const name = fromName ?? asString(current['name']);
      if (address === undefined) throw new BridgeError('invalid', 'setupCommunication: the app has no sender address yet: pass config.fromAddress. Nothing was saved.');
      const sender = await run<Json>('PUT', 'communication', '/sender', { body: { address, ...(name === undefined ? {} : { name }) } });
      return { configured: true, emailSenderEmail: asString(sender?.['address']) ?? address, emailSenderName: asString(sender?.['name']) ?? name ?? null, sender };
    },
  };

  return {
    /** Any call on Bridge's version 2 API with the app key, for a route this client has no method for yet. */
    request: <T = Json>(method: Method, area: ManagementArea, path: string, request?: ManagementRequest) => run<T>(method, area, path, request),
    app,
    branding,
    onboarding,
    workspaces,
    /** 0.8's name for `workspaces`. */
    tenants: workspaces,
    users,
    invites,
    roles,
    flags,
    plans,
    events,
    workflows,
  };
}

export type BridgeManagement = ReturnType<typeof createBridgeManagement>;
