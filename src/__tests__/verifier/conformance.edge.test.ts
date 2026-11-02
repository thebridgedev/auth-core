// @vitest-environment edge-runtime
//
// The credential verifier's conformance suite, in an edge runtime: the same
// globals as Vercel's Edge runtime and Next.js middleware (Web Crypto, fetch,
// no Node built-ins on the global scope).
import { expect, it } from 'vitest';
import { defineConformanceSuite } from './conformance-suite.js';

it('runs inside the edge runtime', () => {
  expect(typeof (globalThis as { EdgeRuntime?: unknown }).EdgeRuntime).toBe('string');
});

defineConformanceSuite('edge');
