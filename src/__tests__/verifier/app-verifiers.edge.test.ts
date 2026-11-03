// @vitest-environment edge-runtime
//
// The many-app verifier's suite, in an edge runtime: the same globals as
// Vercel's Edge runtime and Next.js middleware (Web Crypto, fetch, no Node
// built-ins on the global scope).
import { expect, it } from 'vitest';
import { defineAppVerifiersSuite } from './app-verifiers-suite.js';

it('runs inside the edge runtime', () => {
  expect(typeof (globalThis as { EdgeRuntime?: unknown }).EdgeRuntime).toBe('string');
});

defineAppVerifiersSuite('edge');
