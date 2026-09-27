import { describe, it, expect, vi } from 'vitest';
import * as barrel from '../index.js';
import { InMemoryStorage } from '../usage/storage/index.js';

// ---------------------------------------------------------------------------
// TBP-697 — `UsageReporter` is importable by name from the package root, and
// the class it hands back is the real one: it reports and sets over HTTP.
// ---------------------------------------------------------------------------

describe('UsageReporter barrel export (TBP-697)', () => {
  it('is a constructor on the package root whose instances set a gauge over HTTP', async () => {
    const { UsageReporter } = barrel;
    expect(typeof UsageReporter).toBe('function');

    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    const reporter = new UsageReporter({
      apiBaseUrl: 'https://api.example.com',
      getAccessToken: () => 'tok',
      fetchFn,
      storage: new InMemoryStorage(),
    });

    await reporter.set('projects', 3);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://api.example.com/usage/gauge/projects');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ value: 3 });
  });
});
