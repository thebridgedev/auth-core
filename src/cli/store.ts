/// <reference types="node" />
/**
 * Where a CLI keeps its session between commands: the operating system's
 * keychain when there is one (macOS `security`, the Secret Service through
 * `secret-tool` on Linux), else a file only its owner can read (0600, in a
 * 0700 directory). One session per issuer.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { BridgeError } from '../core/errors.js';
import { readPrivateFile, removePrivateFile, writePrivateFile } from './files.js';

/** One signed-in session, as it is kept. */
export interface StoredCliSession {
  readonly issuer: string;
  /** The app the issuer signs in to. */
  readonly appId: string;
  readonly accessToken: string;
  /** When the access token expires, in ms since the epoch. */
  readonly accessTokenExpiresAt: number;
  readonly refreshToken: string | null;
  /** The workspace the tokens are for, when they name one. */
  readonly workspace: { readonly id: string; readonly name: string | null } | null;
  /** What the ID token said about the person (its signature is not needed: it came straight from the token endpoint). */
  readonly person: { readonly id: string | null; readonly email: string | null; readonly name: string | null };
  /** When the person signed in, in ms since the epoch. */
  readonly signedInAt: number;
}

export interface CliSessionStore {
  /** Where sessions are kept, in words: `macOS keychain`, `file <path>`. */
  describe(): string;
  read(issuer: string): Promise<StoredCliSession | null>;
  write(session: StoredCliSession): Promise<void>;
  remove(issuer: string): Promise<void>;
}

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a program with the given standard input. Secrets go on stdin, never in arguments. */
export type Runner = (command: string, args: readonly string[], input?: string) => Promise<RunResult>;

export const runProgram: Runner = (command, args, input) =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(command, [...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ code: 127, stdout: '', stderr: error instanceof Error ? error.message : String(error) });
      return;
    }
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', (error) => resolve({ code: 127, stdout, stderr: error.message }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(input ?? '');
  });

export function isStoredSession(value: unknown): value is StoredCliSession {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s['issuer'] === 'string' &&
    typeof s['appId'] === 'string' &&
    typeof s['accessToken'] === 'string' &&
    typeof s['accessTokenExpiresAt'] === 'number' &&
    (s['refreshToken'] === null || typeof s['refreshToken'] === 'string') &&
    typeof s['person'] === 'object' && s['person'] !== null
  );
}

const FILE = 'sessions.json';

/** Sessions in `<dir>/sessions.json`, readable only by its owner. */
export class FileSessionStore implements CliSessionStore {
  constructor(readonly dir: string) {}

  describe(): string {
    return `file ${join(this.dir, FILE)}`;
  }

  private async all(): Promise<Record<string, StoredCliSession>> {
    const raw = await readPrivateFile(this.dir, FILE);
    if (raw === null) return {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed !== 'object' || parsed === null) return {};
      return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, StoredCliSession] => isStoredSession(entry[1])));
    } catch {
      return {};
    }
  }

  async read(issuer: string): Promise<StoredCliSession | null> {
    return (await this.all())[issuer] ?? null;
  }

  async write(session: StoredCliSession): Promise<void> {
    const all = await this.all();
    all[session.issuer] = session;
    await writePrivateFile(this.dir, FILE, `${JSON.stringify(all, null, 2)}\n`);
  }

  async remove(issuer: string): Promise<void> {
    const all = await this.all();
    if (!(issuer in all)) return;
    delete all[issuer];
    if (Object.keys(all).length === 0) await removePrivateFile(this.dir, FILE);
    else await writePrivateFile(this.dir, FILE, `${JSON.stringify(all, null, 2)}\n`);
  }
}

/** The session as one base64 text, so it passes through a keychain tool with no quoting. */
function encode(session: StoredCliSession): string {
  return Buffer.from(JSON.stringify(session), 'utf8').toString('base64');
}

