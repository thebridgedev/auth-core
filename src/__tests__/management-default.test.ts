import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BridgeManagement } from '../management/index.js';

// TBP-110 — assert default base URL when constructor is called without baseUrl.
// When `BridgeManagement` is constructed with `{ apiKey: 'x' }` and no `baseUrl`,
// the resolved base URL must be 'https://api.thebridge.dev' (NOT the legacy
// 'https://account-api.thebridge.dev'). We verify by inspecting the URL passed
// to global fetch when an underlying service makes an HTTP call.
describe('BridgeManagement default base URL', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('uses https://api.thebridge.dev when baseUrl is not provided', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'app-1' }), { status: 200 }),
    );

    const mgmt = new BridgeManagement({ apiKey: 'x' });

    // Trigger any GET — app.get() is the simplest entry point on the facade.
    await mgmt.app.get();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const calledUrl = fetchSpy.mock.calls[0][0];
    expect(typeof calledUrl).toBe('string');
    expect(calledUrl as string).toMatch(/^https:\/\/api\.thebridge\.dev\//);
    // Explicitly assert it's NOT the legacy host.
    expect(calledUrl as string).not.toContain('account-api.thebridge.dev');
  });

  it('honours an explicit baseUrl override', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'app-1' }), { status: 200 }),
    );

    const mgmt = new BridgeManagement({
      apiKey: 'x',
      baseUrl: 'http://127.0.0.1:3200',
    });

    await mgmt.app.get();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const calledUrl = fetchSpy.mock.calls[0][0];
    expect(calledUrl as string).toMatch(/^http:\/\/127\.0\.0\.1:3200\//);
  });
});
