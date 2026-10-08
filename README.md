<p align="center">
  <a href="https://thebridge.dev/?utm_source=readme&utm_medium=readme&utm_campaign=bridge-auth-core"><picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/thebridgedev/auth-core/main/.github/assets/banner.png"><img src="https://raw.githubusercontent.com/thebridgedev/auth-core/main/.github/assets/banner-light.png" alt="The Bridge auth core" width="100%"></picture></a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@nebulr-group/bridge-auth-core"><img src="https://img.shields.io/npm/v/@nebulr-group/bridge-auth-core?color=20006b&label=npm" alt="npm version"></a>
  <a href="https://github.com/thebridgedev/auth-core/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/@nebulr-group/bridge-auth-core?color=20006b" alt="MIT license"></a>
</p>

<p align="center">
  <a href="https://thebridge.dev/?utm_source=readme&utm_medium=readme&utm_campaign=bridge-auth-core"><b>Website</b></a> ·
  <a href="https://thebridge.dev/docs/getting-started/?utm_source=readme&utm_medium=readme&utm_campaign=bridge-auth-core"><b>Getting started</b></a> ·
  <a href="https://thebridge.dev/docs/?utm_source=readme&utm_medium=readme&utm_campaign=bridge-auth-core"><b>Docs</b></a> ·
  <a href="https://thebridge.dev/docs/ai-assistants/mcp/?utm_source=readme&utm_medium=readme&utm_campaign=bridge-auth-core"><b>Set up with your AI assistant</b></a>
</p>

# The Bridge auth core

`@nebulr-group/bridge-auth-core` is the framework-agnostic client behind every Bridge SDK: sign-in flows, sessions and token refresh, feature flags, billing state and the management API. Use it directly in any JavaScript app, or reach for the framework package that wraps it.

**[The Bridge](https://thebridge.dev/?utm_source=readme&utm_medium=readme&utm_campaign=bridge-auth-core)** is a hosted backend for SaaS apps. It gives you sign-in (passwords, magic links, passkeys, social login and SSO), multi-tenant workspaces with roles, Stripe subscriptions with plan limits, and feature flags, all managed from one dashboard. Your AI coding assistant can set it up for you through the [Bridge MCP server](https://thebridge.dev/docs/ai-assistants/mcp/?utm_source=readme&utm_medium=readme&utm_campaign=bridge-auth-core).

> **Let your AI assistant set it up.** Connect the [Bridge MCP server](https://thebridge.dev/docs/ai-assistants/mcp/?utm_source=readme&utm_medium=readme&utm_campaign=bridge-auth-core) to Claude, Cursor, Copilot or Gemini CLI and ask it to add Bridge to your app. Not using MCP? Run `npx @nebulr-group/bridge-cli guide add-login` in your project: it detects your framework from `package.json` and prints the steps for your assistant to follow. `npx @nebulr-group/bridge-cli doctor` checks the result.

## Install

```bash
npm install @nebulr-group/bridge-auth-core
```

## Sign users in

```ts
import { BridgeAuth } from '@nebulr-group/bridge-auth-core';

const bridge = new BridgeAuth({
  appId: 'your-app-id',
  callbackUrl: 'https://your-app.com/auth/oauth-callback',
});

// A "Sign in" button sends the user to the hosted sign-in page
signInButton.addEventListener('click', () => bridge.login());

// On your callback route, exchange the code for tokens
const code = new URLSearchParams(location.search).get('code');
if (code) await bridge.handleCallback(code);

bridge.getCurrentUser();                     // the signed-in user, or null
await bridge.isFeatureEnabled('new-editor'); // feature flags
```

`BridgeAuth` also covers in-app sign-in: passwords, magic links, passkeys, SSO, MFA, signup and workspace switching. Tokens are stored in `localStorage` in the browser and in memory on the server; pass `storage` to use your own.

## Manage your app from code

`BridgeManagement` uses an API key, so it belongs on your server, in CI or in a script, never in a browser.

```ts
import { BridgeManagement } from '@nebulr-group/bridge-auth-core';

const mgmt = new BridgeManagement({ apiKey: process.env.BRIDGE_API_KEY });
const tenants = await mgmt.tenants.list();
const flags = await mgmt.flags.list();
```

## Using a framework?

The framework packages below wrap this core with components, route guards and decorators. Start there if your framework is listed.

## Learn more

- [Getting started](https://thebridge.dev/docs/getting-started/?utm_source=readme&utm_medium=readme&utm_campaign=bridge-auth-core)
- [Sign-in inside your app](https://thebridge.dev/docs/sdk-auth/?utm_source=readme&utm_medium=readme&utm_campaign=bridge-auth-core)
- [Feature flags](https://thebridge.dev/docs/feature-flags/?utm_source=readme&utm_medium=readme&utm_campaign=bridge-auth-core)
- [Subscriptions and plan limits](https://thebridge.dev/docs/billing/how-it-works/?utm_source=readme&utm_medium=readme&utm_campaign=bridge-auth-core)
- [API reference](https://thebridge.dev/docs/api-reference/?utm_source=readme&utm_medium=readme&utm_campaign=bridge-auth-core)

## Other Bridge packages

| Package | For |
|---|---|
| [`@nebulr-group/bridge-svelte`](https://www.npmjs.com/package/@nebulr-group/bridge-svelte) | SvelteKit |
| [`@nebulr-group/bridge-react`](https://www.npmjs.com/package/@nebulr-group/bridge-react) | React |
| [`@nebulr-group/bridge-nextjs`](https://www.npmjs.com/package/@nebulr-group/bridge-nextjs) | Next.js |
| [`@nebulr-group/bridge-angular`](https://www.npmjs.com/package/@nebulr-group/bridge-angular) | Angular |
| [`@nebulr-group/bridge-nestjs`](https://www.npmjs.com/package/@nebulr-group/bridge-nestjs) | NestJS |
| [`@nebulr-group/bridge-express`](https://www.npmjs.com/package/@nebulr-group/bridge-express) | Express |
| [`@nebulr-group/bridge-cli`](https://www.npmjs.com/package/@nebulr-group/bridge-cli) | CLI for people and AI agents |

## License

[MIT](https://github.com/thebridgedev/auth-core/blob/main/LICENSE) © Nebulr. Built by [The Bridge](https://thebridge.dev/?utm_source=readme&utm_medium=readme&utm_campaign=bridge-auth-core).
