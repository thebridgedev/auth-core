/**
 * The 1.0 agent guides (mcp/*.md) teach only what 1.0 has (TBP-292, TBP-355, TBP-812).
 *
 * - No 0.x setting, API or wording (the banned list below).
 * - Every `bridge <command>` they name is a CLI 1.0 command (scripts/cli-1.0-commands.txt, generated from bridge-cli v1).
 * - Every `bridge.<a>.<b>` call in their code exists on the real client (integration guide) or server (server guide).
 * - Every billing or flag guide has the terminal / browser verify split and the Heads up rule.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBridge } from '../index.js';
import { memoryStorage } from '../core/storage.js';
import { createBridgeServer } from '../server/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MCP = join(ROOT, 'mcp');
const guides = readdirSync(MCP).filter((name) => name.endsWith('.md'));
const read = (name: string) => readFileSync(join(MCP, name), 'utf8');
const docs: [string, string][] = [...guides.map((name): [string, string] => [`mcp/${name}`, read(name)]), ['README.md', readFileSync(join(ROOT, 'README.md'), 'utf8')]];

const BANNED = [
  'VITE_BRIDGE_APP_ID',
  'VITE_BRIDGE_API_BASE_URL',
  'BRIDGE_API_BASE_URL',
  'VITE_BRIDGE_CALLBACK_URL',
  'PUBLIC_BRIDGE_APP_ID',
  'bridge app update --ui-url',
  '--ui-url',
  'bridge app redirect-uris',
  '<Entitled',
  'bridge-api',
  'api.thebridge.dev',
  'initBridge',
  'useBridge',
  'display, not enforcement',
  'display only',
  'decoration',
  'the agent verifies',
];

/** CLI commands the guide readers add on this same change (TBP-292: auth-core is served as framework "javascript"). */
const PENDING_COMMANDS = ['bridge guide javascript [feature]'];

interface CommandNode {
  readonly children: Map<string, CommandNode>;
  args: number;
}
const tree: CommandNode = { children: new Map(), args: 0 };
for (const line of [...readFileSync(join(ROOT, 'scripts', 'cli-1.0-commands.txt'), 'utf8').split('\n'), ...PENDING_COMMANDS]) {
  const words = line.trim().split(/\s+/);
  if (words[0] !== 'bridge') continue;
  let node = tree;
  for (const word of words.slice(1)) {
    if (word.startsWith('<') || word.startsWith('[')) {
      node.args += 1;
      continue;
    }
    const next = node.children.get(word) ?? { children: new Map(), args: 0 };
    node.children.set(word, next);
    node = next;
  }
}

/** The command a `bridge …` line names, or the reason it is not one. */
function unknownCommand(command: string): string | null {
  const words = command.trim().split(/\s+/).slice(1);
  let node = tree;
  let args = 0;
  for (const word of words) {
    if (!/^[a-z][a-z0-9-]*$/.test(word)) break; // an option, a <placeholder>, a value: the command is named
    const next = node.children.get(word);
    if (next !== undefined && args === 0) {
      node = next;
      continue;
    }
    if (args < node.args) {
      args += 1;
      continue;
    }
    return `bridge ${words.join(' ')}`;
  }
  return node === tree ? `bridge ${words.join(' ')}` : null;
}

/** Every `bridge <command>` in a guide: inline code and code-block lines, with or without `npx @nebulr-group/bridge-cli@alpha`. */
function commandsIn(markdown: string): string[] {
  const found: string[] = [];
  const take = (text: string) => {
    const match = /^(?:\$\s*)?(?:npx\s+@nebulr-group\/bridge-cli(?:@\w+)?|bridge)\s+(.*)$/.exec(text.trim());
    if (match) found.push(`bridge ${match[1]}`);
  };
  const blocks = markdown.split(/^```/m);
  blocks.forEach((part, index) => {
    if (index % 2 === 1) part.split('\n').slice(1).forEach(take);
    else for (const inline of part.matchAll(/`([^`\n]+)`/g)) take(inline[1] ?? '');
  });
  return found;
}

describe('1.0 guides name nothing from 0.x', () => {
  it.each(docs)('%s', (_name, text) => {
    const hits = BANNED.filter((word) => text.includes(word));
    expect(hits).toEqual([]);
  });
});

describe('1.0 guides name only CLI 1.0 commands', () => {
  it('knows the command tree', () => {
    expect(unknownCommand('bridge app address add http://x --use email-links')).toBeNull();
    expect(unknownCommand('bridge app update --ui-url http://x')).toBeNull(); // the option is caught by the banned list
    expect(unknownCommand('bridge app redirect-uris add')).not.toBeNull();
    expect(unknownCommand('bridge guide decision going-live')).toBeNull();
    expect(unknownCommand('bridge flags list')).not.toBeNull();
  });
  it.each(docs)('%s', (_name, text) => {
    expect(commandsIn(text).map(unknownCommand).filter((each) => each !== null)).toEqual([]);
  });
});

/** `bridge.a.b` paths used in a guide's code blocks. */
function callsIn(markdown: string, name: string): string[] {
  const code = markdown
    .split(/^```/m)
    .filter((_part, index) => index % 2 === 1)
    .join('\n');
  const inline = [...markdown.matchAll(/`([^`\n]+)`/g)].map((each) => each[1] ?? '').join('\n');
  return [...new Set([...`${code}\n${inline}`.matchAll(new RegExp(`\\b${name}\\.([a-zA-Z]+(?:\\.[a-zA-Z]+)*)`, 'g'))].map((each) => each[1] as string))];
}

function missing(object: unknown, paths: readonly string[]): string[] {
  return paths.filter((path) => {
    let at: unknown = object;
    for (const part of path.split('.')) {
      if (at === null || at === undefined || (typeof at !== 'object' && typeof at !== 'function')) return false; // a value's own fields (`error.status`)
      if (!(part in (at as object))) return true;
      at = (at as Record<string, unknown>)[part];
    }
    return false;
  });
}

describe('the calls the guides teach exist', () => {
  it('mcp/integration-prompt.md: the browser client', () => {
    const bridge = createBridge({ issuer: 'https://bridge.test/apps/app-test', storage: memoryStorage(), signUpStorage: memoryStorage(), live: false, fetch: (() => new Promise(() => undefined)) as unknown as typeof fetch, tabChannel: null, locks: null });
    const used = callsIn(read('integration-prompt.md'), 'bridge');
    expect(used.length).toBeGreaterThan(20);
    expect(missing(bridge, used)).toEqual([]);
    bridge.destroy();
  });
  it('mcp/server-prompt.md: the server', async () => {
    const server = createBridgeServer({ issuer: 'https://bridge.test/apps/app-test', fetch: (() => new Promise(() => undefined)) as unknown as typeof fetch });
    const used = callsIn(read('server-prompt.md'), 'bridge');
    expect(used.length).toBeGreaterThan(8);
    expect(missing(server, used)).toEqual([]);
  });
});

describe('verify steps work without a browser (TBP-812)', () => {
  it.each(guides.map((name) => [name]))('mcp/%s', (name) => {
    const text = read(name);
    expect(text).toContain('### Terminal checks');
    expect(text).toContain('### Browser checks');
    expect(text).toContain('Heads up: not verified in a browser');
    expect(text).toContain('If you do not, list them for the developer, numbered');
  });
});
