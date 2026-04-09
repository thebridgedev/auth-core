import { httpFetch } from './http.js';
import type { Logger } from './logger.js';
import type { ResolvedConfig, TokenSet } from './types.js';

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export class FeatureFlagService {
  private cachedFlags: Record<string, boolean> = {};
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
      flags: Array<{ flag: string; evaluation?: { enabled: boolean } }>;
    }>(url, { method: 'POST', body }, this.logger);

    this.cachedFlags = data.flags.reduce(
      (acc: Record<string, boolean>, { flag, evaluation }) => {
        acc[flag] = evaluation?.enabled ?? false;
        return acc;
      },
      {},
    );
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

  private async evaluateSingle(flag: string): Promise<boolean> {
    const tokens = this.getTokens();
    const accessToken = tokens?.accessToken;
    const url = `${this.config.apiBaseUrl}/cloud-views/flags/evaluate/${this.config.appId}/${flag}`;
    const body = accessToken ? { accessToken } : {};

    try {
      const data = await httpFetch<{ enabled: boolean }>(url, { method: 'POST', body }, this.logger);
      this.cachedFlags[flag] = data.enabled ?? false;
      return data.enabled ?? false;
    } catch {
      return this.cachedFlags[flag] ?? false;
    }
  }
}
