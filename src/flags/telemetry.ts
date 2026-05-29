// SDK telemetry batcher (TBP-157).
//
// Wires the BridgeFlags hooks (`onEval`, `onDiscover`, `onIdentify`) to the
// bridge-api ingest endpoints (`/v1/flags/eval-events`, `/v1/flags/discover`,
// `/v1/flags/call-sites`). Coalesces eval events per (identity, flag, value)
// per minute, dedupes call-site reports per (identity, fingerprint) for the
// SDK runtime, and periodically flushes via HTTP.
//
// This module is platform-agnostic — it uses global `fetch` and a `setInterval`
// timer. Framework SDKs construct it during bootstrap and pass the workspace
// API key. On graceful shutdown they call `stop()` to flush pending events.

import type {
  AttributeDeclaration,
  AttributeObservation,
  BridgeFlags,
  DiscoveryTelemetry,
  EvalTelemetry,
} from './flag.js';

export interface TelemetryBatcherConfig {
  /** Bridge API base URL (e.g. https://api.thebridge.dev or http://localhost:3500). */
  apiBaseUrl: string;
  /** JWT-shaped workspace API key — sent as `x-api-key` header. */
  apiKey: string;
  /** Flush interval in ms. Default 30s. */
  flushIntervalMs?: number;
  /** Maximum events buffered before forcing a flush. Default 500. */
  flushAtSize?: number;
  /**
   * Short debounce after any discovery / attribute-observation event, so
   * first-sight items reach the admin near-instantly without waiting for the
   * 30s eval cadence. Default 1000ms. Set higher to coalesce more aggressively
   * or to 0 to flush synchronously.
   */
  firstSightFlushMs?: number;
  /** When false, telemetry HTTP calls are skipped — useful for tests + opt-out apps. */
  enabled?: boolean;
}

interface EvalKey {
  flag: string;
  valueKey: string;
  variantIndex: number;
  identity?: string;
  bucketMinute: number;
}

interface CoalescedEval {
  flag: string;
  value: unknown;
  variantIndex: number;
  identity?: string;
  timestamp: number;
  count: number;
}

interface CoalescedDiscovery {
  flag: string;
  defaultValue: unknown;
  observedType: string;
  timestamp: number;
}

interface CoalescedAttributeDeclaration {
  name: string;
  type: string;
  timestamp: number;
}

interface CoalescedAttributeObservation {
  key: string;
  sampleValue: unknown;
  observedType: string;
  timestamp: number;
}

export class TelemetryBatcher {
  private readonly evalBuffer = new Map<string, CoalescedEval>();
  private readonly discoveryBuffer: CoalescedDiscovery[] = [];
  private readonly attributeDeclBuffer: CoalescedAttributeDeclaration[] = [];
  private readonly attributeObsBuffer: CoalescedAttributeObservation[] = [];
  private readonly callSiteBuffer: Array<{
    flag: string;
    identity: string;
    fingerprint: string;
    devLabel?: string;
    timestamp: number;
  }> = [];
  private readonly seenCallSites = new Set<string>(); // dedup per runtime: `identity|fingerprint`
  private timer?: ReturnType<typeof setInterval>;
  private firstSightTimer?: ReturnType<typeof setTimeout>;
  private readonly cfg: Required<TelemetryBatcherConfig>;
  private flushing = false;

  constructor(cfg: TelemetryBatcherConfig) {
    this.cfg = {
      apiBaseUrl: cfg.apiBaseUrl.replace(/\/+$/, ''),
      apiKey: cfg.apiKey,
      flushIntervalMs: cfg.flushIntervalMs ?? 30_000,
      flushAtSize: cfg.flushAtSize ?? 500,
      firstSightFlushMs: cfg.firstSightFlushMs ?? 1_000,
      enabled: cfg.enabled !== false,
    };
  }

  /** Schedule a near-instant flush in response to a first-sight event. Debounced
   *  so a burst of first-sights collapses to a single flush. Discovery + attribute
   *  observation paths both use this; eval events keep the 30s cadence. */
  private scheduleFirstSightFlush(): void {
    if (this.firstSightTimer) return;
    this.firstSightTimer = setTimeout(() => {
      this.firstSightTimer = undefined;
      void this.flush();
    }, this.cfg.firstSightFlushMs);
    if ((this.firstSightTimer as any)?.unref) (this.firstSightTimer as any).unref();
  }

