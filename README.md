# @nebulr-group/bridge-auth-core

The Bridge client core. It signs people in on your own pages, keeps their session fresh across tabs, and gives you their workspaces and team. It reads flag results, shows billing, and listens for live updates. On your server, it checks the tokens your API is called with, honouring revocation within seconds, and counts usage.

This is the **1.0 alpha** line, for the new version of The Bridge. It is published on the `alpha` tag; `latest` stays on 0.x until 1.0.0. Framework plugins (`@nebulr-group/bridge-svelte` and others) build on it, so you usually use it through one of them.

```bash
npm install @nebulr-group/bridge-auth-core@alpha
```

## One setting: the issuer

Copy your app's **issuer** from its settings in The Bridge. It is the only address the SDK needs. Every endpoint is read from the issuer's published metadata, at version 2 of The Bridge's API, so the SDK never builds an address itself.

```ts
import { createBridge } from '@nebulr-group/bridge-auth-core';

const bridge = createBridge({ issuer: import.meta.env.PUBLIC_BRIDGE_ISSUER });
await bridge.ready; // the metadata is read and any stored session restored

bridge.session.subscribe((session) => {
  // { status: 'loading' | 'signed-out' | 'signed-in', user, workspace }
});
```

Make one client per page and share it.

The issuer and every address it lists must be `https` (plain `http` only on `localhost`, for development), and the SDK never follows a redirect. If the issuer cannot be reached at first, `ready` rejects with the reason, and the client keeps trying in the background: the session leaves `loading` and the `ready` event fires once it starts. Calls made meanwhile try again at once, and fail with the reason if Bridge is still unreachable.

## Signing in

Sign-in is a short conversation: you send what the person typed, and The Bridge answers "done", or asks for the next step, such as which workspace.

```ts
const step = await bridge.signIn.start({ email, password });
if (!step.done) {
  // step.next === 'workspace': show step.workspaces (id, name, logo)
  await step.choose(chosenWorkspaceId);
}
```

A wrong email and a wrong password give the same error, `wrong-credentials`, so nobody learns which addresses have an account.

### Signing up

Nothing is created until the address is proved. The Bridge emails a link, and the person finishes on the **same device**:

```ts
await bridge.signUp.start({ email, password, firstName, workspace: 'Acme' });
// show "check your email"
```

The link lands on your page with the token in the address's fragment (`#bridge=verify-email&token=…`). Finish there:

```ts
import { readEmailLink } from '@nebulr-group/bridge-auth-core';

const link = readEmailLink(location.hash);
if (link?.kind === 'verify-email') {
  const step = await bridge.signUp.finish(link.token); // signed in, or the workspace step
}
```

Opened on another device, `finish` fails with `wrong-device`, and the link still works on the device that started the sign-up.

### Sign-in links (magic links)

When the app offers them (`'magicLink'` in `signIn.options().methods`), a person can sign in with a link sent to their email. The answer is the same whether or not the address has an account:

```ts
await bridge.magicLink.start(email);
// show "check your email"
```

The link lands on your page as `#bridge=magic-link&token=…`. Finish there, in the browser that asked:

```ts
const link = takeEmailLink('magic-link');
if (link) {
  const step = await bridge.magicLink.finish(link.token); // signed in, or the workspace step
}
```

Each link works once, for 15 minutes. Opened on another device, `finish` fails with `wrong-device`, and the link still works on the device that asked; used again, `link-invalid`. The PKCE verifier waits in `signUpStorage` until the link is opened, at most as long as the link works, and nothing else is kept there.

### Passkeys

When the app offers them (`'passkeys'` in `signIn.options().methods`) and the browser can use them (`await bridge.passkeys.supported()`), a person signs in with Face ID, Touch ID, Windows Hello, a phone or a security key. Bridge accepts a ceremony only from a page address listed among the app's browser addresses, always asks for the person's fingerprint, face or PIN, and keeps only the passkey's public key.

```ts
const step = await bridge.passkeys.signIn();                 // the browser's dialog; any of the person's passkeys
await bridge.passkeys.signIn({ email });                     // only that address's passkey
await bridge.passkeys.signIn({ autofill: true });            // waits for a pick from an <input autocomplete="username webauthn">
```

Signed in, recently (otherwise `reauthenticate`):

