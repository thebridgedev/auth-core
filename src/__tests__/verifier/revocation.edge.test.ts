// @vitest-environment edge-runtime
//
// The revocation puller's conformance suite, in an edge runtime: the same
// globals as Vercel's Edge runtime and Next.js middleware (Web Crypto, fetch,
// no Node built-ins on the global scope).
import { expect, it } from 'vitest';
import { defineRevocationSuite } from './revocation-suite.js';

it('runs inside the edge runtime', () => {
  expect(typeof (globalThis as { EdgeRuntime?: unknown }).EdgeRuntime).toBe('string');
});

defineRevocationSuite('edge');
