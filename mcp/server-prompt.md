# Bridge on your own server — auth-core 1.0 (`/server`)

You are protecting a JavaScript server (Node, Bun, Deno, an edge function; Express, Hono, Fastify, Next.js route handlers, plain `fetch` handlers) with **The Bridge**. Use `@nebulr-group/bridge-auth-core/server`. For a NestJS app use `@nebulr-group/bridge-nestjs@alpha` instead (`bridge guide nestjs`), which wraps the same checks in guards and decorators.

**The server enforces; the browser shows or hides.** Whatever the browser gates with a flag or a plan limit, the endpoint behind it checks again here, so a direct call with curl gets the same answer as the page.

Read how roles, plans, limits and flags fit together before setting any of them up: `bridge guide fit-together` (MCP `get_integration_guide topic=fit-together`).

## 1. Install and settings

```bash
npm install @nebulr-group/bridge-auth-core@alpha
```

| Setting | What | Where it comes from |
|---|---|---|
| `BRIDGE_ISSUER` | The app's issuer, the same one the browser uses | `bridge app get` (or the `.env` `bridge app setup` wrote); MCP `get_environment_info` |
| `BRIDGE_APP_KEY` | The app's secret key, for counting usage, reading limits and server-side flag discovery. Server only, never in a browser bundle | `bridge key create --name server --privilege <privilege>` (made by a person; a key cannot make keys) |

There is no API base URL setting. Everything is read from the issuer's metadata.

```ts
// server/bridge-server.ts
import { createBridgeServer } from '@nebulr-group/bridge-auth-core/server';

export const bridge = createBridgeServer({ issuer: process.env.BRIDGE_ISSUER!, appKey: process.env.BRIDGE_APP_KEY });
```

One instance per process. It refuses to start in a browser with an app key, and a browser build of `./server` fails.

## 2. Check who calls

```ts
import { isBridgeError } from '@nebulr-group/bridge-auth-core/server';

export async function handle(request: Request): Promise<Response> {
  let actor;
  try {
    actor = await bridge.verify(request); // Authorization: Bearer <token>, or x-api-key
  } catch (error) {
    if (isBridgeError(error)) return Response.json(error.problem ?? { title: error.message }, { status: error.status ?? 401 });
    throw error;
  }
  // actor: { kind, id, personId, workspaceId, sessionId, appId, standing }
}
```

- `verify` throws a `BridgeError`: 401 for no or a bad credential, 503 while Bridge cannot be checked. A check that could not be made is never a yes.
- `bridge.check(request)` is the same without throwing: `{ ok: true, actor }` or `{ ok: false, error }`.
- **Revocation within seconds.** The server follows the app's revocation list: an ended session, a removed member or a revoked key is refused within seconds. For writes and sensitive actions pass `{ strict: true }` for a tighter limit (`strictLagMs`, 30 s by default).
- **Writes in a workspace not in good standing.** For a write (any method but GET, HEAD, OPTIONS) by a signed-in person, a suspended workspace is refused with 403 (`workspace-not-active`) and one locked for payment with 402 (`billing-locked`); `error.problem` is the RFC 9457 body to send back. Pass `{ method }` when your request object has none.
- **No roles in the Actor.** Gate with flags, never with a role or privilege list.
- `actor.workspaceId` scopes the data the request may touch. Record-level permission ("only the author edits it") stays in your code.

The low-level token checker is `@nebulr-group/bridge-auth-core/verifier`; you rarely need it.

## 3. Flags on the server

Every gate is a flag, on the server too. The flag's rule says why: a privilege, a plan feature (`bridge:billing.entitlement.<key>`) or a rollout.

```ts
const flags = await bridge.flags.forRequest(request);
if (!flags.enabled('exports')) return new Response(null, { status: 403 });
const limit = flags.get('export-rows', 1000);
```

- `forRequest` sends the caller's own credential and Bridge works out the results for it: rules on the person, the workspace, its plan and the key's privileges apply. A request with no credential, or one Bridge refuses or cannot answer, gets an empty set: every flag gives its fallback (gates fail closed).
- An app key acting for a workspace names it: `bridge.flags.forRequest(request, {}, { workspace })`.
- A public route (no one signed in): `bridge.flags.forVisitor(hints?)` gives only the flags marked public (`bridge flag create <key> --public`); `hints` are facts your server knows.
- A flag the plan does not include: `flags.reason('exports').entitlement` names the plan feature, so you can answer with an upgrade offer.

