#!/usr/bin/env node
/**
 * Starts Acme. BRIDGE_ISSUER is the app's issuer (Bridge's dashboard shows
 * it); PORT is where to listen; RESOURCE is the MCP endpoint's address as
 * assistants are given it.
 */
import { createServer } from 'node:http';
import { createAcmeApp } from './app.mjs';

const issuer = process.env.BRIDGE_ISSUER;
if (!issuer) {
  console.error('Set BRIDGE_ISSUER to your app\'s issuer, such as http://localhost:3000/identity-access/apps/<app id>.');
  process.exit(1);
}
const port = Number(process.env.PORT ?? 4000);
const resource = process.env.RESOURCE ?? `http://localhost:${port}/mcp`;

const app = createAcmeApp({ issuer, resource, log: (message, details) => console.error(message, details ?? '') });
createServer((req, res) => void app.handle(req, res)).listen(port, () => {
  console.log(`Acme listens on http://localhost:${port}`);
  console.log(`  MCP endpoint:  ${resource}`);
  console.log(`  its metadata:  ${app.guard.metadataUrl}`);
  console.log(`  API:           http://localhost:${port}/api/invoices`);
});
