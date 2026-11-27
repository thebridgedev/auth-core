# Acme: an MCP endpoint and a CLI, protected by The Bridge

A plain Node app with three things a developer usually wants:

- **`POST /mcp`**: an MCP endpoint (streamable HTTP, the official [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)) with one tool, `whoami`. The guard in MCP mode stands in front of it: an assistant without a token is told where to sign in, and the tool gets the person's user, workspace and privileges.
- **`GET /api/invoices`**: an ordinary API route behind the normal guard. It never accepts an assistant's token.
- **`acme`**: the app's own CLI (`acme login`, `acme whoami`, `acme invoices list`, `acme mcp whoami`, `acme logout`), signed in with the CLI helper.

## Run it (under five minutes)

You need Node 22.14 or later, and a Bridge app: its **issuer** is on the app's page in the dashboard (for a local stack, `http://localhost:3000/identity-access/apps/<app id>`). The app must be in development mode for an assistant to connect to `http://localhost`.

```sh
# 1. Build auth-core and install the example (from the auth-core repository)
npm install && npm run build
cd examples/mcp-cli-node && npm install

# 2. Start Acme
export BRIDGE_ISSUER=http://localhost:3000/identity-access/apps/<app id>
npm start                      # PORT=4000, RESOURCE=http://localhost:4000/mcp by default

# 3. In another terminal, the CLI
export BRIDGE_ISSUER=http://localhost:3000/identity-access/apps/<app id>
node cli.mjs login             # opens the browser; `login --code` for a short code (when the app allows them)
node cli.mjs whoami
node cli.mjs invoices list     # the API, with the CLI's token
node cli.mjs mcp whoami        # the MCP tool, with the CLI's own token
node cli.mjs logout
```

## Connect an assistant

```sh
claude mcp add --transport http acme http://localhost:4000/mcp
```

Claude Code finds the sign-in address in the endpoint's metadata, opens the app's sign-in page, and asks the person to approve. Then ask it "who am I in Acme?": the `whoami` tool answers with the person's user, workspace and privileges.

In development only assistants on your own machine can reach a `localhost` endpoint. Claude on the web, and any other assistant that runs in the cloud, needs the endpoint on an https address it can reach.

## Settings

| Variable | Means | Default |
|---|---|---|
| `BRIDGE_ISSUER` | The app's issuer | required |
| `PORT` | Where Acme listens | `4000` |
| `RESOURCE` | The MCP endpoint's address, exactly as assistants are given it | `http://localhost:$PORT/mcp` |
| `ACME_URL` | Where the CLI finds Acme | `http://localhost:$PORT` |
| `BRIDGE_TOKEN_STORE` | `file` to keep the CLI's tokens in `~/.config/acme/sessions.json` instead of the keychain | the keychain when there is one |

## What to look at

- `app.mjs`: the guard in MCP mode (`bridgeMcpGuard` + `bridgeMcpMiddleware`) in front of `/mcp`, the tool reading `extra.authInfo.extra.caller`, and the normal guard (`createBridgeServer().check`) on the API.
- `cli.mjs`: `createBridgeCli({ issuer, name: 'acme' })` and its `login`, `whoami`, `fetch`, `getAccessToken` and `logout`.

The auth-core test `src/__tests__/examples/mcp-cli-node.test.ts` runs this app against a fake issuer.
