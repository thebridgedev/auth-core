# Changelog

## [1.0.0-alpha.8] - Unreleased

### Added

- **Sign-in protection's answers**: a sign-in refused because the account or the network address is paused is a `rate-limited` error with `code: 'too_many_attempts'` and `retryAfterSeconds`; a locked account is `code: 'account_locked'`. `waitMinutes(error)` gives the whole minutes to wait, and the catalogue has `login.error.tooManyAttempts` ("Too many attempts. Try again in {minutes} minutes.") and `login.error.accountLocked` in every language. Bridge answers both the same whether or not the email has an account.

## [1.0.0-alpha.7] - Unreleased

### Changed

- **A sign-in link sent on a sign-in request is bound to the browser that asked for it**, as a sign-up link is. `magicLink.start` keeps a verifier in `signUpStorage` and sends its challenge with the request; `magicLink.finish` opens the link only in a tab of that browser, and fails with `wrong-device` anywhere else (a mail scanner that opens links, or a person who never asked), leaving the link and the request unused. The code is still the requesting app's. A link that lands on the app's own page opens there with the app's verifier for its hosted sign-in. Needs a Bridge server that accepts the challenge on a request.

## [1.0.0-alpha.6] - Unreleased

### Added

- **Hosted mode**: `hosted.start({ redirectUri, linkAddress? })` starts a sign-in on the page Bridge hosts for the app (the authorization code flow with PKCE, the request held by Bridge) and answers the page's address; `hosted.finish(location)` checks `iss` and `state` on the return and trades the code with the verifier and the same `redirect_uri`. `hosted.offered()` says whether the app registered the page. `isHostedReturn(location)` tells a return apart.
- **Signing in for another app's sign-in request**: `request.use(id)` makes every sign-in step (password, sign-in link, passkey, sign-up) send the request instead of the page's own challenge. A finished step is then `{ done: true, handoff }`, the app's return with `code`, `state` and `iss`; no session is made. A sign-in link sent on a request finishes in any tab, with no verifier; a sign-up link still finishes only where the sign-up started.
- **`linkAddress`** in `createBridge`: which of the app's registered email-links addresses sign-up, sign-in link and recovery emails link to, for an app with several sign-in pages.
- **`IssuerMetadata.signInPage`**: the hosted page's address, when the app registered it. The fake issuer in `/testing` serves sign-in requests and lists the page when given `returns`.

### Changed

- **A code made for a registered return is traded with that `redirect_uri`** (`hosted.finish`).

## [1.0.0-alpha.5] - Unreleased

### Added

- **Passkeys**: `passkeys.signIn({ email?, workspace?, autofill? })` signs in with a passkey (a discoverable one, or only that address's; `autofill` waits for a pick from an input's autofill list); `passkeys.add(name?)`, `passkeys.list()` and `passkeys.remove(id)` for the signed-in person; `passkeys.setupLink.request(email)` and `passkeys.setupLink.finish(token, name?)` make one from an emailed link on the device that asked, and sign in. `passkeys.supported()`, `passkeys.autofillSupported()` and `passkeys.cancel()` for the page.
- **The browser's side** runs on `@simplewebauthn/browser` (13.3.0), imported only when a passkey is used. `createBridge({ webauthn })` replaces it; `fakeWebAuthn()` in `/testing` stands in for the dialog, and the fake issuer serves passkeys when `methods` lists `'passkeys'`.
- **New error kinds**: `cancelled` (the dialog was closed or timed out) and `not-supported`. A passkey that could not be verified, or that the app does not know, is `wrong-credentials` (codes `passkey_refused`, `unknown_passkey`); a passkey request that expired is `flow-expired`.
- **`readEmailLink` and `takeEmailLink` read `#bridge=passkey-setup&token=…`.** Its verifier waits in `signUpStorage` as long as the link works (24 hours), and is removed once used or found expired.

## [1.0.0-alpha.4] - Unreleased

### Added

- **Sign-in links (magic links)**: `magicLink.start(email)` asks for a link that signs in, and `magicLink.finish(token)` signs in from it, on the device that asked. Each link works once, for 15 minutes; on another device `finish` fails with `wrong-device`, and used again with `link-invalid`. The answer to `start` is the same whether or not the address has an account. The verifier waits in `signUpStorage`, at most as long as the link works, and is removed once used or found expired.
- **`readEmailLink` and `takeEmailLink` read `#bridge=magic-link&token=…`.**
- **`signUp.start` and `invites.signUp` take no password** when the app offers only sign-in links: `password` is optional and is sent only when given.
- **`SignInOptions.password` carries the app's password rules** (`minLength`, `maxLength`, `requireUpper`, `requireLower`, `requireDigit`, `requireSymbol`, `blockEmail`), and is absent when the app offers no passwords.

