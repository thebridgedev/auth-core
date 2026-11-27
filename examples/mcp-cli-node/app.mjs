/**
 * Acme: a tiny app protected by The Bridge.
 *
 * - POST /mcp: an MCP endpoint (streamable HTTP, the official MCP SDK) with
 *   one tool, `whoami`, behind the guard in MCP mode. Assistants are told
 *   where to sign in; the tool gets the caller's user, workspace and
 *   privileges.
 * - GET /api/invoices: an API route behind the normal guard, which never
 *   accepts an assistant's token.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { bridgeMcpGuard, createBridgeServer } from '@nebulr-group/bridge-auth-core/server';
import { bridgeMcpMiddleware } from '@nebulr-group/bridge-auth-core/server/node';

const INVOICES = [
  { id: 'inv-1001', customer: 'Globex', amount: 1200, currency: 'EUR', status: 'paid' },
  { id: 'inv-1002', customer: 'Initech', amount: 450, currency: 'EUR', status: 'open' },
];

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

/** One MCP server per request (stateless streamable HTTP): the caller comes from the guard, never from the request body. */
function mcpServerFor() {
  const server = new McpServer({ name: 'acme', version: '1.0.0' });
  server.registerTool(
    'whoami',
    { title: 'Who am I', description: 'The signed-in person, their workspace and their privileges in Acme.' },
    async (extra) => {
      const caller = extra.authInfo?.extra?.caller;
      const result = {
        user: caller.userId,
        email: caller.email,
        workspace: caller.workspaceId,
        role: caller.role,
        privileges: caller.privileges,
        mayDelete: caller.mayDelete,
        client: caller.client,
      };
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result };
    },
  );
  return server;
}

/**
 * @param {{ issuer: string, resource: string, fetch?: typeof fetch, log?: (message: string, details?: object) => void }} options
 */
export function createAcmeApp(options) {
  const { issuer, resource } = options;
  const extra = options.fetch ? { fetch: options.fetch } : {};
  // The one line in front of /mcp.
  const guard = bridgeMcpGuard({ issuer, resource, resourceName: 'Acme', ...extra });
  const protectMcp = bridgeMcpMiddleware(guard);
  // The normal guard, for the API.
  const bridge = createBridgeServer({ issuer, ...extra });
  const mcpPath = new URL(resource).pathname;

  async function handle(req, res) {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    try {
      if (path === mcpPath || guard.isMetadataRequest(req)) {
        await protectMcp(req, res, async () => {
          const server = mcpServerFor();
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
          res.on('close', () => {
            void transport.close();
            void server.close();
          });
          await server.connect(transport);
          await transport.handleRequest(req, res);
        });
        return;
      }
      if (path === '/api/invoices' && req.method === 'GET') {
        const checked = await bridge.check(req);
        if (!checked.ok) return json(res, checked.error.status || 401, { error: checked.error.code, message: checked.error.message });
        return json(res, 200, { workspace: checked.actor.workspaceId, invoices: INVOICES });
      }
      json(res, 404, { error: 'not_found' });
    } catch (error) {
      options.log?.('Request failed', { error: error instanceof Error ? error.message : String(error) });
      if (!res.headersSent) json(res, 500, { error: 'server_error' });
    }
  }

  return {
    guard,
    bridge,
    handle,
    async close() {
      await guard.close();
      await bridge.close();
    },
  };
}
