// @vitest-environment node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  version: string;
  exports: Record<string, unknown>;
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

describe('the package', () => {
  it('is the 1.0 alpha line', () => {
    expect(pkg.version).toMatch(/^1\.0\.0-alpha\.\d+$/);
  });

  it('exports the browser entry, the server, the verifier, i18n and the testing fakes', () => {
    expect(Object.keys(pkg.exports).sort()).toEqual(['.', './i18n', './package.json', './server', './testing', './verifier']);
  });

  it.each(['src/index.ts', 'src/server/index.ts'])('%s bundles for an edge runtime with no Node built-in', async (entry) => {
    const result = await build({
      entryPoints: [resolve(root, entry)],
      bundle: true,
      write: false,
      metafile: true,
      logLevel: 'silent',
      platform: 'neutral',
      conditions: ['edge-light', 'worker', 'browser', 'import', 'module', 'default'],
      mainFields: ['module', 'main'],
      format: 'esm',
      target: 'es2022',
    });
    const inputs = Object.keys(result.metafile.inputs).map((path) => relative(root, resolve(root, path)));
    expect(inputs.filter((path) => !path.startsWith('src/') && !path.startsWith('node_modules/jose/'))).toEqual([]);
  });

  it('the browser entry carries no token verifier and no rule engine', async () => {
    const result = await build({ entryPoints: [resolve(root, 'src/index.ts')], bundle: true, write: false, metafile: true, logLevel: 'silent', platform: 'neutral', format: 'esm', mainFields: ['module', 'main'] });
    const inputs = Object.keys(result.metafile.inputs);
    expect(inputs.some((path) => path.includes('verifier/') || path.includes('jose'))).toBe(false);
  });

  it('names no internal ticket and no internal service in its source', () => {
    for (const file of sourceFiles(resolve(root, 'src'))) {
      const text = readFileSync(file, 'utf8');
      expect([relative(root, file), /\bTBP-\d+/.test(text)]).toEqual([relative(root, file), false]);
      expect([relative(root, file), /bridge-api|cloud-views|admin-ui|graphql/i.test(text)]).toEqual([relative(root, file), false]);
    }
  });

  it('has no .npmrc', () => {
    expect(readdirSync(root)).not.toContain('.npmrc');
  });
});