## [1.0.0-alpha.3] - Unreleased

### Added

- **`signUpStorage`** in `createBridge`: where a sign-up's PKCE verifier waits for its email link. The link usually opens in a new tab, so a page that keeps its session in memory (`storage: memoryStorage()`) passes storage every tab shares, such as `localStorageAdapter()`. Then the link finishes the sign-up in a new tab of the same browser, even after the tab that started it is closed, and still answers `wrong-device` on another device. It defaults to `storage`, as before.

### Changed

- **The sign-up verifier is removed as soon as Bridge takes it**, and when it is found past its link's 15 minutes, instead of lingering until the next sign-up.

## [1.0.0-alpha.2] - Unreleased

### Added

- **Invites at sign-in.** `invites.preview(token)` shows an invite before anyone signs in: `open` with the workspace's name and logo and whether the address has an account, or only `revoked`, `used` or `expired`. `invites.signUp({ token, password, … })` signs a new person up from the invite and in, in the inviting workspace, with no second email. `invites.accept(token)` accepts as the signed-in person and moves the session into the workspace they joined. The token always travels in a request body.
- **`takeEmailLink(kind?)`** reads a Bridge email link (`#bridge=…&token=…`) from the page's address and clears it from the address bar and the history. Other fragments are left alone.
- **Invite refusals have their own codes.** A link that no longer works is `link-invalid` with `code` `invite_revoked`, `invite_used` or `invite_expired`; another address is `forbidden` (`invite_for_another_address`); a member already, or a sign-up for an address with an account, is `conflict` (`already_member`, `account_exists`).
- **The fake issuer** in `./testing` serves invites: `invite(email, workspace, role?)`, `invites()`, `expireInvites(email)`, and `lastLink(email, 'invite')`. Its invites last 30 days, and sending one again replaces its token.

### Changed

- **`signIn.start` and `signUp.start` no longer take `invite`.** A sign-up from an invite is `invites.signUp`, and a person with an account signs in, then calls `invites.accept`.
- **The invite endpoints are the issuer's** `invites` and `invite_preview`. `invites.preview` is a POST with the token in the body.

## [1.0.0-alpha.1] - Unreleased

### Changed

- **Hand-off returns `iss`.** `handoffReturnUrl(request, code, issuer)` now takes the issuer the page signed in with and adds it to the callback as `iss` (RFC 9207), so a program can check which issuer answered.
- **Hand-off returns only to `/callback`.** `isLoopbackRedirect` and `readHandoffRequest` accept `http://127.0.0.1:<port>/callback` and `http://[::1]:<port>/callback` only, so a crafted link cannot send a code to another service on the same port. A request that gives a parameter twice is refused. `HANDOFF_CALLBACK_PATH` names the path.

## [1.0.0-alpha.0] - Unreleased

The 1.0 line, for the new version of The Bridge. Published on the `alpha` tag; `latest` stays on 0.x. It does not keep the 0.x API: apps on 0.x keep working on 0.x.

### Changed

- **One setting: the issuer.** `createBridge({ issuer })` replaces `appId`, `apiBaseUrl` and `hostedUrl`. Every endpoint is read from the issuer's metadata, at version 2 of The Bridge's API, and every call is pinned to it.
- **Sign-in on your own pages, as steps.** `signIn.start` answers "done" or the next step (today, which workspace). Sign-up finishes from its email link on the same device, with PKCE. Forgot and set password, sign-out and switching workspace are on the client.
- **Sessions across tabs.** The access token stays in memory; the refresh token is replaced on every use, and tabs take turns refreshing, so two tabs never spend the same one. A failed refresh says whether the session ended or The Bridge could not be reached.
- **Flag results only.** Flags are The Bridge's results over OFREP, revalidated with an ETag. No rules reach the browser, and nothing reads a role, a privilege or the plan.
- **Billing, team and live updates** use the new endpoints: the payer, checkout and the portal; members, invites and roles over REST; Live channels named by The Bridge, with history to fill gaps.
- **One error type.** `BridgeError` with a `kind`, for both problem details and OAuth errors.
- **`./server`** checks tokens against every lane of the app's revocation list, reads flag results for the caller, and counts usage ("count this").
- **`./testing`** has a fake issuer for your own tests.
- **Safe by default.** Addresses must be https (http only on localhost) and redirects are never followed. `bridge.fetch` sends the token only to the page's origin, The Bridge's endpoints and `tokenOrigins`. The server entry cannot be bundled for a browser. A client or server that could not reach the issuer at start keeps trying, and never needs a restart.

