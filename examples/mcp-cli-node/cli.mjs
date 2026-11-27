#!/usr/bin/env node
/**
 * acme: Acme's own command-line tool, signed in with The Bridge.
 *
 *   acme login [--code]   sign in (the browser; --code for a short code)
 *   acme whoami           who is signed in
 *   acme invoices list    the invoices, from Acme's API
 *   acme mcp whoami       call the MCP endpoint's tool with the CLI's own token
 *   acme logout           sign out
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createBridgeCli } from '@nebulr-group/bridge-auth-core/cli';

const issuer = process.env.BRIDGE_ISSUER;
const api = process.env.ACME_URL ?? `http://localhost:${process.env.PORT ?? 4000}`;
const resource = process.env.RESOURCE ?? `${api}/mcp`;
if (!issuer) {
  console.error('Set BRIDGE_ISSUER to Acme\'s issuer.');
  process.exit(1);
}

const auth = createBridgeCli({ issuer, name: 'acme' });

async function main(args) {
  const [command, sub] = args;
  switch (command) {
    case 'login': {
      const me = await auth.login({ code: args.includes('--code') });
      console.log(`Signed in as ${me.email ?? me.userId}${me.workspace ? ` in ${me.workspace.name ?? me.workspace.id}` : ''}. Tokens kept in the ${me.storage}.`);
      return;
    }
    case 'whoami': {
      const me = await auth.whoami();
      if (!me) {
        console.log('Not signed in. Run `acme login`.');
        process.exitCode = 1;
        return;
      }
      console.log(JSON.stringify(me, null, 2));
      return;
    }
    case 'invoices': {
      if (sub !== 'list') break;
      const response = await auth.fetch(`${api}/api/invoices`);
      const body = await response.json();
      if (!response.ok) throw new Error(`Acme answered ${response.status}: ${body.message ?? body.error}`);
      for (const invoice of body.invoices) console.log(`${invoice.id}  ${invoice.customer.padEnd(10)} ${String(invoice.amount).padStart(6)} ${invoice.currency}  ${invoice.status}`);
      return;
    }
    case 'mcp': {
      if (sub !== 'whoami') break;
      const token = await auth.getAccessToken();
      const client = new Client({ name: 'acme-cli', version: '1.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(resource), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
      const result = await client.callTool({ name: 'whoami', arguments: {} });
      console.log(result.content?.[0]?.text ?? JSON.stringify(result));
      await client.close();
      return;
    }
    case 'logout': {
      const result = await auth.logout();
      console.log(result.signedOut ? (result.revoked ? 'Signed out.' : `Signed out here; Bridge could not be told (${result.reason}).`) : 'Not signed in.');
      return;
    }
  }
  console.log('Usage: acme login [--code] | acme whoami | acme invoices list | acme mcp whoami | acme logout');
  process.exitCode = 2;
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
