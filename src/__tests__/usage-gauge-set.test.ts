import { describe, it, expect, vi } from 'vitest';
import { UsageReporter } from '../usage/usage-reporter.js';
import { InMemoryStorage } from '../usage/storage/index.js';
import { HttpError } from '../errors.js';

// ---------------------------------------------------------------------------
// TBP-699 — `bridge.usage.set(metric, value)`: a gauge's current absolute
// value, PUT straight to /usage/gauge/:metric (never queued, never summed).
// ---------------------------------------------------------------------------

function makeReporter(opts: {
  fetchFn?: ReturnType<typeof vi.fn>;
  getAccessToken?: () => string | null;
} = {}) {
  const fetchFn = opts.fetchFn ?? vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
  const storage = new InMemoryStorage();
  const reporter = new UsageReporter({
    apiBaseUrl: 'https://api.example.com/',
    getAccessToken: opts.getAccessToken ?? (() => 'access-tok'),
    fetchFn,
    storage,
  });
  return { reporter, fetchFn, storage };
}

describe('UsageReporter.set() (TBP-699)', () => {
  it('PUTs the absolute value to /usage/gauge/:metric with the bearer token and resolves once stored', async () => {
    const { reporter, fetchFn } = makeReporter();

    await expect(reporter.set('projects', 7)).resolves.toBeUndefined();

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://api.example.com/usage/gauge/projects');
    expect(init.method).toBe('PUT');
    expect(init.headers.Authorization).toBe('Bearer access-tok');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ value: 7 });
  });

  it('sends each value as given — two sets are two absolute values, not a sum', async () => {
    const { reporter, fetchFn } = makeReporter();
    await reporter.set('projects', 7);
    await reporter.set('projects', 3);
    expect(fetchFn.mock.calls.map(([, init]) => JSON.parse(init.body).value)).toEqual([7, 3]);
  });

  it('is not queued: nothing lands in the counter queue', async () => {
    const { reporter, storage } = makeReporter();
    await reporter.set('projects', 2);
    expect(await storage.size()).toBe(0);
  });

  it('url-encodes the metric name', async () => {
    const { reporter, fetchFn } = makeReporter();
    await reporter.set('storage/bytes', 1);
    expect(fetchFn.mock.calls[0][0]).toBe('https://api.example.com/usage/gauge/storage%2Fbytes');
  });

  it('rejects a negative or fractional value without calling the API', async () => {
    const { reporter, fetchFn } = makeReporter();
    await expect(reporter.set('projects', -1)).rejects.toThrow(RangeError);
    await expect(reporter.set('projects', 1.5)).rejects.toThrow(/integer >= 0/);
    await expect(reporter.set('', 1)).rejects.toThrow(TypeError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('rejects when nobody is signed in, without calling the API', async () => {
    const { reporter, fetchFn } = makeReporter({ getAccessToken: () => null });
    await expect(reporter.set('projects', 1)).rejects.toThrow(/signed-in user/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('rejects with an HttpError carrying the status and server message on a non-2xx answer', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ message: "'users' is maintained by Bridge from workspace membership and cannot be set." }),
    });
    const { reporter } = makeReporter({ fetchFn });
    const err = await reporter.set('users', 3).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(400);
    expect(err.message).toContain('maintained by Bridge');
  });
});
