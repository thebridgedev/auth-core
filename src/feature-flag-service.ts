import { httpFetch } from './http.js';
import type { Logger } from './logger.js';
import type { ResolvedConfig, TokenSet } from './types.js';
import type { FlagOffReason } from './flags/evaluator.js';

/**
 * TBP-756 — why a flag is off, as the server's evaluate endpoint reports it.
 * `feature` is the plan feature a plan reason points at, when there is one.
 */
export interface FlagOffExplanation {
  reason: FlagOffReason;
  feature?: string;
}

const OFF_REASONS: ReadonlySet<string> = new Set(['plan', 'permission', 'off', 'rule', 'rollout']);

/** The explanation in an evaluation, or undefined when the server sent none. */
function readExplanation(evaluation: unknown): FlagOffExplanation | undefined {
  if (!evaluation || typeof evaluation !== 'object') return undefined;
  const e = evaluation as { reason?: unknown; feature?: unknown };
  if (typeof e.reason !== 'string' || !OFF_REASONS.has(e.reason)) return undefined;
  return {
    reason: e.reason as FlagOffReason,
    ...(typeof e.feature === 'string' && e.feature ? { feature: e.feature } : {}),
  };
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export class FeatureFlagService {
  private cachedFlags: Record<string, boolean> = {};
  private cachedReasons: Record<string, FlagOffExplanation> = {};
  private lastFetchTime = 0;

  constructor(
    private readonly config: ResolvedConfig,
    private readonly getTokens: () => TokenSet | null,
    private readonly logger: Logger,
  ) {}

  async loadAll(): Promise<Record<string, boolean>> {
    const tokens = this.getTokens();
    const accessToken = tokens?.accessToken;
    const url = `${this.config.apiBaseUrl}/cloud-views/flags/bulkEvaluate/${this.config.appId}`;
    const body = accessToken ? { accessToken } : {};

    const data = await httpFetch<{
      flags: Array<{ flag: string; evaluation?: { enabled: boolean; reason?: string; feature?: string } }>;
    }>(url, { method: 'POST', body }, this.logger);

    const reasons: Record<string, FlagOffExplanation> = {};
    this.cachedFlags = data.flags.reduce(
      (acc: Record<string, boolean>, { flag, evaluation }) => {
        acc[flag] = evaluation?.enabled ?? false;
        const explanation = acc[flag] ? undefined : readExplanation(evaluation);
        if (explanation) reasons[flag] = explanation;
        return acc;
      },
      {},
    );
    this.cachedReasons = reasons;
    this.lastFetchTime = Date.now();
    return { ...this.cachedFlags };
  }

  async isEnabled(flag: string, forceLive = false): Promise<boolean> {
    // Return from cache if valid
    if (!forceLive && Date.now() - this.lastFetchTime < CACHE_TTL_MS) {
      return this.cachedFlags[flag] ?? false;
    }

    if (forceLive) {
      return this.evaluateSingle(flag);
    }

    await this.loadAll();
    return this.cachedFlags[flag] ?? false;
  }

  getCached(): Record<string, boolean> {
    return { ...this.cachedFlags };
  }

  /**
   * TBP-756 — why `flag` was off at its last evaluation, or undefined when it
   * was on, is unknown, or the server did not say (an older bridge-api).
   * Read it after `isEnabled(flag)` returned false.
   */
  getReason(flag: string): FlagOffExplanation | undefined {
    const e = this.cachedReasons[flag];
    return e ? { ...e } : undefined;
  }

  /**
   * Drop the cache so the next `isEnabled` re-evaluates against the server
   * (TBP-575).
   *
   * This cache is what ROUTE GUARDS read, and it is a different cache from
   * the FF 2.0 `BridgeFlags` store that `<FeatureFlag>` reads. Realtime flag
   * pushes only ever updated the latter, so a flag flip took up to
   * CACHE_TTL_MS to affect a route — not because the TTL was wrong, but
   * because nothing ever told this cache the world had changed. The framework
   * SDK now calls this from the realtime client's `onFlagChange` hook.
   *
   * Deliberately does NOT refetch: guards evaluate on navigation, so the
   * refetch happens exactly when it is needed rather than on every push.
   */
  invalidate(): void {
    this.lastFetchTime = 0;
  }

  private async evaluateSingle(flag: string): Promise<boolean> {
    const tokens = this.getTokens();
    const accessToken = tokens?.accessToken;
    const url = `${this.config.apiBaseUrl}/cloud-views/flags/evaluate/${this.config.appId}/${flag}`;
    const body = accessToken ? { accessToken } : {};

    try {
      const data = await httpFetch<{ enabled: boolean; reason?: string; feature?: string }>(
        url,
        { method: 'POST', body },
        this.logger,
      );
      this.cachedFlags[flag] = data.enabled ?? false;
      const explanation = this.cachedFlags[flag] ? undefined : readExplanation(data);
      if (explanation) this.cachedReasons[flag] = explanation;
      else delete this.cachedReasons[flag];
      return data.enabled ?? false;
    } catch {
      return this.cachedFlags[flag] ?? false;
    }
  }
}
