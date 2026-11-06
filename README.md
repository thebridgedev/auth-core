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

### Forgot and reset password

```ts
await bridge.password.forgot(email);          // the answer is the same for any address
await bridge.password.set(link.token, newPassword); // from #bridge=reset-password&token=…
```

Setting a password signs nobody in, and ends every session of the account. Send the person to sign-in afterwards.

### Signing out and switching workspace

```ts
await bridge.signOut();                    // ends the session at The Bridge, in every tab
await bridge.workspaces.switch(workspaceId); // every tab follows
```

## The session

- The access token lives in memory only. The refresh token and ID token are kept in `localStorage`, under a key for your issuer. Pass `storage` to keep them elsewhere.
- The Bridge replaces the refresh token on every use. Tabs take turns: one tab refreshes and hands the new access token to the others, so two tabs never spend the same refresh token.
- A hidden tab does not keep a session alive. It refreshes when it is looked at again.
- When The Bridge cannot be reached, the session is kept and refreshed later. When the session ended (it expired, or was ended elsewhere), you get `signed-out` with the reason `session-ended`.

Events: `signed-in`, `signed-out`, `workspace-changed`, `session-stale`, `token-refreshed`, `notice`, `error`.

```ts
bridge.on('signed-out', ({ reason }) => goTo('/sign-in'));
```

## Calling your own API

`bridge.fetch` adds the person's access token, and after a 401 refreshes once and tries again:

```ts
const response = await bridge.fetch('/api/invoices');
```

## Flags

Every gate in your app is a flag. The flag's rule says why: a privilege, a plan feature or a rollout. The SDK fetches the results The Bridge worked out for this person, and never reads a role, a privilege or the plan itself.

```ts
if (bridge.flags.enabled('reports')) showReports();
const theme = bridge.flags.get('theme', 'light');
const { entitlement } = bridge.flags.reason('reports'); // the plan feature that would turn it on
bridge.flags.subscribe(() => render());
```

A flag The Bridge gave no result for returns your fallback. Results are fetched again when a flag changes, when the person or workspace changes, and after a plan change made through the SDK.

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
await bridge.team.invites.create({ email: 'new@acme.test', role: 'MEMBER' });
const roles = await bridge.team.roles.list({ assignable: true });
```

The Bridge decides what the person may do on every call. Use a flag to show a team admin's controls.

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
- **Usage** is counted only from servers. A batch that fails is sent again with the same ids, so nothing is counted twice. Call `bridge.usage.flush()` before a short-lived process ends.
- **Edge runtimes.** `./server` uses only `fetch` and Web Crypto.

The low-level checker is at `@nebulr-group/bridge-auth-core/verifier`.

## Signing in for a program on the same machine

A sign-in page can sign a person in for a command-line tool on their machine. The tool opens the page with its PKCE challenge and a loopback address. The page signs in with that challenge and sends the code back; only the tool can trade it for tokens.

```ts
import { readHandoffRequest, handoffReturnUrl } from '@nebulr-group/bridge-auth-core';

const request = readHandoffRequest(location.search); // refuses anything but http://127.0.0.1:<port> or http://[::1]:<port>
const step = await bridge.signIn.handoff({ email, password, codeChallenge: request.codeChallenge });
if (step.done) location.assign(handoffReturnUrl(request, step.code));
```

## Errors

Everything the SDK refuses is a `BridgeError`. Read `kind`:

| Kind | Means |
|---|---|
| `wrong-credentials` | Wrong email or password |
| `wrong-device`, `link-invalid` | An email link opened elsewhere, or used or expired |
| `flow-expired` | A sign-in step took too long |
| `signed-out`, `reauthenticate` | No session, or the action needs a recent sign-in |
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

`@nebulr-group/bridge-auth-core/testing` has a fake issuer in memory, with sign-in, sign-up links, refresh rotation, accounts, flags, billing and Live:

```ts
import { createFakeIssuer } from '@nebulr-group/bridge-auth-core/testing';

const fake = createFakeIssuer();
fake.addPerson({ email: 'a@acme.test', password: 'a long password', workspaces: [{ id: 'ws-1', name: 'Acme' }] });
const bridge = createBridge({ issuer: fake.issuer, fetch: fake.fetch, live: { websocket: fake.websocket } });
```

## Not in this alpha yet

Magic links, passkeys, two-step codes and company sign-in arrive as new sign-in steps; this version refuses them with `unsupported-step`. Invites at sign-in, public sign-in options and the redirect sign-in page come when the issuer offers them.

## License

MIT