  /**
   * Attach to a BridgeFlags instance. Registers hooks for eval + discovery
   * + attribute-declaration events. Also starts the periodic flush timer.
   */
  attach(bridge: BridgeFlags): void {
    bridge.setHooks({
      onEval: (ev) => this.recordEval(ev),
      onDiscover: (ev) => this.recordDiscovery(ev),
      onAttributeDeclaration: (decl) => this.recordAttributeDeclaration(decl),
      onAttributeObserved: (obs) => this.recordAttributeObservation(obs),
    });
    this.start();
  }

  /** Record a call-site sighting. Caller supplies the fingerprint. */
  recordCallSite(flag: string, identity: string, fingerprint: string, devLabel?: string): void {
    if (!identity || !fingerprint) return;
    const key = `${identity}|${fingerprint}`;
    if (this.seenCallSites.has(key)) return;
    this.seenCallSites.add(key);
    this.callSiteBuffer.push({ flag, identity, fingerprint, devLabel, timestamp: Date.now() });
    this.maybeFlushOnSize();
  }

  /** Hook entrypoint — coalesces eval events per (identity, flag, value, minute). */
  private recordEval(ev: EvalTelemetry): void {
    const valueKey = canonicalValueKey(ev.value);
    const bucketMinute = Math.floor(ev.timestamp / 60_000);
    const key = `${ev.identity ?? ''}::${ev.flag}::${valueKey}::${ev.variantIndex}::${bucketMinute}`;
    const existing = this.evalBuffer.get(key);
    if (existing) {
      existing.count++;
    } else {
      this.evalBuffer.set(key, {
        flag: ev.flag,
        value: ev.value,
        variantIndex: ev.variantIndex,
        identity: ev.identity,
        timestamp: ev.timestamp,
        count: 1,
      });
    }
    this.maybeFlushOnSize();
  }

  /** Hook entrypoint — discovery events are inherently dedupe'd by BridgeFlags.
   *  Schedules a near-instant flush so a new flag shows up in the admin within
   *  ~1s of first eval, not at the next 30s tick. */
  private recordDiscovery(ev: DiscoveryTelemetry): void {
    this.discoveryBuffer.push({
      flag: ev.flag,
      defaultValue: ev.defaultValue,
      observedType: ev.observedType,
      timestamp: ev.timestamp,
    });
    this.scheduleFirstSightFlush();
    this.maybeFlushOnSize();
  }

  /** Hook entrypoint — attribute type declarations (TBP-174, deprecated). */
  private recordAttributeDeclaration(decl: AttributeDeclaration): void {
    this.attributeDeclBuffer.push({
      name: decl.name,
      type: decl.type,
      timestamp: decl.timestamp,
    });
    this.scheduleFirstSightFlush();
    this.maybeFlushOnSize();
  }

  /** Hook entrypoint — per-call attribute observations (TBP-178). Same near-
   *  instant flush so a new dev-supplied attribute reaches the admin catalog
   *  within ~1s of first eval. */
  private recordAttributeObservation(obs: AttributeObservation): void {
    this.attributeObsBuffer.push({
      key: obs.key,
      sampleValue: obs.sampleValue,
      observedType: obs.observedType,
      timestamp: obs.timestamp,
    });
    this.scheduleFirstSightFlush();
    this.maybeFlushOnSize();
  }

