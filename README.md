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
if (!step.done && step.next === 'workspace') {
  // show step.workspaces (id, name, logo)
  await step.choose(chosenWorkspaceId);
}
// step.next === 'second_step': a code was texted to step.phone; step.verify(code)
// step.next === 'second_step_setup': ask for a mobile number; step.setUp(phone)
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

### Confirming it is you

Some actions want a recent sign-in (making a key, changing sign-in settings, removing a workspace). Called later, they fail with `reauthenticate`. Do not sign the person out: ask them to confirm it is them, then try again.

```ts
const result = await bridge.recheck.guard(
  () => createKey(form),            // the action, run again once after confirming
  () => askToConfirm(),             // your dialog: resolves once confirmed, rejects on cancel
);

// Inside the dialog, with a way the app offers (bridge.recheck.methods()):
await bridge.recheck.password(password);
await bridge.recheck.passkey();                 // only the person's own passkeys are offered
await bridge.recheck.email();                   // a link to their own address
await bridge.recheck.emailOpened({ signal });   // resolves when the link is opened in this browser
```

Each renews the session the person is in; its next token carries the new sign-in time. A link opened on the sign-in link page finishes as `{ done: true, rechecked: true }`: it makes no new session. Wrong passwords count as a sign-in's do.

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

### Plan limits and plan features

```ts
// A plan feature is the flag `bridge:billing.entitlement.<key>`; it never reads the plan.
if (bridge.entitlements.can('ai_completions')) showAi();

// A limit: the first call starts reading and returns undefined; subscribe to redraw when it arrives.
const quota = bridge.quota('projects');  // { used, limit, remaining, percent_used, policy, kind, warningLevel, … }
bridge.quotas.subscribe((metric, snapshot) => redraw(metric, snapshot));
```

The numbers are read from The Bridge, never taken from a notice. Every metric a screen asked for is read again when Live says usage (`billing.quota_updated`) or the plan (`billing.access_changed`) changed. A metric the plan sets no limit on has no snapshot.

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

  // A person's token, or an API key (x-api-key) that Bridge evaluates for the key's privileges.
  // An app key can name the workspace whose plan applies: forRequest(request, {}, { workspace }).
  const flags = await bridge.flags.forRequest(request);
  if (!flags.enabled('exports')) return new Response(null, { status: 403 });

  bridge.usage.count(actor, 'exports.made'); // "count this", sent in batches
  bridge.usage.set(actor, 'projects', 4);    // a gauge: how many exist now
  // …
}