function decode(text: string): StoredCliSession | null {
  try {
    const parsed = JSON.parse(Buffer.from(text.trim(), 'base64').toString('utf8')) as unknown;
    return isStoredSession(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** A keychain entry's service or account name: nothing a quoted `security -i` line could break out of. */
function safeName(value: string, what: string): string {
  if (/["'\\\s]/.test(value) || value === '') throw new BridgeError('misconfigured', `The ${what} has characters a keychain entry cannot be named with.`);
  return value;
}

/** macOS: the login keychain, through `security`. The service is the CLI's name, the account the issuer. */
export class MacKeychainStore implements CliSessionStore {
  constructor(
    private readonly service: string,
    private readonly run: Runner = runProgram,
  ) {
    safeName(service, 'CLI name');
  }

  describe(): string {
    return 'macOS keychain';
  }

  async read(issuer: string): Promise<StoredCliSession | null> {
    const found = await this.run('security', ['find-generic-password', '-s', this.service, '-a', safeName(issuer, 'issuer'), '-w']);
    return found.code === 0 ? decode(found.stdout) : null;
  }

  async write(session: StoredCliSession): Promise<void> {
    // `security -i` reads the command from stdin, so the secret never shows in the process list.
    const line = `add-generic-password -U -s ${this.service} -a "${safeName(session.issuer, 'issuer')}" -l "${this.service} sign-in" -w "${encode(session)}"\n`;
    const done = await this.run('security', ['-i'], line);
    if (done.code !== 0 || /error/i.test(done.stderr)) throw new Error(`The keychain refused the session: ${done.stderr.trim()}`);
  }

  async remove(issuer: string): Promise<void> {
    await this.run('security', ['delete-generic-password', '-s', this.service, '-a', safeName(issuer, 'issuer')]);
  }
}

/** Linux: the Secret Service (GNOME Keyring, KWallet), through `secret-tool`. */
export class SecretToolStore implements CliSessionStore {
  constructor(
    private readonly service: string,
    private readonly run: Runner = runProgram,
  ) {
    safeName(service, 'CLI name');
  }

  describe(): string {
    return 'Secret Service keyring';
  }

  async read(issuer: string): Promise<StoredCliSession | null> {
    const found = await this.run('secret-tool', ['lookup', 'service', this.service, 'account', safeName(issuer, 'issuer')]);
    return found.code === 0 ? decode(found.stdout) : null;
  }

  async write(session: StoredCliSession): Promise<void> {
    const done = await this.run('secret-tool', ['store', `--label=${this.service} sign-in`, 'service', this.service, 'account', safeName(session.issuer, 'issuer')], encode(session));
    if (done.code !== 0) throw new Error(`The keyring refused the session: ${done.stderr.trim()}`);
  }

  async remove(issuer: string): Promise<void> {
    await this.run('secret-tool', ['clear', 'service', this.service, 'account', safeName(issuer, 'issuer')]);
  }
}

/**
 * The keychain first, the file when the keychain cannot keep it. A session is
 * read from wherever it is, and removed from both.
 */
export class KeychainWithFileStore implements CliSessionStore {
  constructor(
    private readonly keychain: CliSessionStore,
    private readonly file: FileSessionStore,
    private readonly warn: (message: string) => void,
  ) {}

  describe(): string {
    return this.keychain.describe();
  }

  async read(issuer: string): Promise<StoredCliSession | null> {
    return (await this.keychain.read(issuer)) ?? (await this.file.read(issuer));
  }

  async write(session: StoredCliSession): Promise<void> {
    try {
      await this.keychain.write(session);
      // Read it back: a keychain tool that cut a long entry short must not leave a session that cannot be read.
      const back = await this.keychain.read(session.issuer);
      if (back === null || JSON.stringify(back) !== JSON.stringify(session)) {
        await this.keychain.remove(session.issuer).catch(() => undefined);
        throw new Error('The keychain did not keep the session whole.');
      }
    } catch (error) {
      this.warn(`${error instanceof Error ? error.message : String(error)} Keeping it in ${this.file.describe()} instead.`);
      await this.file.write(session);
      return;
    }
    await this.file.remove(session.issuer);
  }

  async remove(issuer: string): Promise<void> {
    await this.keychain.remove(issuer);
    await this.file.remove(issuer);
  }
}

function onPath(program: string, env: NodeJS.ProcessEnv): boolean {
  return (env['PATH'] ?? '').split(delimiter).some((dir) => dir !== '' && existsSync(join(dir, program)));
}

export interface ChooseStoreOptions {
  /** The keychain entry's service: the CLI's name. */
  readonly service: string;
  /** The directory for the file. */
  readonly dir: string;
  /** `auto` (the keychain when there is one), `keychain` or `file`. @default 'auto' */
  readonly kind?: 'auto' | 'keychain' | 'file';
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly run?: Runner;
  readonly warn?: (message: string) => void;
  /** Whether a program exists (for tests). */
  readonly hasProgram?: (path: string) => boolean;
}

/** The store to use: the keychain when this machine has one (or when asked), else the private file. */
export function chooseSessionStore(options: ChooseStoreOptions): CliSessionStore {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const run = options.run ?? runProgram;
  const warn = options.warn ?? ((message: string) => process.stderr.write(`${message}\n`));
  const has = options.hasProgram ?? existsSync;
  const file = new FileSessionStore(options.dir);
  const wanted = options.kind ?? 'auto';
  if (wanted === 'file') return file;
  let keychain: CliSessionStore | null = null;
  if (platform === 'darwin' && (wanted === 'keychain' || has('/usr/bin/security'))) keychain = new MacKeychainStore(options.service, run);
  if (platform === 'linux' && (wanted === 'keychain' || (onPath('secret-tool', env) && env['DBUS_SESSION_BUS_ADDRESS']))) keychain = new SecretToolStore(options.service, run);
  if (keychain === null) {
    if (wanted === 'keychain') throw new BridgeError('misconfigured', 'This machine has no keychain the CLI can use; keep the session in a file instead.');
    return file;
  }
  return new KeychainWithFileStore(keychain, file, warn);
}
