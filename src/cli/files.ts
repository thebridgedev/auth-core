/// <reference types="node" />
/**
 * Files only their owner may read, for the CLI's session when there is no
 * keychain, and the lock that keeps two commands from renewing at once.
 *
 * - The directory is made 0700; an existing one must be a real directory (not
 *   a symlink) this user owns, and is tightened to 0700.
 * - A file is written to a temporary file with a random name in the same
 *   directory, created exclusively with mode 0600, then renamed over the file.
 * - A file that is a symlink is refused, for reading and for writing.
 */
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { BridgeError } from '../core/errors.js';

const POSIX = process.platform !== 'win32';

function refuse(message: string): BridgeError {
  return new BridgeError('misconfigured', `${message} Point the CLI's configuration directory at one only you can write to.`);
}

export async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) throw refuse(`${dir} is not a directory of its own (it is a symlink or a file).`);
  if (!POSIX) return;
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw refuse(`${dir} belongs to another user.`);
  if ((info.mode & 0o077) !== 0) await chmod(dir, 0o700);
}

async function exists(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw refuse(`${path} is a symlink, which is not followed.`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** The file's text, or null when there is none. A file others could read is tightened to 0600 first. */
export async function readPrivateFile(dir: string, name: string): Promise<string | null> {
  const path = join(dir, name);
  if (!(await exists(path))) return null;
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (POSIX ? constants.O_NOFOLLOW : 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    if (POSIX && ((await handle.stat()).mode & 0o077) !== 0) await handle.chmod(0o600);
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

export async function writePrivateFile(dir: string, name: string, content: string): Promise<void> {
  await ensurePrivateDir(dir);
  const path = join(dir, name);
  await exists(path);
  const temporary = join(dir, `.${name}.${randomBytes(8).toString('hex')}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    // Whatever the umask did, the file is 0600.
    if (POSIX) await handle.chmod(0o600);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await handle.close();
  await rename(temporary, path);
}

export async function removePrivateFile(dir: string, name: string): Promise<void> {
  await unlink(join(dir, name)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

const STALE_MS = 30_000;
const WAIT_MS = 15_000;

/**
 * Runs `fn` while holding a lock file, so two commands running at once never
 * renew with the same refresh token: Bridge rotates refresh tokens and ends
 * the session when one is used twice. A lock left by a command that crashed
 * is taken over after 30 seconds.
 */
export async function withFileLock<T>(dir: string, name: string, fn: () => Promise<T>): Promise<T> {
  await ensurePrivateDir(dir);
  const path = join(dir, `${name}.lock`);
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    try {
      const handle = await open(path, 'wx', 0o600);
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const age = await lstat(path).then((info) => Date.now() - info.mtimeMs, () => 0);
      if (age > STALE_MS) {
        await unlink(path).catch(() => undefined);
        continue;
      }
      if (Date.now() > deadline) throw new BridgeError('unavailable', `Another command holds ${path}. If none is running, delete that file.`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try {
    return await fn();
  } finally {
    await unlink(path).catch(() => undefined);
  }
}
