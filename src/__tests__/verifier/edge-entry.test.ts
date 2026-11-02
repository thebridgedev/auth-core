// @vitest-environment node
//
// The verifier entry loads in an edge runtime without pulling in server-only
// code.
//
// Three proofs, from the package's point of view:
//  1. The published `./verifier` export resolves to the same file for the
//     browser, edge and Node conditions, and that file is built from
//     src/verifier/index.ts.
//  2. Bundled the way an edge bundler does it (no Node platform, edge
//     conditions), the entry's whole import graph is its own files plus jose.
//     A bundle that reached a Node built-in would fail to build. The negative
//     control below shows that this check does catch one.
//  3. That bundle runs inside an edge runtime VM (no require, no process, no
//     Buffer) and checks a token there.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { build, type BuildOptions } from 'esbuild';
import { EdgeVM } from '@edge-runtime/vm';
import { APP, ISSUER, makeKeyRing, mint, personClaims } from './fixtures.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const entry = resolve(root, 'src/verifier/index.ts');

const edgeBundle: BuildOptions = {
  bundle: true,
  write: false,
  metafile: true,
  logLevel: 'silent',
  // `neutral` knows no Node built-ins, so importing one fails the build.
  platform: 'neutral',
  // The conditions Next.js uses for edge middleware.
  conditions: ['edge-light', 'worker', 'browser', 'import', 'module', 'default'],
  mainFields: ['module', 'main'],
  target: 'es2022',
};

describe('verifier entry in an edge runtime', () => {
  it('is published under browser, edge and Node conditions, all resolving to the edge-safe build', () => {
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
    const exp = pkg.exports['./verifier'];
    expect(exp.types).toBe('./dist/verifier/index.d.ts');
    for (const condition of ['browser', 'edge-light', 'workerd', 'worker', 'node', 'import', 'default']) {
      expect([condition, exp[condition]]).toEqual([condition, './dist/verifier/index.js']);
    }
    expect(pkg.typesVersions['*'].verifier).toEqual(['./dist/verifier/index.d.ts']);
  });

  it('bundles for an edge runtime from its own files and jose only', async () => {
    const result = await build({ ...edgeBundle, entryPoints: [entry], format: 'esm' });
    const inputs = Object.keys(result.metafile!.inputs).map((p) => relative(root, resolve(root, p)));
    const outside = inputs.filter(
      (p) => !p.startsWith('src/verifier/') && !p.startsWith('node_modules/jose/'),
    );
    expect(outside).toEqual([]);
    expect(inputs.some((p) => p.startsWith('node_modules/jose/'))).toBe(true);
    // jose's edge build, not its Node build.
    expect(inputs.some((p) => p.includes('/node/'))).toBe(false);
  });

  it('negative control: the same bundling fails as soon as a Node built-in is imported', async () => {
    await expect(
      build({
        ...edgeBundle,
        format: 'esm',
        stdin: {
          contents: `import 'node:fs/promises';\nexport * from './src/verifier/index.ts';`,
          resolveDir: root,
          loader: 'ts',
        },
      }),
    ).rejects.toThrow(/node:fs\/promises/);
  });

  it('runs in an edge runtime VM and checks a token there', async () => {
    const result = await build({
      ...edgeBundle,
      entryPoints: [entry],
      format: 'iife',
      globalName: 'BridgeVerifier',
    });
    const code = result.outputFiles![0].text;

    const vm = new EdgeVM();
    expect(vm.evaluate('typeof require')).toBe('undefined');
    vm.evaluate(code);

    const ring = await makeKeyRing();
    const token = await mint(ring.app, personClaims());
    const [header, payload, signature] = token.split('.');
    const flipped = signature[10] === 'A' ? 'B' : 'A';
    const forged = `${header}.${payload}.${signature.slice(0, 10)}${flipped}${signature.slice(11)}`;
    vm.context.__input = JSON.stringify({ jwks: ring.jwks, token, forged, appId: APP, issuer: ISSUER });

    const output = await vm.evaluate(`(async () => {
      const input = JSON.parse(__input);
      const verifier = BridgeVerifier.createCredentialVerifier({
        appId: input.appId,
        issuer: input.issuer,
        jwks: input.jwks,
        revocationCheck: 'none',
      });
      const good = await verifier.verify({ type: 'token', value: input.token });
      const bad = await verifier.verify({ type: 'token', value: input.forged });
      return JSON.stringify({
        runtime: typeof EdgeRuntime,
        processType: typeof process,
        good: good.ok ? { kind: good.actor.kind, id: good.actor.id, workspaceId: good.actor.workspaceId } : good.refusal,
        bad: bad.ok ? 'accepted' : bad.refusal.reason,
      });
    })()`);

    const parsed = JSON.parse(output as string);
    expect(parsed.runtime).toBe('string');
    expect(parsed.good).toEqual({ kind: 'person', id: 'user-alice', workspaceId: 'ws-alpha' });
    expect(parsed.bad).toBe('bad_signature');
  });
});
