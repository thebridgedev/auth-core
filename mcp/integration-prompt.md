# Bridge for any JavaScript app — auth-core 1.0 (browser client)

You are adding **The Bridge** to a JavaScript app that has no 1.0 framework plugin of its own (React, Vue, Angular, Next.js, plain TypeScript, anything that runs in a browser). Use `@nebulr-group/bridge-auth-core`, the client every 1.0 plugin builds on. For SvelteKit use `@nebulr-group/bridge-svelte@alpha` instead (`bridge guide svelte`), for a NestJS backend `@nebulr-group/bridge-nestjs@alpha` (`bridge guide nestjs`). For your own server's token checks, read the server guide: `bridge guide javascript server`, or `get_integration_guide topic=server framework=javascript`.

Before setting up flags, roles, plans or limits, read how they fit together: `bridge guide fit-together` (MCP: `get_integration_guide topic=fit-together`).

## The one rule for app code

**Every gate in app code is a flag.** A link, a page, a button, an endpoint: if some people get it and others do not, the code asks a flag, and the flag's rule says why: a privilege (`privileges contains "users:write"`), a plan feature (`bridge:billing.entitlement.analytics eq true`) or a rollout. App code never reads a role, a privilege list, the plan or a plan feature to decide what someone may see or do.

Two things are not flags: **numbers** are plan limits (`bridge.quota(metric)` in the browser, a usage hold on the server), and **permission on one specific record** stays in app code ("only the author edits their post").

The server enforces, with the backend plugin or `@nebulr-group/bridge-auth-core/server`; the browser shows or hides. Gate the page in the browser **and** the endpoint on the server with the same flag.

Before calling the work done, run `npx @nebulr-group/bridge-cli@alpha check gates` in the project and fix what it lists.

## 1. Install (1.0 is in alpha)

```bash
npm install @nebulr-group/bridge-auth-core@alpha
```

Always the `alpha` tag while 1.0 is in alpha. The 0.x packages on `latest` talk to the old Bridge API and fail against this Bridge.

## 2. One setting: the issuer

The client needs one address, the app's **issuer**. Everything else (endpoints, the audience, Live) is read from the issuer's published metadata. There is no API base URL and no app id setting.

Get the issuer and register the app's development address in one step:

```bash
npx @nebulr-group/bridge-cli@alpha app setup --url http://localhost:5173 --auth-path /auth --var VITE_BRIDGE_ISSUER
```

`bridge app setup` writes the issuer into `.env` under the variable you name (default `PUBLIC_BRIDGE_ISSUER`; use the prefix your bundler exposes to the browser, such as `VITE_` or `NEXT_PUBLIC_`), and adds your dev origin as a browser origin and `<url>/auth` as the email-links page. With the MCP: `get_environment_info` gives the `issuer`; `update_app` sets `allowedOrigins` and `uiUrl`.

Make **one** client per page and share it:

```ts
// src/lib/bridge-client.ts
import { createBridge } from '@nebulr-group/bridge-auth-core';

export const bridge = createBridge({ issuer: import.meta.env.VITE_BRIDGE_ISSUER });
```

`bridge.ready` resolves once the metadata is read and a stored session restored. If your API is on another host than the page, list it: `createBridge({ issuer, tokenOrigins: ['https://api.example.com'] })`; `bridge.fetch` refuses to send the token anywhere else.

## 3. The app's addresses

Every address Bridge sends a browser to must be registered. Add each one; never replace the list.

| What | CLI 1.0 | MCP |
|---|---|---|
| The page origin (passkeys, `bridge.fetch`, Live) | `bridge app address add http://localhost:5173 --use browser-origin` | `update_app` allowedOrigins |
| Where email links land (sign-up, reset, invites, magic links) | `bridge app address add http://localhost:5173/auth --use email-links` | `update_app` uiUrl |
| A social or hosted sign-in return | `bridge app address add http://localhost:5173/auth/callback --use sign-in-return` | `add_redirect_uri` |
| Where payers return after checkout | `bridge app address add http://localhost:5173/billing --use checkout-return` | `update_app` checkoutReturnUrl |

