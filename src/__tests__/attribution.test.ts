import { describe, it, expect } from 'vitest';
import { ATTRIBUTION_PARAMS, carryAttribution, readAttributionParams } from '../attribution.js';

// TBP-894 — the one list of attribution params and the helper that carries them.
describe('attribution', () => {
  it('reads only the allowlisted params, never the OAuth code', () => {
    expect(
      readAttributionParams('?utm_source=tiktok&ref=CODE8&code=oauth&redirect_uri=x&landing_path=%2Fpricing&capture=utm'),
    ).toEqual({ utm_source: 'tiktok', ref: 'CODE8', landing_path: '/pricing', capture: 'utm' });
  });

  it('drops oversized values', () => {
    expect(readAttributionParams(`?ref=CODE8&utm_campaign=${'x'.repeat(513)}`)).toEqual({ ref: 'CODE8' });
  });

  it('carries the tags onto an absolute URL, keeping its own params', () => {
    const out = carryAttribution('https://api.example.com/auth/federation/app1?provider=google&ref=KEEP', '?ref=CODE8&utm_source=tiktok');
    const url = new URL(out);
    expect(url.searchParams.get('provider')).toBe('google');
    expect(url.searchParams.get('ref')).toBe('KEEP');
    expect(url.searchParams.get('utm_source')).toBe('tiktok');
  });

  it('keeps a relative path relative', () => {
    expect(carryAttribution('/auth/signup', '?utm_medium=organic-social')).toBe('/auth/signup?utm_medium=organic-social');
  });

  it('returns the URL untouched when there is nothing to carry', () => {
    expect(carryAttribution('https://a.test/x?y=1', '?code=abc')).toBe('https://a.test/x?y=1');
  });

  it('lists ref but never code', () => {
    expect(ATTRIBUTION_PARAMS).toContain('ref');
    expect(ATTRIBUTION_PARAMS as readonly string[]).not.toContain('code');
  });
});