// A strict limit: hold a unit before the action, so two requests never get the last one.
try {
  const hold = await bridge.usage.hold(actor, 'projects', { decision: requestId });
  try {
    await createProject();
    await hold.confirm();
  } catch (error) {
    await hold.giveBack();
    throw error;
  }
} catch (error) {
  // A limit that is reached: 402, `error.quota` is { metric, limit, used }.
  if (isLimitReached(error)) return Response.json(quotaExceededBody(error), { status: 402 });
  throw error;
}
```

`bridge.usage.quota(actor, 'projects')` reads a metric's quota on the server: `{ used, limit, policy, … }`, or `null` when the plan sets no limit on it. A `metered` limit is never refused; the overage is billed.

- **Revocation.** Token checks follow your app's revocation list. A session that ended, a member who was removed or a key that was revoked is refused within seconds. While the list cannot be read, checks answer `unavailable`, never yes. For writes and sensitive actions, pass `{ strict: true }` for a tighter limit.
- **Writes in a workspace that is not in good standing.** When the request is a write (any method but `GET`, `HEAD` and `OPTIONS`; read from the `Request`, or pass `{ method }`) by a signed-in person, `check` and `verify` also look at the workspace. A workspace that is suspended or scheduled for deletion refuses with 403 (`workspace-not-active`, `error.problem.standing` says which); one locked for payment refuses with 402 (`billing-locked`); and while The Bridge cannot say, the write is refused with 503, never allowed. Reads always pass. The refusal is a `BridgeError` whose `problem` is the RFC 9457 body to send back. Keys are not affected.
- **Keys.** A request with `x-api-key` is checked as a key and becomes the same kind of Actor.
- **Flags for someone who is not signed in.** `bridge.flags.forVisitor(hints?)` gives what Bridge shows a visitor: the flags marked public, and nothing else, so any other flag gives its fallback. It sends no credential, your app key never speaks for a stranger, and `hints` are facts your server knows, never what the visitor said. Use it for a public route. An answer is kept per hints for `visitorFlagsTtlMs` (10 seconds by default; 0 asks every time), and while Bridge cannot answer every flag gives its fallback.
- **No roles in the Actor.** Gate with flags.
- **Usage** is counted only from servers. A batch that fails is sent again with the same ids, so nothing is counted twice. A batch The Bridge refuses as malformed is logged and dropped, so it never holds up the rest. While The Bridge cannot be reached, at most `maxQueuedReports` (10,000) wait; past that, the oldest are dropped and logged. Call `bridge.usage.flush()` before a short-lived process ends.
- **Flags found in code.** With `appKey`, a flag your server reads that The Bridge gave no result for is reported once per process, in the background, so it shows in the dashboard as found in code, switched off, until you set it up. The key needs the privilege `flags.discoveries:write`; without it the report is refused and nothing is made.
- **Usage that survives a crash.** Waiting reports are in memory by default, so a process that ends without `flush()` loses them. Give `createBridgeServer` a `usageStore` to keep them: `fileUsageQueue({ dir })` from `@nebulr-group/bridge-auth-core/server/node` writes a journal on disk, and any object with `load()`, `add(reports)` and `remove(ids)` works (a database, a volume). When the server starts it sends what waited, with the ids they were counted with: a report that went out just before the crash and goes out again counts once, because The Bridge counts each id once for 35 days. For that reason a report that has waited longer than `maxQueuedAgeMs` (30 days by default, never more than 34) is dropped and logged instead of sent. One process owns one directory. A store that fails is logged and counting goes on, as safe as memory. On a platform whose disk does not outlive the process (functions, a container without a volume), use a store that writes to something that does.
- **Start-up.** If the issuer cannot be reached at first, checks answer `unavailable` (503), flags give their fallbacks and usage waits, and the server keeps trying, waiting longer each time. It never needs a restart.
- **Never in a page.** The server entry holds your app key: a browser build of it fails at once, and `createBridgeServer` refuses to start in a browser with an app key.
- **Edge runtimes.** `./server` uses only `fetch` and Web Crypto.

The low-level checker is at `@nebulr-group/bridge-auth-core/verifier`.

### Managing Bridge from your server

`createBridgeManagement` is for your server's own code: provisioning workspaces, inviting people, setting roles and flags, reading events. It calls Bridge's API with your app key and keeps the names of the 0.8 management client.

```ts
import { createBridgeManagement } from '@nebulr-group/bridge-auth-core/server';

const mgmt = createBridgeManagement({ issuer: process.env.BRIDGE_ISSUER, appKey: process.env.BRIDGE_APP_KEY });

