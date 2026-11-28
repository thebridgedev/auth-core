/// <reference types="node" />
/**
 * Opening the sign-in page in the person's browser, with no shell anywhere:
 * the address is one argument of an argument array (`open` on macOS,
 * `rundll32 url.dll,FileProtocolHandler` on Windows, `xdg-open` elsewhere).
 * Only https addresses (http on this machine) are opened.
 */
import { execFile } from 'node:child_process';
import { secureUrl } from '../core/urls.js';

export function browserCommand(url: string, platform: NodeJS.Platform): { command: string; args: string[] } {
  if (platform === 'darwin') return { command: 'open', args: [url] };
  if (platform === 'win32') return { command: 'rundll32', args: ['url.dll,FileProtocolHandler', url] };
  return { command: 'xdg-open', args: [url] };
}

/**
 * Whether a browser can be opened on this machine: not over SSH, and on Linux
 * only with a display. When it cannot, login uses a short code instead.
 */
export function canOpenBrowser(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  if (env['SSH_CONNECTION'] || env['SSH_TTY']) return false;
  if (platform === 'darwin' || platform === 'win32') return true;
  return Boolean(env['DISPLAY'] || env['WAYLAND_DISPLAY']);
}

/** Opens the address. Resolves `true` when the opener started, `false` when it could not. */
export function openInBrowser(url: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  if (secureUrl(url) === null) return Promise.resolve(false);
  const { command, args } = browserCommand(url, platform);
  return new Promise((resolve) => {
    let settled = false;
    const settle = (ok: boolean) => {
      if (!settled) {
        settled = true;
        resolve(ok);
      }
    };
    try {
      const child = execFile(command, args, { windowsHide: true, shell: false }, (error) => settle(error === null));
      child.on('error', () => settle(false));
      child.unref();
    } catch {
      settle(false);
      return;
    }
    // Most openers return at once; one that has not answered in 2 s most likely opened the browser.
    setTimeout(() => settle(true), 2000).unref();
  });
}
