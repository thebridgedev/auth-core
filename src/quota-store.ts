import type { Endpoints } from './core/discovery.js';
import { isBridgeError } from './core/errors.js';
import { call, type Fetch } from './core/http.js';
import { ROUTES } from './core/routes.js';
import { snapshotOf, type QuotaRead, type QuotaSnapshot } from './quota.js';
import type { Session } from './session.js';

export interface QuotaStoreDeps {
  readonly endpoints: () => Endpoints;
  readonly fetch: Fetch;
  readonly session: Session;
  readonly onError: (error: unknown) => void;
}

export type QuotaListener = (metric: string, snapshot: QuotaSnapshot | undefined) => void;

/**
 * The quotas a page shows, one snapshot per metric, for the signed-in
 * person's workspace. Framework plugins subscribe to it to redraw.
 *
 * A metric is read the first time a screen asks for it (`ensureHydrated`),
 * and every metric a screen has asked for is read again when Bridge says
 * something changed (`refresh`): Live's notices carry no numbers, so the
 * numbers are always read, never taken from a notice. A metric the plan sets
 * no limit on has no snapshot.
 */
export class QuotaStore {
  private readonly snapshots = new Map<string, QuotaSnapshot>();
  /** Every metric a screen asked for, kept so a change reads them all again. */
  private readonly wanted = new Set<string>();
  private readonly listeners = new Set<QuotaListener>();
  private readonly started = new Map<string, number>();
  private readonly hydrating = new Set<string>();
  private counter = 0;
  private context: string | null = null;
  private running: Promise<void> | null = null;
  private again = false;

  constructor(private readonly deps: QuotaStoreDeps) {}

  /** Who the numbers are for, or null while nobody is signed in. */
  private contextNow(): string | null {
    const state = this.deps.session.state.get();
    if (state.status !== 'signed-in') return null;
    return `${state.user.id}:${state.workspace?.id ?? ''}:${this.deps.session.sessionId() ?? ''}`;
  }

  /** The snapshot held for a metric, or undefined while it is read, or when the plan sets no limit on it. */
  get(metric: string): QuotaSnapshot | undefined {
    return this.snapshots.get(metric);
  }

  /** Every snapshot held. */
  getAll(): Map<string, QuotaSnapshot> {
    return new Map(this.snapshots);
  }

  /** Called with a metric and its snapshot whenever one changes (undefined: no limit on it). Returns how to stop. */
  subscribe(listener: QuotaListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * The snapshot held for a metric. The first call for a metric starts
   * reading it and returns undefined; subscribers hear when it arrives.
   * Never waits: safe to call while drawing a screen.
   */
  ensureHydrated(metric: string): QuotaSnapshot | undefined {
    this.wanted.add(metric);
    const held = this.snapshots.get(metric);
    if (held !== undefined || this.hydrating.has(metric) || this.contextNow() === null) return held;
    this.hydrating.add(metric);
    void this.read(metric);
    return undefined;
  }

  /**
   * Reads a metric's quota now, keeps it and tells subscribers. Resolves to
   * the snapshot, or undefined when the plan sets no limit on the metric or
   * nobody is signed in. A failed read keeps what is held and is reported to
   * the client's `error` event.
   */
  async read(metric: string): Promise<QuotaSnapshot | undefined> {
    this.wanted.add(metric);
    const mine = ++this.counter;
    this.started.set(metric, mine);
    try {
      return await this.fetchOnce(metric, mine, false);
    } finally {
      this.hydrating.delete(metric);
    }
  }

  /**
   * Reads every metric a screen asked for again. Calls made while a refresh
   * runs share it, and run it once more after it, so the last change is
   * never missed.
   */
  refresh(): Promise<void> {
    if (this.running !== null) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        await Promise.all([...this.wanted].map((metric) => this.read(metric)));
      } while (this.again);
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** Drops what is held, for another person or workspace; the metrics asked for are read again once someone is signed in. */
  reset(): void {
    const dropped = [...this.snapshots.keys()];
    this.snapshots.clear();
    this.hydrating.clear();
    // Reads under way are for the old person or workspace: they must not land.
    this.counter += 1;
    this.started.clear();
    this.context = null;
    for (const metric of dropped) this.notify(metric, undefined);
    if (this.contextNow() !== null) void this.refresh();
  }

  private async fetchOnce(metric: string, mine: number, renewed: boolean): Promise<QuotaSnapshot | undefined> {
    const context = this.contextNow();
    if (context === null) return undefined;
    let endpoints: Endpoints;
    try {
      endpoints = this.deps.endpoints();
    } catch {
      // Not started yet: the metric is read once the client is ready.
      return undefined;
    }
    if (context !== this.context) {
      this.snapshots.clear();
      this.context = context;
    }
    try {
      const token = await this.deps.session.accessToken();
      const answer = await call<QuotaRead | null | undefined>(this.deps.fetch, endpoints.url(ROUTES.usageQuota, { metric }), { method: 'GET', token });
      // An answer for another person or workspace, or older than a read started since, is dropped.
      if (context !== this.contextNow() || this.started.get(metric) !== mine) return this.snapshots.get(metric);
      const snapshot = snapshotOf(metric, answer.body);
      if (snapshot === undefined) this.snapshots.delete(metric);
      else this.snapshots.set(metric, snapshot);
      this.notify(metric, snapshot);
      return snapshot;
    } catch (error) {
      if (isBridgeError(error, 'signed-out') && !renewed && this.deps.session.state.get().status === 'signed-in') {
        // A token from before a change of plan is refused once Bridge has saved the change: renew it once and ask again.
        try {
          await this.deps.session.refresh({ force: true });
        } catch {
          return this.snapshots.get(metric);
        }
        return this.fetchOnce(metric, mine, true);
      }
      this.deps.onError(error);
      return this.snapshots.get(metric);
    }
  }

  private notify(metric: string, snapshot: QuotaSnapshot | undefined): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(metric, snapshot);
      } catch {
        // A listener's own error is its own.
      }
    }
  }
}