**How the server stays current.** It asks Bridge on each request, with the caller's credential, so a flag changed in the dashboard or with `bridge flag on|off|update` applies to the next request: there is nothing to refresh and no restart. `forVisitor` keeps an answer for `visitorFlagsTtlMs` (10 s by default; 0 asks every time). Browsers follow changes live (Live `flags.revision_changed`). Bridge sends no webhook when a flag changes, so do not build one: ask per request on the server, and let the browser client's Live updates redraw the page.

With `appKey`, a flag your code reads that Bridge has no result for is reported once per process and shows in the dashboard as found in code, switched off (the key needs `flags.discoveries:write`).

## 4. Plan limits and usage

Numbers are plan limits, not flags. The developer sets them on the plan (`bridge plan limit set <plan> <limit>` or `bridge plan create … --limit`; MCP `set_plan_quota`). Metric names are lower case and dot-separated (`projects`, `exports.made`).

**Refuse over the limit on the handler that creates the thing.** Hold a unit first, so two requests never both get the last one:

```ts
import { isLimitReached, quotaExceededBody } from '@nebulr-group/bridge-auth-core/server';

try {
  const hold = await bridge.usage.hold(actor, 'projects', { decision: requestId });
  try {
    const project = await createProject();
    await hold.confirm();
    return Response.json(project, { status: 201 });
  } catch (error) {
    await hold.giveBack();
    throw error;
  }
} catch (error) {
  if (isLimitReached(error)) return Response.json(quotaExceededBody(error), { status: 402 }); // error.quota: { metric, limit, used }
  throw error; // Bridge unreachable: the limit could not be checked, so it is refused
}
```

- Count what happened ("count this"): `bridge.usage.count(actor, 'exports.made')`, sent in batches; a retried batch never counts twice.
- A gauge (how many exist now): `bridge.usage.set(actor, 'projects', 4)`.
- Read the limit and use on the server: `await bridge.usage.quota(actor, 'projects')` gives `{ used, limit, policy, … }`, or `null` when the plan sets no limit.
- A `metered` limit is never refused; the overage is billed.
- Short-lived processes call `await bridge.usage.flush()` before ending; `bridge.close()` flushes and stops. To survive a crash, pass `usageStore: fileUsageQueue({ dir })` from `@nebulr-group/bridge-auth-core/server/node`.

All of this needs `appKey`. The workspace whose plan applies is `actor.workspaceId`, or pass `{ workspace }`.

**Reading the workspace's plan on the server** is for showing or logging only. Whether something is open is a flag; how much is a limit. There is no payments code on the server: checkout runs in the browser client (`billing.choosePlan` on `createBridge`).

## 5. Managing Bridge from your server

`createBridgeManagement({ issuer, appKey })` from the same entry provisions workspaces, invites people and sets flags from your server's own code (`mgmt.workspaces.create`, `mgmt.users.invite`, `mgmt.flags.toggle`, `mgmt.events.query`). It does only what the key's privileges allow. Keys are never made with a key.

## 6. Verify

Run the terminal checks. If you have a browser tool, run the browser checks too. If you do not, list them for the developer, numbered, and start the summary with a Heads up line saying which checks were not run.

### Terminal checks

1. The server builds and its tests pass.
2. `npx @nebulr-group/bridge-cli@alpha check gates`: nothing listed.
3. Call a protected endpoint with no token: 401. With a signed-in person's token: 200.
4. `bridge flag off <key>`, call the flagged endpoint: refused; `bridge flag on <key>`: allowed on the next call.
5. `bridge plan list` shows the limit; call the creating handler up to the limit, then once more: 402 with the plan-limit body (`limit-reached`).
6. `bridge flag get <key>`: the rule names the privilege or plan feature you meant.

### Browser checks

1. Signed in in the app, the gated page and the endpoint agree: both open, or both closed.
2. At the limit, the app shows the upgrade offer from the 402 answer.

Heads up: not verified in a browser — when you could not run the browser checks, say exactly that on the first line of your summary, then which ones the developer must run.
