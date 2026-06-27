/**
 * Account-bound MCP server (Streamable HTTP).
 *
 * Hosts a local HTTP endpoint on 127.0.0.1 that exposes `AI_TOOLS` over MCP so
 * external AI clients (Claude Desktop, Cherry Studio, …) can query the *current*
 * account's QQ data. The server is started/stopped with the account lifecycle
 * (see `context/app_context.ts`), never globally:
 *
 *   - only listens while an account is open;
 *   - stops on account switch / logout / app quit.
 *
 * Security: bound to loopback only, every request must carry
 * `Authorization: Bearer <token>`. Tools are read-only.
 *
 * Transport is stateless — a fresh `McpServer` + transport per request — which
 * is the simplest correct shape for a single local client and avoids any
 * cross-request session state.
 */

import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { getLogger, logErrorContext } from '@weq/service';
import { AI_TOOLS } from './tools';

const logger = getLogger().child({ scope: 'mcp-server' });

export interface McpServerOptions {
  port: number;
  token: string;
}

let httpServer: http.Server | null = null;
let activeConfig: McpServerOptions | null = null;

/** Whether the MCP HTTP server is currently listening. */
export function isMcpRunning(): boolean {
  return httpServer !== null;
}

/** The config the running server was started with (or null when stopped). */
export function runningMcpConfig(): McpServerOptions | null {
  return activeConfig;
}

/** Build a fresh MCP server with every tool registered. */
function buildMcpServer(): McpServer {
  const server = new McpServer({ name: 'weq', version: '0.1.0' });
  for (const t of AI_TOOLS) {
    server.registerTool(
      t.name,
      { description: t.description, inputSchema: t.input.shape },
      async (args: unknown) => {
        try {
          const data = await t.run(args as never);
          return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: error instanceof Error ? error.message : String(error),
              },
            ],
          };
        }
      },
    );
  }
  return server;
}

function unauthorized(res: http.ServerResponse): void {
  res.writeHead(401, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Unauthorized' },
      id: null,
    }),
  );
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  token: string,
): Promise<void> {
  const auth = req.headers['authorization'];
  if (!token || auth !== `Bearer ${token}`) {
    unauthorized(res);
    return;
  }
  const server = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (error) {
    logger.error('mcp request failed', { event: 'mcp-request-error', ...logErrorContext(error) });
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        }),
      );
    }
  }
}

/**
 * Start (or restart) the MCP HTTP server. Idempotent: a call with the same
 * port+token while already running is a no-op; a different config restarts.
 * Rejects if the port can't be bound (e.g. already in use).
 */
export async function startMcpServer(opts: McpServerOptions): Promise<void> {
  if (httpServer) {
    if (activeConfig && activeConfig.port === opts.port && activeConfig.token === opts.token) {
      return;
    }
    await stopMcpServer();
  }
  const server = http.createServer((req, res) => {
    void handleRequest(req, res, opts.token);
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(opts.port, '127.0.0.1');
  });
  httpServer = server;
  activeConfig = { ...opts };
  logger.info('mcp server started', {
    event: 'mcp-start',
    port: opts.port,
    url: `http://127.0.0.1:${opts.port}`,
  });
}

/** Stop the MCP HTTP server if running. Idempotent. */
export async function stopMcpServer(): Promise<void> {
  const server = httpServer;
  if (!server) return;
  httpServer = null;
  activeConfig = null;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    // Drop keep-alive sockets so close() resolves promptly.
    server.closeAllConnections?.();
  });
  logger.info('mcp server stopped', { event: 'mcp-stop' });
}