```ts
await bridge.passkeys.add('Work laptop');   // from this device; one it has already fails with `conflict`
await bridge.passkeys.list();               // name, added, last used, whether it syncs
await bridge.passkeys.remove(id);           // never the last way to sign in (`conflict`, code `last_sign_in_method`)
```

A setup link is the way to a first passkey, or back in. It lands as `#bridge=passkey-setup&token=…`, works once, for 24 hours, only in the browser that asked; its PKCE verifier waits in `signUpStorage` that long at most. Start `finish` on a click: Safari opens the dialog only then.

```ts
await bridge.passkeys.setupLink.request(email);          // the same answer for any address
const step = await bridge.passkeys.setupLink.finish(takeEmailLink('passkey-setup')!.token);
```

A closed dialog fails with `cancelled`, a browser without passkeys with `not-supported`, a passkey the app does not know with `wrong-credentials` (code `unknown_passkey`). The browser's side runs on `@simplewebauthn/browser`, loaded only when a passkey is used; pass `webauthn` to `createBridge` to replace it, and `fakeWebAuthn()` from `/testing` in tests.

### Forgot and reset password

```ts
await bridge.password.forgot(email);          // the answer is the same for any address
await bridge.password.set(link.token, newPassword); // from #bridge=reset-password&token=…
```

Setting a password signs nobody in, and ends every session of the account. Send the person to sign-in afterwards.

### Invites

An invite's email links to your email-links address with the token in the fragment (`#bridge=invite&token=…`). Take it, which also clears it from the address bar and the history, then show the invite:

```ts
import { takeEmailLink } from '@nebulr-group/bridge-auth-core';

const link = takeEmailLink('invite');
const preview = await bridge.invites.preview(link.token);
// { state: 'open', workspace: { name, logo }, account } or { state: 'revoked' | 'used' | 'expired' }
```

- **No account yet** (`account: false`): sign up from the invite. The link proves the address, so no second email is sent, and the person lands signed in, in the inviting workspace, with the invited role.

  ```ts
  await bridge.invites.signUp({ token: link.token, password, firstName, lastName });
  ```

- **An account already** (`account: true`): sign in as usual, then accept. The session moves into the workspace they joined.

  ```ts
  const { workspace } = await bridge.invites.accept(link.token);
  ```

Only the person the invite was sent to can accept it: anyone else gets `forbidden` (`code: 'invite_for_another_address'`). A link that no longer works gets `link-invalid` (`code` is `invite_revoked`, `invite_used` or `invite_expired`); a member already gets `conflict` (`already_member`), and a sign-up for an address with an account gets `conflict` (`account_exists`). An invite works for 30 days, and sending it again stops the old link working.

### Signing out and switching workspace

```ts
await bridge.signOut();                    // ends the session at The Bridge, in every tab
await bridge.workspaces.switch(workspaceId); // every tab follows
```

## The session

- The access token lives in memory only. The refresh token and ID token are kept in `localStorage`, under a key for your issuer. Pass `storage` to keep them elsewhere.
- The Bridge replaces the refresh token on every use. Tabs take turns: one tab refreshes and hands the new access token to the others, so two tabs never spend the same refresh token.
- A hidden tab does not keep a session alive. It refreshes when it is looked at again.
- When The Bridge cannot be reached, the session is kept and refreshed later. When the session ended (it expired, or was ended elsewhere), you get `signed-out` with the reason `session-ended`. When The Bridge refuses to renew it because the person was removed from the workspace or suspended, the reason is `access-removed`: ask them to sign in again.
- Signing out always wins: a refresh still in flight in any tab is dropped, never adopted.

Events: `ready`, `signed-in`, `signed-out`, `workspace-changed`, `session-stale`, `token-refreshed`, `notice`, `error`.

```ts
bridge.on('signed-out', ({ reason }) => goTo('/sign-in'));
```

## Calling your own API

`bridge.fetch` adds the person's access token, and after a 401 refreshes once and tries again:

```ts
const response = await bridge.fetch('/api/invoices');
```

The token goes only to the page's own origin and The Bridge's endpoints. List your API's other hosts in `tokenOrigins` (`createBridge({ issuer, tokenOrigins: ['https://api.example.com'] })`). Any other address is refused before anything is sent, so the token never reaches a third party.

## Flags

Every gate in your app is a flag. The flag's rule says why: a privilege, a plan feature or a rollout. The SDK fetches the results The Bridge worked out for this person, and never reads a role, a privilege or the plan itself.

