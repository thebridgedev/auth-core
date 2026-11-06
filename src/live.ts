import type { Endpoints } from './core/discovery.js';
import { BridgeError, isBridgeError } from './core/errors.js';
import { call, type Fetch } from './core/http.js';
import { ROUTES } from './core/routes.js';
import { secureUrl } from './core/urls.js';
import { Emitter, Store, base64urlText, randomId, type Readable } from './core/util.js';
import type { Session } from './session.js';

/**
 * Live: notices that something changed, within about a second, so a screen
 * fetches it again. A notice never carries the data itself: only its type,
 * the record, its version, the time and the workspace. The screen reads the
 * record through the API, which checks who is asking.
 *
 * Bridge names the channels this person may join; the SDK never builds one.
 * Notices on a channel are numbered, so a gap is noticed and filled from
 * history. When the socket cannot be opened, the client polls history.
 */

export interface LiveNotice {
  /** What happened, such as `flags.revision_changed` or `accounts.member_updated`. */
  readonly type: string;
  /** The record that changed, `<kind>/<id>`; null for Live's own notices. */
  readonly record: string | null;
  readonly version: number | null;
  readonly time: string;
  /** The workspace the change belongs to; null for the whole app. */
  readonly workspace: string | null;
}

/** Many things changed on a channel, or some notices were missed: fetch again. */
export const MANY_CHANGED = 'bridge.live.many_changed';
/** The channel was renamed: Live asks the client to join again. */
const JOIN_AGAIN = 'bridge.live.join_again';

export type LiveStatus = 'off' | 'connecting' | 'open' | 'polling' | 'closed';

/** Where to connect, as the issuer's Live connection endpoint answers. */
export interface LiveConnection {
  readonly kind: 'appsync-events' | 'off';
  readonly endpoint?: string;
  readonly host?: string;
  readonly region?: string;
}

/** The parts of a WebSocket the client uses. */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

export type WebSocketFactory = (url: string, protocols: string[]) => WebSocketLike;

export interface LiveOptions {
  /** Turn Live off: no socket and no polling. @default true */
  readonly enabled?: boolean;
  /** How often to poll history when there is no socket. @default 15000 */
  readonly pollMs?: number;
  /** Makes the socket. @default the global WebSocket */
  readonly websocket?: WebSocketFactory | null;
}

interface Frame {
  readonly seq: number;
  readonly cursor: string;
  readonly notice: LiveNotice;
}

interface Channel {
  readonly kind: string;
  readonly name: string;
  cursor: string;
  seq: number | null;
}

type History = { readonly fetchAgain: false; readonly notices: readonly Frame[]; readonly cursor: string } | { readonly fetchAgain: true; readonly reason: string };

export interface LiveDeps {
  readonly endpoints: () => Endpoints;
  readonly fetch: Fetch;
  readonly session: Session;
  readonly onError: (error: unknown) => void;
}

const SOCKET_PROTOCOL = 'aws-appsync-event-ws';
/** What a socket sends instead of a token: the token goes only in each subscribe frame. */
const NO_TOKEN = 'anonymous';
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

function defaultWebSocket(): WebSocketFactory | null {
  const Socket = (globalThis as { WebSocket?: new (url: string, protocols: string[]) => WebSocketLike }).WebSocket;
  return Socket === undefined ? null : (url, protocols) => new Socket(url, protocols);
}