const workspace = await mgmt.workspaces.create({ name: 'Acme', owner: { email: 'ada@acme.test' } }); // 0.8: tenants.create
await mgmt.users.invite(workspace.id, { email: 'bob@acme.test', role: 'ADMIN' });
await mgmt.flags.toggle('beta-banner', true);
const events = await mgmt.events.query({ type: 'accounts.member_added', since: '24h' });
```

| Area | Calls |
|---|---|
| `workspaces` (also `tenants`) | `list`, `get`, `create`, `update`, `delete`, `restore`, `suspend`, `resume`, `setSubscription` |
| `users` | `list`, `get`, `invite`, `update`, `remove`, `deletionPreview` for one workspace; `find`, `suspend`, `resume` for a person of the app |
| `invites` | `list`, `send`, `cancel` for one workspace |
| `roles` | `list`, `create`, `update`, `delete`; `listPrivileges`, `createPrivilege`, `updatePrivilege`, `deletePrivilege` |
| `flags` | `list`, `get`, `create`, `update`, `toggle`, `delete`, `kill`, `restore`; segments (flag groups): `listSegments`, `createSegment`, `updateSegment`, `deleteSegment`; `export`, `import` |
| `plans` | `list`, `get`, `create`, `update`, `replace`, `delete`, `archive` |
| `events` | `query` (as 0.8), `list` (with the cursor for the next page) |
| `app` | `get`, `update`: the app's own record (redirect URIs, allowed origins, profile addresses), in 0.8's names |
| `branding` | `get`, `update`: how the app's hosted sign-in page looks (scheme, colors, radius, font, css); `getCss`, `updateCss`, `deleteCss` as in 0.8 |
| `onboarding` | `get`: how far the app's setup has come |
| `workflows` | `setupPayments`, `setupCommunication` |
| `request(method, area, path)` | Any other call on Bridge's version 2 API with your key |

What differs from 0.8:

- **Ids are Bridge's new ones.** A flag is named by its key, a plan by its key. `flags.update` and `updateSegment` read the current revision first (Bridge refuses a change made on an old one); name the revision you saw with `{ ifMatch }` to refuse a change someone else made in between. `flags.toggle(key, true)` keeps the flag's rule: a flag with a rule goes to `on-with-rule`, so the audience does not widen to everyone.
- **Plan prices are in minor units** (1999 is 19.99), one per currency and interval. `workflows.setupPayments` still takes a plan's `price` in whole units, as 0.8 did, and converts it.
- **`users.invite` adds the person at once and emails them**, as 0.8 did. Use `invites.send` for an invitation the person accepts.
- **Your app key does what its privileges allow.** A call it may not make is refused (403) by Bridge. The dashboard's privilege for the same action is the key's: `app.update` and `branding.update` need `apps.settings:manage` on the key, `onboarding.get` needs `accounts.members:read`; reads of the app and of the branding need none. `branding.update` is read first for the version Bridge asks for, unless you pass `{ ifMatch }`. `updateCss` is kept only as the sign-in page may draw it (paint, spacing and text; no `url()`, no selector on a field's value); anything else is refused with every reason. There is no call for the app's social-login credentials. **Keys cannot be made, listed or revoked with a key**, which differs from 0.8's `tokens`: a key that could make keys would defeat "every key expires" and "a key holds at most its maker's", so keys are made by people, in Bridge's dashboard or CLI.
- **Server only.** It refuses to start in a browser, since it holds the app key.

## Hosted mode: sign in on Bridge's page

Instead of building sign-in pages, the app can send people to the page Bridge hosts for it and get them back signed in. Register the page in the app's addresses first: its origin as a browser origin, and your return (for example `https://app.example.com/auth/callback`) as a sign-in return. `bridge.metadata().signInPage` is then set.

It is the authorization code flow with PKCE (RFC 7636): `hosted.start` makes the PKCE pair and a `state`, keeps them in this browser (in `signUpStorage`), and has Bridge hold the request (challenge, return, state) behind an id. The page signs the person in by any method the app offers and sends the browser back with `code`, `state` and `iss`; `hosted.finish` checks them and trades the code with the verifier and the same return. A sign-in link the page sends opens in any tab of this browser.

```ts
// The sign-in button:
location.assign(await bridge.hosted.start({ redirectUri: 'https://app.example.com/auth/callback' }));

// On https://app.example.com/auth/callback:
await bridge.hosted.finish(location.href); // refuses another state, another issuer, or a return this browser did not start
```

`hosted.start({ redirectUri, linkAddress })` also names where an email link sent on the way goes (default: Bridge's page). `page: 'sign-up'` opens the page on its sign-up form, and `plan` names the plan the new workspace starts on (`currency` and `interval` pick one of its prices).

When someone opens Bridge's page directly (a login or signup link, with no sign-in started by your app), the page sends the browser to your app's default sign-in return with `iss` set to your issuer, and `page=sign-up` and `plan` for a signup link. `initiatedSignIn(location.href, issuer)` recognises that address: start an ordinary `hosted.start` with its `page` and `plan`, and the person signs in once on the page and comes back with a code only your app can trade. Any other `iss` is not yours: ignore it.

```ts
const asked = initiatedSignIn(location.href, issuer);
if (asked) {
  location.replace(
    await bridge.hosted.start({
      redirectUri,
      page: asked.page,
      ...(asked.plan ? { plan: asked.plan } : {}),
      ...(asked.price ? { currency: asked.price.currency, interval: asked.price.interval } : {}),
    }),
  );
}
else await bridge.hosted.finish(location.href);
```

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
