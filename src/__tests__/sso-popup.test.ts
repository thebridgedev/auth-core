import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SsoPopupManager } from '../sso-popup.js';
import type { Logger } from '../logger.js';
import type { ResolvedConfig } from '../types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CONFIG: ResolvedConfig = {
  appId: 'app1',
  apiBaseUrl: 'https://api.example.com',
  hostedUrl: 'https://hosted.example.com',
  authBaseUrl: 'https://api.example.com/auth',
  callbackUrl: 'https://myapp.com/callback',
  defaultRedirectRoute: '/',
  loginRoute: '/login',
  teamManagementUrl: 'https://team.example.com',
  storage: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
  debug: false,
};

const logger: Logger = {
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const PROVIDERS = [
  'google',
  'github',
  'ms-azure-ad',
  'linkedin',
  'facebook',
  'apple',
  'saml',
  'oidc',
] as const;

// ---------------------------------------------------------------------------
// DOM / window mocking helpers
// ---------------------------------------------------------------------------

type MessageListener = (event: MessageEvent) => void;

function createFakePopup(closed = false): Window {
  return {
    closed,
    close: vi.fn(),
  } as unknown as Window;
}

function setupWindowMocks(opts: { popupBlocked?: boolean } = {}) {
  const messageListeners: MessageListener[] = [];
  const fakePopup = opts.popupBlocked ? null : createFakePopup(false);

  const windowOpenSpy = vi.fn(() => fakePopup);
  const locationAssignSpy = vi.fn();
  const addEventListenerSpy = vi.fn((type: string, listener: EventListener) => {
    if (type === 'message') {
      messageListeners.push(listener as MessageListener);
    }
  });
  const removeEventListenerSpy = vi.fn();

  Object.defineProperty(globalThis, 'window', {
    value: {
      open: windowOpenSpy,
      addEventListener: addEventListenerSpy,
      removeEventListener: removeEventListenerSpy,
      location: { origin: 'https://myapp.com', assign: locationAssignSpy },
    },
    writable: true,
    configurable: true,
  });

  Object.defineProperty(globalThis, 'screen', {
    value: { width: 1440, height: 900 },
    writable: true,
    configurable: true,
  });

  function dispatchMessage(data: unknown, origin = 'https://api.example.com') {
    const event = { data, origin } as MessageEvent;
    messageListeners.forEach((l) => l(event));
  }

  return {
    windowOpenSpy,
    locationAssignSpy,
    addEventListenerSpy,
    removeEventListenerSpy,
    fakePopup,
    dispatchMessage,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SsoPopupManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Redirect mode (default)
  // -------------------------------------------------------------------------

  describe('startSsoLogin — redirect mode (default)', () => {
    it.each(PROVIDERS)(
      'navigates the current tab to the federation URL for provider=%s with no mode/targetOrigin',
      (provider) => {
        const { locationAssignSpy, windowOpenSpy, addEventListenerSpy } = setupWindowMocks();

        const manager = new SsoPopupManager(CONFIG, logger);
        // Explicit redirect mode
        manager.startSsoLogin(provider, { mode: 'redirect' });

        expect(locationAssignSpy).toHaveBeenCalledTimes(1);
        const [urlStr] = locationAssignSpy.mock.calls[0];
        const url = new URL(urlStr as string);

        expect(url.pathname).toBe('/auth/auth/federation/app1');
        expect(url.searchParams.get('provider')).toBe(provider);
        // Redirect mode MUST NOT include popup-only params
        expect(url.searchParams.get('mode')).toBeNull();
        expect(url.searchParams.get('targetOrigin')).toBeNull();

        // And must not touch popup machinery
        expect(windowOpenSpy).not.toHaveBeenCalled();
        expect(addEventListenerSpy).not.toHaveBeenCalledWith('message', expect.any(Function));
      },
    );

    it('uses redirect mode when no options are provided (default)', () => {
      const { locationAssignSpy, windowOpenSpy } = setupWindowMocks();

      const manager = new SsoPopupManager(CONFIG, logger);
      manager.startSsoLogin('google');

      expect(locationAssignSpy).toHaveBeenCalledTimes(1);
      expect(windowOpenSpy).not.toHaveBeenCalled();
    });

    it('returns a promise that never resolves (tab is navigating away)', async () => {
      setupWindowMocks();
      const manager = new SsoPopupManager(CONFIG, logger);

      let settled = false;
      manager.startSsoLogin('google', { mode: 'redirect' })
        .then(() => { settled = true; })
        .catch(() => { settled = true; });

      // Advance timers far into the future
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(settled).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Popup mode — URL construction
  // -------------------------------------------------------------------------

  describe('startSsoLogin — popup mode URL construction', () => {
    it.each(PROVIDERS)(
      'opens a popup with the correct federation URL for provider=%s',
      (provider) => {
        const { windowOpenSpy } = setupWindowMocks();

        const manager = new SsoPopupManager(CONFIG, logger);
        manager.startSsoLogin(provider, { mode: 'popup' }).catch(() => {});

        const [urlStr] = windowOpenSpy.mock.calls[0];
        const url = new URL(urlStr as string);

        expect(url.pathname).toBe('/auth/auth/federation/app1');
        expect(url.searchParams.get('provider')).toBe(provider);
        expect(url.searchParams.get('mode')).toBe('popup');
        expect(url.searchParams.get('targetOrigin')).toBe('https://myapp.com');
      },
    );

    it('uses default dimensions (500 x 600) when no options are provided', () => {
      const { windowOpenSpy } = setupWindowMocks();

      const manager = new SsoPopupManager(CONFIG, logger);
      manager.startSsoLogin('google', { mode: 'popup' }).catch(() => {});

      const [, , features] = windowOpenSpy.mock.calls[0];
      expect(features).toContain('width=500');
      expect(features).toContain('height=600');
    });

    it('respects custom width and height options', () => {
      const { windowOpenSpy } = setupWindowMocks();

      const manager = new SsoPopupManager(CONFIG, logger);
      manager.startSsoLogin('google', { mode: 'popup', width: 800, height: 700 }).catch(() => {});

      const [, , features] = windowOpenSpy.mock.calls[0];
      expect(features).toContain('width=800');
      expect(features).toContain('height=700');
    });

    it('registers a message event listener on window', () => {
      const { addEventListenerSpy } = setupWindowMocks();

      const manager = new SsoPopupManager(CONFIG, logger);
      manager.startSsoLogin('google', { mode: 'popup' }).catch(() => {});

      expect(addEventListenerSpy).toHaveBeenCalledWith('message', expect.any(Function));
    });
  });

  // -------------------------------------------------------------------------
  // Popup blocked
  // -------------------------------------------------------------------------

  describe('popup blocked', () => {
    it('rejects with an error when window.open returns null', async () => {
      setupWindowMocks({ popupBlocked: true });

      const manager = new SsoPopupManager(CONFIG, logger);
      await expect(manager.startSsoLogin('google', { mode: 'popup' })).rejects.toThrow(
        'Failed to open SSO popup',
      );
    });

    it('does not register a message listener when popup is blocked', () => {
      const { addEventListenerSpy } = setupWindowMocks({ popupBlocked: true });

      const manager = new SsoPopupManager(CONFIG, logger);
      manager.startSsoLogin('google', { mode: 'popup' }).catch(() => {});

      expect(addEventListenerSpy).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Successful postMessage
  // -------------------------------------------------------------------------

  describe('successful postMessage', () => {
    it('resolves when a valid auth_ postMessage arrives from the correct origin', async () => {
      const { dispatchMessage } = setupWindowMocks();
      const manager = new SsoPopupManager(CONFIG, logger);

      const promise = manager.startSsoLogin('google', { mode: 'popup' });

      dispatchMessage({
        type: 'auth_success',
        session: 'sess-1',
        expires: 9999,
        mfaState: 'COMPLETED',
        tenantUsers: [],
        tokens: { accessToken: 'a', refreshToken: 'r', idToken: 'i' },
      });

      const result = await promise;
      expect(result.type).toBe('auth_success');
    });

    it('includes session, expires, mfaState, tenantUsers, and tokens from the message', async () => {
      const { dispatchMessage } = setupWindowMocks();
      const manager = new SsoPopupManager(CONFIG, logger);

      const promise = manager.startSsoLogin('google', { mode: 'popup' });

      const payload = {
        type: 'auth_success',
        session: 'my-session',
        expires: 12345678,
        mfaState: 'COMPLETED',
        tenantUsers: [{ id: 'tu-1', username: 'alice', fullName: 'Alice', tenant: { id: 't1', name: 'T1', logo: '' } }],
        tokens: { accessToken: 'acc', refreshToken: 'ref', idToken: 'id' },
      };

      dispatchMessage(payload);
      const result = await promise;

      expect(result).toMatchObject({
        type: 'auth_success',
        session: 'my-session',
        expires: 12345678,
        mfaState: 'COMPLETED',
      });
    });

    it('removes the message listener after resolving', async () => {
      const { dispatchMessage, removeEventListenerSpy } = setupWindowMocks();
      const manager = new SsoPopupManager(CONFIG, logger);

      const promise = manager.startSsoLogin('google', { mode: 'popup' });
      dispatchMessage({ type: 'auth_success' });
      await promise;

      expect(removeEventListenerSpy).toHaveBeenCalledWith('message', expect.any(Function));
    });

    it('closes the popup after resolving', async () => {
      const { dispatchMessage, fakePopup } = setupWindowMocks();
      const manager = new SsoPopupManager(CONFIG, logger);

      const promise = manager.startSsoLogin('google', { mode: 'popup' });
      dispatchMessage({ type: 'auth_success' });
      await promise;

      expect((fakePopup as Window & { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Wrong origin — message ignored
  // -------------------------------------------------------------------------

  describe('wrong origin', () => {
    it('ignores postMessages from an unexpected origin', async () => {
      const { dispatchMessage } = setupWindowMocks();
      const manager = new SsoPopupManager(CONFIG, logger);

      let settled = false;
      const promise = manager.startSsoLogin('google', { mode: 'popup' })
        .then((r) => { settled = true; return r; })
        .catch(() => { settled = true; });

      dispatchMessage({ type: 'auth_success' }, 'https://evil.example.com');

      await Promise.resolve();
      expect(settled).toBe(false);

      dispatchMessage({ type: 'auth_success' });
      await promise;
      expect(settled).toBe(true);
    });

    it('logs a debug message when a message from an unexpected origin is received', async () => {
      const { dispatchMessage } = setupWindowMocks();
      const manager = new SsoPopupManager(CONFIG, logger);

      const promise = manager.startSsoLogin('google', { mode: 'popup' });

      dispatchMessage({ type: 'auth_success' }, 'https://evil.example.com');
      await Promise.resolve();

      expect((logger.debug as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
        expect.stringContaining('Ignoring postMessage'),
      );

      dispatchMessage({ type: 'auth_success' });
      await promise;
    });
  });

  // -------------------------------------------------------------------------
  // Non-auth_ message type — ignored
  // -------------------------------------------------------------------------

  describe('non-auth_ message type', () => {
    it('ignores messages whose type does not start with "auth_"', async () => {
      const { dispatchMessage } = setupWindowMocks();
      const manager = new SsoPopupManager(CONFIG, logger);

      let settled = false;
      const promise = manager.startSsoLogin('google', { mode: 'popup' })
        .then((r) => { settled = true; return r; })
        .catch(() => { settled = true; });

      dispatchMessage({ type: 'unrelated_event' });
      await Promise.resolve();
      expect(settled).toBe(false);

      dispatchMessage({ type: 'auth_success' });
      await promise;
      expect(settled).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Popup closed by user
  // -------------------------------------------------------------------------

  describe('popup closed by user', () => {
    it('rejects when the poll detects that the popup was closed', async () => {
      const { fakePopup } = setupWindowMocks();
      const manager = new SsoPopupManager(CONFIG, logger);

      const rejection = expect(manager.startSsoLogin('google', { mode: 'popup' })).rejects.toThrow(
        'SSO popup was closed by user',
      );

      (fakePopup as unknown as { closed: boolean }).closed = true;

      await vi.advanceTimersByTimeAsync(600);

      await rejection;
    });

    it('removes the message listener when popup is closed by user', async () => {
      const { fakePopup, removeEventListenerSpy } = setupWindowMocks();
      const manager = new SsoPopupManager(CONFIG, logger);

      const promise = manager.startSsoLogin('google', { mode: 'popup' }).catch(() => {});

      (fakePopup as unknown as { closed: boolean }).closed = true;
      await vi.advanceTimersByTimeAsync(600);
      await promise;

      expect(removeEventListenerSpy).toHaveBeenCalledWith('message', expect.any(Function));
    });
  });

  // -------------------------------------------------------------------------
  // Timeout
  // -------------------------------------------------------------------------

  describe('timeout', () => {
    it('rejects after 5 minutes if no message is received', async () => {
      setupWindowMocks();
      const manager = new SsoPopupManager(CONFIG, logger);

      const rejection = expect(manager.startSsoLogin('google', { mode: 'popup' })).rejects.toThrow(
        'SSO popup timed out',
      );

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);

      await rejection;
    });
  });

  // -------------------------------------------------------------------------
  // close()
  // -------------------------------------------------------------------------

  describe('close()', () => {
    it('closes the popup when close() is called', () => {
      const { fakePopup } = setupWindowMocks();
      const manager = new SsoPopupManager(CONFIG, logger);

      manager.startSsoLogin('google', { mode: 'popup' }).catch(() => {});
      manager.close();

      expect((fakePopup as Window & { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalled();
    });

    it('removes the message event listener when close() is called', () => {
      const { removeEventListenerSpy } = setupWindowMocks();
      const manager = new SsoPopupManager(CONFIG, logger);

      manager.startSsoLogin('google', { mode: 'popup' }).catch(() => {});
      manager.close();

      expect(removeEventListenerSpy).toHaveBeenCalledWith('message', expect.any(Function));
    });
  });
});
