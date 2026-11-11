import type { Endpoints } from './core/discovery.js';
import { BridgeError } from './core/errors.js';
import { call, type Fetch } from './core/http.js';
import { ROUTES } from './core/routes.js';
import { readJson, storageKey, type BridgeStorage } from './core/storage.js';
import { createPkce, randomToken } from './core/util.js';
import type { Session } from './session.js';

/**
 * Hosted mode: the Child App sends the person to the sign-in page Bridge
 * hosts for it, instead of showing its own, and gets them back signed in.
 *
 * It is the authorization code flow with PKCE (RFC 7636), with the request
 * held by Bridge (in the spirit of RFC 9126):
 *
 * 1. `start` makes a PKCE pair and a `state`, and asks Bridge for a sign-in
 *    request with the challenge, the app's registered return and the state.
 *    The verifier and the state stay in this browser. It answers the page's
 *    address with the request's id, for the app to send the browser to.
 * 2. The page signs the person in by any method the app offers, and sends
 *    the browser to the return with `code`, `state` and `iss`. A sign-in
 *    link opened in another tab of this browser finishes there.
 * 3. `finish`, on the return, checks `iss` (RFC 9207) and `state`, and
 *    trades the code with the verifier and the same return.
 *
 * The return must be one of the app's registered sign-in returns, exactly.
 */

export interface HostedStartOptions {
  /** Where the page sends the person back: one of the app's registered sign-in returns, exactly. */
  readonly redirectUri: string;
  /**
   * Where an email link sent on this sign-in goes: one of the app's
   * registered email-links addresses, exactly. @default Bridge's hosted page
   */
  readonly linkAddress?: string;
}

/** What waits in this browser for the return: kept where every tab of the origin reads it, as a sign-up's verifier is. */
interface Pending {
  readonly verifier: string;
  readonly state: string;
  readonly redirectUri: string;
  readonly expiresAt: number;
}

/** A request's sign-in starts within 10 minutes, and a link sent on it works 15 more. */
const PENDING_KEEP_MS = 25 * 60 * 1000;

export interface HostedDeps {
  readonly issuer: string;
  readonly endpoints: () => Endpoints;
  readonly fetch: Fetch;
  readonly storage: BridgeStorage;
  readonly session: Session;
}

export function createHosted(deps: HostedDeps) {
  const key = storageKey(deps.issuer, 'hosted');

  return {
    /** Whether the issuer offers a hosted sign-in page for this app: the app registered it. */
    async offered(): Promise<boolean> {
      return deps.endpoints().metadata.signInPage !== null && deps.endpoints().offers(ROUTES.signInRequest);
    },

    /**
     * Starts a hosted sign-in and answers the page's address to send the
     * browser to. A newer start replaces an older one in this browser.
     */
    async start(options: HostedStartOptions): Promise<string> {
      const page = deps.endpoints().metadata.signInPage;
      if (page === null) throw new BridgeError('not-offered', 'This issuer offers no hosted sign-in page for the app. Register the page in the app\'s addresses.');
      const pkce = await createPkce();
      const state = randomToken(32);
      const answer = (
        await call<{ request?: unknown }>(deps.fetch, deps.endpoints().url(ROUTES.signInRequest), {
          method: 'POST',
          body: { redirect_uri: options.redirectUri, code_challenge: pkce.challenge, code_challenge_method: 'S256', state, ...(options.linkAddress === undefined ? {} : { link_address: options.linkAddress }) },
        })
      ).body;
      const request = answer?.request;
      if (typeof request !== 'string' || request === '') throw new BridgeError('unavailable', 'Bridge did not answer a sign-in request.');
      await deps.storage.set(key, JSON.stringify({ verifier: pkce.verifier, state, redirectUri: options.redirectUri, expiresAt: Date.now() + PENDING_KEEP_MS } satisfies Pending));
      const url = new URL(page);
      url.searchParams.set('request', request);
      return url.toString();
    },

    /**
     * Finishes a hosted sign-in on the return: reads `code`, `state` and
     * `iss` from `location` (the return's full address), checks them and
     * trades the code. Fails with `invalid` for a return this browser did
     * not start, another issuer's, or one already finished.
     */
    async finish(location: string | URL): Promise<void> {
      const url = new URL(String(location));
      const params = url.searchParams;
      for (const name of ['code', 'state', 'iss']) {
        if (params.getAll(name).length > 1) throw new BridgeError('invalid', `The sign-in return has ${name} more than once.`);
      }
      const error = params.get('error');
      if (error !== null) throw new BridgeError('invalid', `The sign-in did not finish: ${error}.`, { code: error });
      const pending = await readJson<Pending>(deps.storage, key);
      if (pending === null || pending.expiresAt <= Date.now() || typeof pending.verifier !== 'string') {
        await deps.storage.remove(key);
        throw new BridgeError('invalid', 'This sign-in return was not started in this browser, or it is too old. Sign in again.');
      }
      // The issuer that answered must be ours (RFC 9207), and the state the one this browser sent (RFC 6749, 10.12).
      if (params.get('iss') !== deps.issuer) throw new BridgeError('invalid', 'The sign-in return names another issuer.');
      if (params.get('state') !== pending.state) throw new BridgeError('invalid', 'The sign-in return is not the one this browser started.');
      const code = params.get('code');
      if (code === null || code === '') throw new BridgeError('invalid', 'The sign-in return carries no code.');
      // Spent before the trade: a return is finished once, whatever the trade answers.
      await deps.storage.remove(key);
      await deps.session.exchangeCode(code, pending.verifier, pending.redirectUri);
    },
  };
}

/** Whether an address is a hosted sign-in's return: it carries `state` and either `code` or `error`. */
export function isHostedReturn(location: string | URL): boolean {
  const params = new URL(String(location)).searchParams;
  return params.has('state') && (params.has('code') || params.has('error'));
}