### Removed

- Hosted-page sign-in, the 0.x `BridgeAuth` class, browser usage reporting, the in-browser flag engine, the GraphQL team service, `BridgeManagement` and `./backend`. Magic links, passkeys, two-step codes and company sign-in return as sign-in steps when The Bridge offers them.

### Added

- **One checker for every token and key.** `createCredentialVerifier`, from the new `@nebulr-group/bridge-auth-core/verifier` entry, checks a person's access token, a background job's token, an API key or a short-lived token issued for a key, and returns one `Actor`: who is calling, for which app, in which workspace, with which privileges. A refused credential comes back with the reason, such as `expired`, `wrong_audience` or `unknown_app`. Tokens are checked by signature against your app's keys, with the algorithm pinned; keys are checked with The Bridge.
- **Access tokens only.** A token must be typed `at+jwt` and name the `audience` you configure; there is no default audience. ID tokens and other plain JWTs are refused.
- **Keys fetched once.** `createKeySet` holds your app's published keys, fetches them again only for a key id it does not hold or once they are 10 minutes old, never more often than every 30 seconds, and can be shared between checkers.
- **Runs at the edge.** The verifier entry uses only `fetch` and Web Crypto, so it loads in Next.js middleware and other edge runtimes as well as on Node and in the browser.
- **Who is calling comes only from the credential.** `verifyRequest` reads only the `Authorization: Bearer` and `x-api-key` headers. Other headers, the query string and the body never change who the caller is.
- **No silent revocation opt-out.** The verifier's `revocationCheck` option is required: pass a revocation check, or `'none'` to rely on tokens expiring.

## [0.8.0] - 2026-09-30

### Added

- **Limits on things that exist.** A plan limit can now be a gauge: `bridge.usage.set(metric, value)` tells Bridge how many of something currently exist, such as tickets or projects, and the number never resets with the billing period. Deleting one frees room again. Counters that add up each period, such as API calls, work exactly as before.
- **Seat limits counted from membership.** A quota snapshot now says when Bridge counts a limit from the workspace's members, so a seat limit your app names always shows the real member count, pending invites included, however people are added or removed.
- **A feature flag that is off says why.** Flag evaluation now returns the reason next to the value: not on the workspace's plan, not allowed for this person's role or privileges, or switched off. Your app can offer an upgrade for the first, point to an admin for the second and simply hide the feature for the third. When a rule has several conditions, the one that failed is reported.
- **Plans list the features they include.** A plan's list of included features feeds flag rules, so a rule can say "the plan includes this feature" without naming plans, and changing what a plan sells needs no change to the rule.
- **The same flag rules on the backend.** `claimsToAttributes` and `flattenBillingSnapshot` are exported, so a backend can evaluate rules about role, privileges, plan and plan features exactly as the browser does.
- **`UsageReporter` exported.** It can now be imported by name from the package root.

### Fixed

- **Role changes during a reconnect.** A role or permission change made while the app was reconnecting could be lost, leaving the person on their old role until they reloaded. Every connection now catches up, so the change always arrives live.
- **Billing status right after checkout.** Returning from a Stripe checkout often showed "Subscription unavailable" until a reload. Billing and quota reads now renew an out-of-date sign-in and retry, so the new plan shows straight away.
- **Privilege rules match whole names.** A rule on a privilege such as `REPORTS_VIEW` no longer also matches a longer one such as `REPORTS_VIEW_ALL`.

## [0.7.3] - 2026-09-26

### Fixed

- **Live updates and browser usage reporting in React, Next.js and Angular apps.** Live updates now connect, so plans, entitlements and usage counters refresh without a page reload, and usage reported from the browser is recorded. Previously the browser rejected these calls, so live updates never connected and browser-side usage reports were lost.