`bridge app address list` shows them. Add the production addresses the same way before going live (`bridge guide decision going-live`).

## 4. Sign-in in the app's own pages

Sign-in is a conversation: send what the person typed; Bridge answers done, or names the next step.

```ts
const options = await bridge.signIn.options(); // { signUp, methods: ['password', 'magicLink', …], app: { name, logo, … } }

const step = await bridge.signIn.start({ email, password });
if (!step.done && step.next === 'workspace') await step.choose(workspaceId); // step.workspaces: id, name, logo
// step.next === 'second_step': a code was sent; step.verify(code)
// step.next === 'second_step_setup': ask for a mobile number; step.setUp(phone)
```

Show only the methods `options.methods` lists. A wrong email and a wrong password both fail with `wrong-credentials`.

**Sign-up** creates nothing until the address is proved:

```ts
await bridge.signUp.start({ email, password, firstName, workspace: 'Acme' }); // then show "check your email"
```

**Your email-links page** (the `email-links` address, e.g. `/auth`) finishes every link Bridge emails. The token is in the fragment; `takeEmailLink` reads it and clears it from the address bar:

```ts
import { takeEmailLink } from '@nebulr-group/bridge-auth-core';

const link = takeEmailLink();
if (link?.kind === 'verify-email') await bridge.signUp.finish(link.token);
if (link?.kind === 'magic-link') await bridge.magicLink.finish(link.token);
if (link?.kind === 'reset-password') await bridge.password.set(link.token, newPassword); // then send them to sign in
if (link?.kind === 'invite') {
  const preview = await bridge.invites.preview(link.token); // { state: 'open', workspace, account } or revoked/used/expired
  // no account: bridge.invites.signUp({ token: link.token, password, firstName, lastName })
  // an account: sign in, then bridge.invites.accept(link.token)
}
```

A link opened on another device fails with `wrong-device`; it still works where it was asked for.

**Other methods** (only when `options.methods` offers them):
- Magic links: `bridge.magicLink.start(email)`.
- Passkeys: `await bridge.passkeys.supported()`, then `bridge.passkeys.signIn()`; a signed-in person adds one with `bridge.passkeys.add(name)`.
- Social: `location.assign(await bridge.social.start('google'))`; on the return page `const back = takeSocialReturn(); if (back) await bridge.social.finish(back);` (import `takeSocialReturn` from the package; the return page is a `sign-in-return` address).
- Forgot password: `bridge.password.forgot(email)`.

Which methods are on is the developer's decision (`bridge guide decision login`); switch them with `bridge auth methods enable <method>` / `disable <method>` (MCP `update_auth_methods`).

**Bridge's hosted page instead** (only if the developer asks for it): `location.assign(await bridge.hosted.start({ redirectUri }))`, and on that return `await bridge.hosted.finish(location.href)`; `redirectUri` is a `sign-in-return` address.

## 5. The session, sign-out, workspaces

```ts
bridge.session.subscribe((s) => render(s)); // { status: 'loading' | 'signed-out' | 'signed-in', user, workspace }
bridge.on('signed-out', ({ reason }) => goTo('/sign-in')); // 'session-ended', 'access-removed', …
await bridge.signOut();                      // here, in every tab, and at Bridge
await bridge.workspaces.switch(workspaceId); // every tab follows
const response = await bridge.fetch('/api/projects'); // adds the token, refreshes once after a 401
```

The access token lives in memory; refresh and ID tokens in `localStorage` (pass `storage` to change that). Never read tokens by hand; call your API with `bridge.fetch`.

## 6. Flags

```ts
if (bridge.flags.enabled('reports')) showReportsLink();
const theme = bridge.flags.get('theme', 'light');          // value flags: string, number, JSON
const { entitlement } = bridge.flags.reason('reports');      // the plan feature that would turn it on: offer an upgrade
const stop = bridge.flags.subscribe(() => render());         // results change live
```