```ts
if (bridge.flags.enabled('reports')) showReports();
const theme = bridge.flags.get('theme', 'light');
const { entitlement } = bridge.flags.reason('reports'); // the plan feature that would turn it on
bridge.flags.subscribe(() => render());
```

A flag The Bridge gave no result for returns your fallback. Results are fetched again when a flag changes, when the person, workspace or session changes, and after a plan change made through the SDK. Results are only ever read for the person, workspace and session they were fetched for: while those change, every flag gives its fallback. If a reload fails, the results already held for the same person, workspace and session stay.

## Billing

```ts
const plans = await bridge.billing.plans();
const change = await bridge.billing.choosePlan({ plan: 'pro', currency: 'eur', interval: 'month' });
if (change.status === 'payment_required') location.assign(change.checkout.url);

// back from checkout:
const back = readCheckoutReturn(location.href);
if (back) await bridge.billing.confirmCheckout(back.session);

const facts = await bridge.billing.state();  // plan, status, access, limits, usage, trialEnd…
const notice = billingNotice(facts);          // the one notice worth showing, or null
const { url } = await bridge.billing.portal();
```

The facts are for showing. Whether a page or button is open is a flag, and so is whether the person may manage billing.

## Team

```ts
const me = await bridge.me.get();
const members = await bridge.team.members.list();
await bridge.team.invites.create({ email: 'new@acme.test', role: 'MEMBER' }); // or again, to send a new link
const open = await bridge.team.invites.list();
await bridge.team.invites.revoke(open[0].id);
const roles = await bridge.team.roles.list({ assignable: true });
```

The Bridge decides what the person may do on every call. Use a flag to show a team admin's controls. Sending an invite needs an email-links address in your app's settings: without one it is refused with `conflict`, and nothing is sent. A workspace can send 50 invites an hour and 200 a day; past that, `rate-limited`.

## Live updates

The client joins the channels The Bridge names for this person and hears when something changed. A notice never carries the data, only what changed, so fetch it again:

```ts
bridge.live.on('accounts.member_updated', () => reloadMembers());
bridge.live.status.subscribe((status) => {}); // 'connecting' | 'open' | 'polling' | 'off' | 'closed'
```

Missed notices are filled from history. Without a socket, the client polls.

## On your server

```ts
import { createBridgeServer } from '@nebulr-group/bridge-auth-core/server';

const bridge = createBridgeServer({ issuer: process.env.BRIDGE_ISSUER, appKey: process.env.BRIDGE_APP_KEY });

export async function handle(request: Request) {
  const actor = await bridge.verify(request); // throws BridgeError: 401, or 503 while The Bridge cannot be checked
  // actor: { kind, id, personId, workspaceId, sessionId, appId, standing }

  const flags = await bridge.flags.forRequest(request);
  if (!flags.enabled('exports')) return new Response(null, { status: 403 });

  bridge.usage.count(actor, 'exports.made'); // "count this", sent in batches
  // …
}
```

- **Revocation.** Token checks follow your app's revocation list. A session that ended, a member who was removed or a key that was revoked is refused within seconds. While the list cannot be read, checks answer `unavailable`, never yes. For writes and sensitive actions, pass `{ strict: true }` for a tighter limit.
- **Keys.** A request with `x-api-key` is checked as a key and becomes the same kind of Actor.
- **No roles in the Actor.** Gate with flags.
- **Usage** is counted only from servers. A batch that fails is sent again with the same ids, so nothing is counted twice. A batch The Bridge refuses as malformed is logged and dropped, so it never holds up the rest. While The Bridge cannot be reached, at most `maxQueuedReports` (10,000) wait; past that, the oldest are dropped and logged. Call `bridge.usage.flush()` before a short-lived process ends.
- **Start-up.** If the issuer cannot be reached at first, checks answer `unavailable` (503), flags give their fallbacks and usage waits, and the server keeps trying, waiting longer each time. It never needs a restart.
- **Never in a page.** The server entry holds your app key: a browser build of it fails at once, and `createBridgeServer` refuses to start in a browser with an app key.
- **Edge runtimes.** `./server` uses only `fetch` and Web Crypto.

The low-level checker is at `@nebulr-group/bridge-auth-core/verifier`.

## Hosted mode: sign in on Bridge's page

Instead of building sign-in pages, the app can send people to the page Bridge hosts for it and get them back signed in. Register the page in the app's addresses first: its origin as a browser origin, and your return (for example `https://app.example.com/auth/callback`) as a sign-in return. `bridge.metadata().signInPage` is then set.

