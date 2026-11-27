# An MCP endpoint and a CLI

Your app's users can reach it from an AI assistant (through your MCP endpoint) and from a terminal (through your own CLI). The Bridge signs them in for both. You add two things: the guard in MCP mode in front of the endpoint, and the CLI helper in your tool. Bridge builds no MCP server, no tools and no CLI: it protects and signs in.

A working example is in [`examples/mcp-cli-node`](../../examples/mcp-cli-node/README.md).

## Before you start

- Your app's **issuer**, from its page in the dashboard: `https://<bridge>/identity-access/apps/<app id>` (`http://localhost:3000/...` on a local stack). Keep it in an environment variable, such as `BRIDGE_ISSUER`.
- The MCP endpoint's **address**, exactly as you will give it to assistants, such as `https://acme.example/mcp`. Bridge accepts it as an assistant's `resource` when its origin is one of your app's browser addresses, when it is listed under Your app's extra MCP endpoints (other domains), or, for an app in development mode, when it is `http://localhost:<port>/...` or `http://127.0.0.1:<port>/...`.
- Node 22.14 or later.

```sh
npm install @nebulr-group/bridge-auth-core
```

## 1. Protect the MCP endpoint

```ts
import { bridgeMcpGuard } from '@nebulr-group/bridge-auth-core/server';
import { bridgeMcpMiddleware } from '@nebulr-group/bridge-auth-core/server/node';

const guard = bridgeMcpGuard({ issuer: process.env.BRIDGE_ISSUER!, resource: 'https://acme.example/mcp', resourceName: 'Acme' });
```

Then, in a Node `http` server or an Express-style app, put the middleware in front of the endpoint **and** of the well-known paths (mounting it app-wide is simplest):

```ts
app.use(bridgeMcpMiddleware(guard));   // Express
app.post('/mcp', mcpHandler);          // your MCP server, as before
```

What it does:

- `GET /.well-known/oauth-protected-resource/mcp` (and the plain `/.well-known/oauth-protected-resource`) answers with the endpoint's metadata (RFC 9728): `{ resource, authorization_servers: [issuer], bearer_methods_supported: ["header"], scopes_supported: ["offline_access"], resource_name }`. `guard.metadataPaths` lists the paths; `guard.metadata()` gives the document.
- A call without a valid token is answered **401** with `WWW-Authenticate: Bearer resource_metadata="https://acme.example/.well-known/oauth-protected-resource/mcp"` (and `error="invalid_token"` when a token came but was refused), so the assistant knows where to sign in. While Bridge cannot be checked the answer is **503**, never yes.
- Otherwise the call goes on with the caller on `req.bridge.caller`, and on `req.auth` for the official MCP SDK: a tool reads it as `extra.authInfo.extra.caller`.

```ts
server.registerTool('list_invoices', { description: 'The invoices of my workspace' }, async (extra) => {
  const caller = extra.authInfo!.extra!.caller as McpCaller;
  const invoices = await db.invoices.forWorkspace(caller.workspaceId);
  return { content: [{ type: 'text', text: JSON.stringify(invoices) }] };
});
```

The caller (`McpCaller`) holds, from the checked token only:

| Field | Means |
|---|---|
| `userId`, `email` | The person |
| `workspaceId`, `role` | Their workspace and role in it |
| `privileges` | Their own privileges in your app. An assistant holds no delete privilege unless the person ticked "Allow deleting" when they approved it |
| `mayDelete` | Whether deleting is allowed for this connection |
| `client` | `{ id, kind }`: `assistant` (connected to this endpoint; `id` is the assistant's client id, such as `claude`) or `app` (your own web app or CLI) |
| `sessionId`, `standing`, `expiresAt`, `actor` | The session, the workspace's standing, when the token expires, and the verifier's full answer |

Gate each tool the way you gate any endpoint: with a feature flag whose rule names the privilege, not by reading `privileges` yourself.

### Which tokens open it

- A token issued **for this endpoint** (its `aud` is the endpoint's address, exactly): an assistant's.
- Your app's **own** access tokens (its `aud` is your app's audience): your web app's and your CLI's. Turn this off with `acceptAppTokens: false`.
- Refused: a token for another endpoint, for another app, for Bridge's own MCP server, an expired one, and one whose session ended. The guard follows your app's revocation list, so a connection the person ended under Connected tools is refused within the list's lag (5 minutes at most by default; `maxLagMs`).

The rule runs one way. Your normal guard (`createBridgeServer({ issuer }).check(req)`) accepts only your app's own audience, so an assistant's token never opens your API. Don't widen it.

### Without Node's `http`

The guard is framework-neutral and runs at the edge too (it uses only `fetch` and Web Crypto):

```ts
const answer = await guard.check(request);            // a Fetch Request, Node's IncomingMessage, or { headers }
if (!answer.ok) return guard.refusalResponse(answer.refusal);   // or use answer.refusal.status, .headers, .body
answer.caller.userId;

// or wrap a Fetch handler; it serves the metadata paths itself
export default guard.protect((request, caller) => handleMcp(request, caller));
```

Express, NestJS and Next.js get their own wrappers when each is ported to 1.0. Until then use the middleware above (Express) or `guard.check` (any framework).

## 2. Sign in your CLI

```ts
import { createBridgeCli } from '@nebulr-group/bridge-auth-core/cli';

const auth = createBridgeCli({ issuer: process.env.BRIDGE_ISSUER!, name: 'acme' });

await auth.login();                   // `acme login`: the browser
await auth.login({ code: true });     // `acme login --code`: a short code typed on another device
const me = await auth.whoami();       // `acme whoami`: { email, userId, workspace, privileges, mayDelete, ... } or null
const res = await auth.fetch('https://acme.example/api/invoices');  // your API, with the token
await auth.logout();                  // `acme logout`
```

- **Browser sign-in** (the default) opens your app's hosted sign-in page, and the person approves "Sign in to Acme's command-line tool". The browser comes back to a one-time listener on `http://127.0.0.1:<port>/callback`; the helper checks `state` and the issuer before it trades the code, with PKCE.
- **Short code** (`code: true`, and on its own when no browser can be opened: over SSH, or a Linux machine without a display) needs short codes switched on in your app's sign-in settings (`tools.shortCode`). The person opens the address shown, enters the code, and approves. Without it, `login` says "This app does not allow sign-in with a short code. Sign in through the browser."
- **Tokens** are kept in the system keychain (macOS Keychain, the Secret Service on Linux) under the CLI's name and the issuer, else in `~/.config/<name>/sessions.json`, readable only by the user (0600 in a 0700 directory). `BRIDGE_TOKEN_STORE=file` forces the file. One session per issuer.
- **Renewal**: `getAccessToken()` and `fetch()` renew with the refresh token within a minute of expiry, one renewal at a time even across processes. A session that ended (signed out elsewhere, the connection ended under Connected tools) is forgotten, and the error says to run `<name> login`.
- The CLI's token is your app's own token: it opens your API and your MCP endpoint (handy for testing a tool from the terminal). By default it holds no delete privilege, unless the person ticked "Allow deleting" at approval.

Errors are `BridgeError`s: `kind` is `signed-out` (not signed in, or the session ended), `cancelled` (refused in the browser or when the code was entered), `flow-expired` (the code ran out or was used; the browser did not come back), `not-offered` (short codes off), `network` or `unavailable`.

## 3. Check it

1. Start your app, then `curl -i -X POST https://acme.example/mcp`: a 401 with `WWW-Authenticate: Bearer resource_metadata="…"`.
2. `curl https://acme.example/.well-known/oauth-protected-resource/mcp`: the document, naming your issuer.
3. Connect an assistant: `claude mcp add --transport http acme https://acme.example/mcp`, sign in, approve, and call a tool.
4. `acme login`, `acme whoami`, and a call to your API with the CLI.
5. Your API with an assistant's token: 401.

## In development

Bridge accepts `http://localhost:<port>/...` as an MCP endpoint only while your app is in development mode, and only assistants on your own machine (Claude Code, Claude Desktop) can reach it. Claude on the web and other assistants that run in the cloud cannot: give them the endpoint on an https address they can reach (a deployed environment, or a tunnel to your machine whose address is one of your app's browser addresses or is listed under Your app's extra MCP endpoints).