  /** Begin periodic flushing. Idempotent. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flush();
    }, this.cfg.flushIntervalMs);
    // Some runtimes (Node) keep the process alive on a timer; in the SDK
    // context this is typically a browser, so it's a no-op there.
    if ((this.timer as any)?.unref) (this.timer as any).unref();
  }

  /** Stop the timer and force a final flush. Called on app shutdown / SDK teardown. */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.firstSightTimer) {
      clearTimeout(this.firstSightTimer);
      this.firstSightTimer = undefined;
    }
    await this.flush();
  }

  /** Force a flush now. Returns when all in-flight HTTP calls settle. */
  async flush(): Promise<void> {
    if (!this.cfg.enabled) {
      this.evalBuffer.clear();
      this.discoveryBuffer.length = 0;
      this.attributeDeclBuffer.length = 0;
      this.attributeObsBuffer.length = 0;
      this.callSiteBuffer.length = 0;
      return;
    }
    if (this.flushing) return; // single-flight; the next interval picks up the rest
    this.flushing = true;
    try {
      await Promise.all([
        this.flushEvals(),
        this.flushDiscoveries(),
        this.flushAttributeDeclarations(),
        this.flushAttributeObservations(),
        this.flushCallSites(),
      ]);
    } finally {
      this.flushing = false;
    }
  }

  /** Telemetry surface for introspection / tests. */
  stats(): {
    evalQueue: number;
    discoveryQueue: number;
    attributeDeclQueue: number;
    attributeObsQueue: number;
    callSiteQueue: number;
    seenCallSites: number;
  } {
    return {
      evalQueue: this.evalBuffer.size,
      discoveryQueue: this.discoveryBuffer.length,
      attributeDeclQueue: this.attributeDeclBuffer.length,
      attributeObsQueue: this.attributeObsBuffer.length,
      callSiteQueue: this.callSiteBuffer.length,
      seenCallSites: this.seenCallSites.size,
    };
  }

  private maybeFlushOnSize(): void {
    const total =
      this.evalBuffer.size +
      this.discoveryBuffer.length +
      this.attributeDeclBuffer.length +
      this.attributeObsBuffer.length +
      this.callSiteBuffer.length;
    if (total >= this.cfg.flushAtSize) {
      void this.flush();
    }
  }

  private async flushEvals(): Promise<void> {
    if (this.evalBuffer.size === 0) return;
    const events = Array.from(this.evalBuffer.values());
    this.evalBuffer.clear();
    await this.post('/v1/flags/eval-events', { events });
  }

  private async flushDiscoveries(): Promise<void> {
    if (this.discoveryBuffer.length === 0) return;
    const events = this.discoveryBuffer.splice(0).map((d) => ({
      kind: 'flag' as const,
      key: d.flag,
      observedType: d.observedType,
      timestamp: d.timestamp,
    }));
    await this.post('/v1/flags/discover', { events });
  }

  private async flushAttributeDeclarations(): Promise<void> {
    if (this.attributeDeclBuffer.length === 0) return;
    // Attribute declarations are sent through the discovery endpoint with
    // `kind: 'attribute'` + observedType. The admin UI's Discovered panel
    // distinguishes declared vs inferred via the observedType + a future
    // `declared: true` field (TODO once the backend supports the flag).
    const events = this.attributeDeclBuffer.splice(0).map((d) => ({
      kind: 'attribute' as const,
      key: d.name,
      observedType: d.type,
      timestamp: d.timestamp,
    }));
    await this.post('/v1/flags/discover', { events });
  }

  private async flushAttributeObservations(): Promise<void> {
    if (this.attributeObsBuffer.length === 0) return;
    // Per-call attribute observations (TBP-178) — relayed to the same discovery
    // endpoint with `kind: 'attribute'` + observedType + sampleValue. Backend
    // accumulates distinct samples per (app, key) via `$addToSet`.
    const events = this.attributeObsBuffer.splice(0).map((o) => ({
      kind: 'attribute' as const,
      key: o.key,
      sampleValue: o.sampleValue,
      observedType: o.observedType,
      timestamp: o.timestamp,
    }));
    await this.post('/v1/flags/discover', { events });
  }

  private async flushCallSites(): Promise<void> {
    if (this.callSiteBuffer.length === 0) return;
    const events = this.callSiteBuffer.splice(0);
    await this.post('/v1/flags/call-sites', { events });
  }

  private async post(path: string, body: unknown): Promise<void> {
    const url = `${this.cfg.apiBaseUrl}${path}`;
    try {
      await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.cfg.apiKey,
        },
        body: JSON.stringify(body),
      });
      // We don't currently inspect the response — accepted/rejected counts
      // are useful for debugging but not actionable from the SDK side.
      // A future hardening could log on non-2xx.
    } catch {
      // Network errors swallowed — telemetry is best-effort. A future
      // hardening could re-buffer with backoff, but losing some events is
      // strictly preferred over breaking the SDK on a flaky network.
    }
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function canonicalValueKey(v: unknown): string {
  if (v === undefined) return 'undefined';
  try {
    const s = JSON.stringify(v);
    return s.length > 256 ? s.slice(0, 256) + '…' : s;
  } catch {
    return String(v);
  }
}