It is the authorization code flow with PKCE (RFC 7636): `hosted.start` makes the PKCE pair and a `state`, keeps them in this browser (in `signUpStorage`), and has Bridge hold the request (challenge, return, state) behind an id. The page signs the person in by any method the app offers and sends the browser back with `code`, `state` and `iss`; `hosted.finish` checks them and trades the code with the verifier and the same return. A sign-in link the page sends opens in any tab of this browser.

```ts
// The sign-in button:
location.assign(await bridge.hosted.start({ redirectUri: 'https://app.example.com/auth/callback' }));

// On https://app.example.com/auth/callback:
await bridge.hosted.finish(location.href); // refuses another state, another issuer, or a return this browser did not start
```

`hosted.start({ redirectUri, linkAddress })` also names where an email link sent on the way goes (default: Bridge's page).

A page that signs people in for other apps, like Bridge's own, calls `bridge.request.use(id)` with the `request` from its address. Every sign-in step then sends the request instead of its own challenge, and a finished step is `{ done: true, handoff }`: send the browser to `handoff`. The page never holds the app's verifier.

## Which page an email's link opens

An app with several sign-in pages (its own and Bridge's hosted page, say) names which of its registered email-links addresses its emails link to: `createBridge({ linkAddress: 'https://app.example.com/auth' })`. Sign-up, sign-in link and recovery emails then link there. Bridge refuses an address the app did not register. Without it, the app's first email-links address.

## Signing in for a program on the same machine

A sign-in page can sign a person in for a command-line tool on their machine. The tool opens the page with its PKCE challenge and its loopback callback. The page signs in with that challenge and sends the code back with `state` and `iss` (the issuer, RFC 9207); only the tool can trade the code for tokens.

```ts
import { readHandoffRequest, handoffReturnUrl } from '@nebulr-group/bridge-auth-core';

const request = readHandoffRequest(location.search); // refuses anything but http://127.0.0.1:<port>/callback or http://[::1]:<port>/callback
const step = await bridge.signIn.handoff({ email, password, codeChallenge: request.codeChallenge });
if (step.done) location.assign(handoffReturnUrl(request, step.code, bridge.issuer));
```

## Errors

Everything the SDK refuses is a `BridgeError`. Read `kind`:

| Kind | Means |
|---|---|
| `wrong-credentials` | Wrong email or password |
| `wrong-device`, `link-invalid` | An email link opened elsewhere, or used or expired (an invite's too) |
| `flow-expired` | A sign-in step took too long |
| `signed-out`, `reauthenticate` | No session, or the action needs a recent sign-in |
| `misconfigured` | The SDK is set up wrongly: an address that is not https, a token for a host not in `tokenOrigins`, a redirect |
| `forbidden`, `not-found`, `conflict`, `invalid` | The request was refused |
| `plan-required` | The plan does not include it; `entitlement` names the feature |
| `rate-limited` | Try again after `retryAfterSeconds` |
| `unavailable`, `network` | The Bridge could not decide or be reached; never a yes |
| `origin-not-allowed` | This page's origin is not one of your app's browser addresses |
| `unsupported-step` | Sign-in asked for a step this version does not offer |
| `not-offered` | The issuer does not offer this yet |

## Words for the sign-in screens

`@nebulr-group/bridge-auth-core/i18n` has the copy the sign-in screens show, in 12 languages. Framework plugins use it, so their screens read the same.

## Testing

`@nebulr-group/bridge-auth-core/testing` has a fake issuer in memory, with sign-in, sign-up links, invites, refresh rotation, accounts, flags, billing and Live:

```ts
import { createFakeIssuer } from '@nebulr-group/bridge-auth-core/testing';

const fake = createFakeIssuer();
fake.addPerson({ email: 'a@acme.test', password: 'a long password', workspaces: [{ id: 'ws-1', name: 'Acme' }] });
const bridge = createBridge({ issuer: fake.issuer, fetch: fake.fetch, live: { websocket: fake.websocket } });
const token = fake.invite('b@acme.test', { id: 'ws-1', name: 'Acme' }); // or fake.lastLink('b@acme.test', 'invite')
```

## Not in this alpha yet

Magic links, passkeys, two-step codes and company sign-in arrive as new sign-in steps; this version refuses them with `unsupported-step`. The redirect sign-in page comes when the issuer offers it.

## License

MIT