A flag Bridge gave no result for gives your fallback. Results are fetched again when a flag changes (Live `flags.revision_changed`), when the person, workspace or session changes, and after a plan change. Create the flag and its rule with the developer's answer to "who should see it": `bridge flag create <key> --when "<attribute> <operator> <value>"` (MCP `create_feature_flag`); read `bridge guide flags` for the rule language.

## 7. Plans, checkout and plan limits

Prices, trials and limits are the developer's decisions (`bridge guide decision payments`). Create plans with `bridge plan create <key> --name <name> --price "<amount> <CURRENCY>/<interval>" --trial-days <n>` (MCP `apply_plan`), connect Stripe with `bridge stripe connect` (MCP `connect_stripe`).

```ts
import { billingNotice, readCheckoutReturn } from '@nebulr-group/bridge-auth-core';

const plans = await bridge.billing.plans();
const change = await bridge.billing.choosePlan({ plan: 'pro', currency: 'eur', interval: 'month' });
if (change.status === 'payment_required') location.assign(change.checkout.url);

// on the checkout-return page:
const back = readCheckoutReturn(location.href);
if (back) await bridge.billing.confirmCheckout(back.session);

const facts = await bridge.billing.state();  // plan, status, limits, usage, trial end
const notice = billingNotice(facts);          // the one notice worth showing, or null
location.assign((await bridge.billing.portal()).url);
```

A plan feature is a flag: `bridge.entitlements.can('ai_completions')` reads `bridge:billing.entitlement.ai_completions`. Gate the feature on a flag whose rule names it, not on the plan.

A plan limit is a number the browser shows:

```ts
const quota = bridge.quota('projects'); // undefined on the first call; then { used, limit, remaining, warningLevel, … }
bridge.quotas.subscribe((metric, snapshot) => redraw(metric, snapshot));
if (bridge.isLocked()) disableWriteButtons(); // the workspace is locked for payment
```

The server refuses over the limit (a usage hold, in the server guide); the browser shows the numbers and hides or disables the button.

## 8. Team

```ts
const members = await bridge.team.members.list();
await bridge.team.invites.create({ email: 'new@acme.test', role: 'MEMBER' });
const roles = await bridge.team.roles.list({ assignable: true });
```

Bridge checks every call. Show the team admin's controls behind a flag (privilege rule). Invites need an `email-links` address.

## 9. Live updates

```ts
bridge.live.on('accounts.member_updated', () => reloadMembers());
bridge.live.status.subscribe((status) => {}); // 'connecting' | 'open' | 'polling' | 'off' | 'closed'
```

A notice says what changed, never the data: read it again. Flags, quotas and the session already follow Live by themselves.

## 10. Verify

Run the terminal checks. If you have a browser tool, run the browser checks too. If you do not, list them for the developer, numbered, and start the summary with a Heads up line saying which checks were not run.

### Terminal checks

1. The app builds (`npm run build`) and its tests pass.
2. `npx @nebulr-group/bridge-cli@alpha check gates`: nothing listed.
3. `bridge app address list`: the browser origin, the email-links page and any sign-in or checkout return are there.
4. `bridge flag get <key>` for each flag the app reads: it exists and its rule names the privilege or plan feature you meant.
5. When the app sells plans: `bridge plan list` (plans, prices, trials, features) and `bridge stripe status`.
6. With a backend: call a gated endpoint without a token (refused) and over the limit (402, the plan-limit body).

### Browser checks

1. Sign up with a new address, open the verification email, land signed in.
2. Sign out, sign in again; reload: still signed in.
3. A flagged link or page shows for someone the rule includes and is hidden for someone it does not.
4. When the app sells plans: the plan page lists the plans; a paid plan opens Stripe Checkout; a test payment returns to the app on the new plan; a cancelled checkout returns unchanged.
5. At a plan limit, the button is disabled or the upgrade offer shows.

Heads up: not verified in a browser — when you could not run the browser checks, say exactly that on the first line of your summary, then which ones the developer must run. Give the success message (`bridge guide integration-success`) only when every check passed.