function frameOf(raw: unknown): Frame | null {
  const frame = (typeof raw === 'string' ? safeParse(raw) : raw) as Partial<Frame> | null;
  if (frame === null || typeof frame !== 'object' || typeof frame.seq !== 'number' || typeof frame.cursor !== 'string') return null;
  const notice = frame.notice as Partial<LiveNotice> | undefined;
  if (typeof notice?.type !== 'string') return null;
  return frame as Frame;
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export class Live {
  private readonly statusStore = new Store<LiveStatus>('off');
  private readonly notices = new Emitter<{ [name: string]: unknown; notice: LiveNotice }>();
  private readonly enabled: boolean;
  private readonly pollMs: number;
  private readonly websocket: WebSocketFactory | null;
  private channels: Channel[] = [];
  private socket: WebSocketLike | null = null;
  private subscriptions = new Map<string, Channel>();
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private keepAliveTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectMs = RECONNECT_MIN_MS;
  /** How long a silent socket is trusted; the server names it when the connection is accepted. */
  private keepAliveMs = 300_000;
  private run = 0;
  private running = false;

  constructor(private readonly deps: LiveDeps, options: LiveOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.pollMs = options.pollMs ?? 15_000;
    this.websocket = options.websocket === undefined ? defaultWebSocket() : options.websocket;
  }

  get status(): Readable<LiveStatus> {
    return this.statusStore;
  }

  /** Listens for notices of one type, or every notice with `'*'`. */
  on(type: string, listener: (notice: LiveNotice) => void): () => void {
    return this.notices.on('notice', (notice) => {
      if (type === '*' || notice.type === type) listener(notice);
    });
  }

  /** Connects, or connects again for the session as it is now. */
  async start(): Promise<void> {
    if (!this.enabled) return;
    this.running = true;
    this.disconnect();
    const run = ++this.run;
    this.statusStore.set('connecting');
    try {
      this.channels = await this.fetchChannels();
      if (run !== this.run) return;
      if (this.channels.length === 0) {
        this.statusStore.set('off');
        return;
      }
      const connection = await this.connection();
      if (run !== this.run) return;
      const endpoint = connection?.kind === 'appsync-events' ? secureUrl(connection.endpoint, 'wss:') : null;
      if (connection?.kind === 'appsync-events' && endpoint === null) {
        // The access token goes into every subscribe frame: never over a socket that is not wss.
        this.deps.onError(new BridgeError('misconfigured', `Live's address must be wss (ws only on localhost); got "${String(connection.endpoint)}". Polling instead.`));
      }
      if (endpoint !== null && typeof connection?.host === 'string' && this.websocket !== null) {
        this.open(run, endpoint, connection.host);
      } else {
        this.poll(run);
      }
    } catch (error) {
      if (run !== this.run) return;
      if (!isBridgeError(error, 'signed-out')) this.deps.onError(error);
      this.scheduleReconnect(run);
    }
  }

  stop(): void {
    this.running = false;
    this.run += 1;
    this.disconnect();
    this.statusStore.set('closed');
  }

  private disconnect(): void {
    for (const timer of [this.pollTimer, this.reconnectTimer, this.keepAliveTimer]) if (timer !== null) clearTimeout(timer);
    this.pollTimer = this.reconnectTimer = this.keepAliveTimer = null;
    const socket = this.socket;
    this.socket = null;
    this.subscriptions.clear();
    if (socket !== null) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      try {
        socket.close(1000, 'done');
      } catch {
        // Already closed.
      }
    }
  }

  private signedIn(): boolean {
    return this.deps.session.state.get().status === 'signed-in';
  }

  private async fetchChannels(): Promise<Channel[]> {
    const endpoints = this.deps.endpoints();
    const signedIn = this.signedIn();
    const route = signedIn ? ROUTES.liveChannels : ROUTES.liveVisitorChannels;
    if (!endpoints.offers(route)) return [];
    const token = signedIn ? await this.deps.session.accessToken() : null;
    const answer = await call<{ channels?: unknown }>(this.deps.fetch, endpoints.url(route), { method: 'GET', token });
    const listed = Array.isArray(answer.body?.channels) ? (answer.body.channels as unknown[]) : [];
    return listed.flatMap((each) => {
      const channel = each as Partial<Channel> | null;
      return typeof channel?.name === 'string' && typeof channel.cursor === 'string' ? [{ kind: String(channel.kind ?? ''), name: channel.name, cursor: channel.cursor, seq: null }] : [];
    });
  }

  private async connection(): Promise<LiveConnection | null> {
    const endpoints = this.deps.endpoints();
    if (!endpoints.offers(ROUTES.liveConnection)) return null;
    return (await call<LiveConnection>(this.deps.fetch, endpoints.url(ROUTES.liveConnection), { method: 'GET' })).body ?? null;
  }

  private open(run: number, endpoint: string, host: string): void {
    const url = /\/event\/realtime\/?$/.test(endpoint) ? endpoint : `${endpoint.replace(/\/+$/, '')}/event/realtime`;
    const header = `header-${base64urlText(JSON.stringify({ host, Authorization: NO_TOKEN }))}`;
    let socket: WebSocketLike;
    try {
      socket = (this.websocket as WebSocketFactory)(url, [SOCKET_PROTOCOL, header]);
    } catch (error) {
      this.deps.onError(error);
      this.poll(run);
      return;
    }
    this.socket = socket;
    socket.onopen = () => socket.send(JSON.stringify({ type: 'connection_init' }));
    socket.onerror = () => undefined;
    socket.onclose = () => {
      if (this.socket !== socket || run !== this.run) return;
      this.socket = null;
      this.scheduleReconnect(run);
    };
    socket.onmessage = (event) => void this.fromSocket(run, socket, host, event.data);
  }

  private async fromSocket(run: number, socket: WebSocketLike, host: string, data: unknown): Promise<void> {
    if (this.socket !== socket || run !== this.run) return;
    const message = (typeof data === 'string' ? safeParse(data) : data) as { type?: unknown; id?: unknown; event?: unknown; connectionTimeoutMs?: unknown } | null;
    if (message === null || typeof message !== 'object') return;
    switch (message.type) {
      case 'connection_ack': {
        this.keepAlive(run, typeof message.connectionTimeoutMs === 'number' ? message.connectionTimeoutMs : 300_000);
        const token = this.signedIn() ? await this.deps.session.accessToken().catch(() => null) : null;
        for (const channel of this.channels) {
          const id = randomId();
          this.subscriptions.set(id, channel);
          socket.send(JSON.stringify({ type: 'subscribe', id, channel: channel.name, authorization: { host, Authorization: token === null ? NO_TOKEN : `Bearer ${token}` } }));
        }
        return;
      }
      case 'subscribe_success': {
        const channel = typeof message.id === 'string' ? this.subscriptions.get(message.id) : undefined;
        if (channel === undefined) return;
        this.reconnectMs = RECONNECT_MIN_MS;
        this.statusStore.set('open');
        // Anything sent between listing the channel and joining it.
        await this.catchUp(run, channel);
        return;
      }
      case 'subscribe_error': {
        const channel = typeof message.id === 'string' ? this.subscriptions.get(message.id) : undefined;
        if (channel !== undefined) this.subscriptions.delete(message.id as string);
        // Refused or not decided right now: poll history instead, and try the socket again later.
        if (this.subscriptions.size === 0) {
          this.disconnect();
          this.poll(run);
        }
        return;
      }
      case 'ka':
        this.keepAlive(run, null);
        return;
      case 'data': {
        const channel = typeof message.id === 'string' ? this.subscriptions.get(message.id) : undefined;
        if (channel === undefined) return;
        const events = Array.isArray(message.event) ? (message.event as unknown[]) : [message.event];
        for (const raw of events) {
          const frame = frameOf(raw);
          if (frame !== null) await this.take(run, channel, frame);
        }
        return;
      }
      case 'connection_error':
      case 'error':
        this.disconnect();
        this.scheduleReconnect(run);
        return;
      default:
        return;
    }
  }

  /** One numbered notice: delivered once, in order; a gap is filled from history first. */
  private async take(run: number, channel: Channel, frame: Frame): Promise<void> {
    if (channel.seq !== null && frame.seq <= channel.seq) return;
    if (channel.seq !== null && frame.seq > channel.seq + 1) {
      await this.catchUp(run, channel);
      if (channel.seq !== null && frame.seq <= channel.seq) return;
    }
    channel.seq = frame.seq;
    channel.cursor = frame.cursor;
    if (frame.notice.type === JOIN_AGAIN) {
      void this.start();
      return;
    }
    this.notices.emit('notice', frame.notice);
  }

  private async catchUp(run: number, channel: Channel): Promise<void> {
    const endpoints = this.deps.endpoints();
    const signedIn = this.signedIn();
    const route = signedIn ? ROUTES.liveHistory : ROUTES.liveVisitorHistory;
    try {
      const token = signedIn ? await this.deps.session.accessToken() : null;
      const answer = await call<History>(this.deps.fetch, endpoints.url(route, {}, { cursor: channel.cursor }), { method: 'GET', token });
      if (run !== this.run) return;
      const history = answer.body;
      if (history.fetchAgain) {
        // Notices were lost, or the channel was renamed: tell screens to fetch again, and join afresh.
        this.notices.emit('notice', { type: MANY_CHANGED, record: null, version: null, time: new Date().toISOString(), workspace: null });
        void this.start();
        return;
      }
      for (const frame of history.notices) {
        if (channel.seq !== null && frame.seq <= channel.seq) continue;
        channel.seq = frame.seq;
        channel.cursor = frame.cursor;
        if (frame.notice.type === JOIN_AGAIN) {
          void this.start();
          return;
        }
        this.notices.emit('notice', frame.notice);
      }
      channel.cursor = history.cursor;
    } catch (error) {
      if (!isBridgeError(error, 'signed-out')) this.deps.onError(error);
    }
  }

  private poll(run: number): void {
    this.statusStore.set('polling');
    const tick = async () => {
      if (run !== this.run) return;
      for (const channel of this.channels) await this.catchUp(run, channel);
      if (run === this.run) this.pollTimer = setTimeout(() => void tick(), this.pollMs);
    };
    void tick();
  }

  private keepAlive(run: number, timeoutMs: number | null): void {
    if (this.keepAliveTimer !== null) clearTimeout(this.keepAliveTimer);
    if (timeoutMs !== null) this.keepAliveMs = timeoutMs;
    const wait = this.keepAliveMs;
    this.keepAliveTimer = setTimeout(() => {
      if (run !== this.run) return;
      this.disconnect();
      this.scheduleReconnect(run);
    }, wait);
  }

  private scheduleReconnect(run: number): void {
    if (!this.running || run !== this.run) return;
    this.statusStore.set('connecting');
    const wait = this.reconnectMs;
    this.reconnectMs = Math.min(RECONNECT_MAX_MS, this.reconnectMs * 2);
    this.reconnectTimer = setTimeout(() => {
      if (run === this.run) void this.start();
    }, wait);
  }
}
