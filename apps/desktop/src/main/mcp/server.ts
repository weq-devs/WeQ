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

/** How many consecutive ports to probe when the requested one is taken. */
const PORT_FALLBACK_ATTEMPTS = 20;

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
    // 外部 MCP 面板保持严格只读：带副作用的工具（assistantOnly）只给内置助手用。
    if (t.assistantOnly) continue;
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
 * Try to bind `server` to `port` on loopback. Resolves `true` on success,
 * `false` if the port is already in use (so the caller can try the next one).
 * Any other bind error rejects.
 */
function tryListen(server: http.Server, port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      server.off('listening', onListening);
      if (err.code === 'EADDRINUSE') {
        resolve(false);
        return;
      }
      reject(err);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve(true);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

/**
 * Start (or restart) the MCP HTTP server. Idempotent: a call with the same
 * port+token while already running is a no-op; a different config restarts.
 *
 * If the requested port is already in use (common on Windows where e.g. Baidu
 * IME squats on 8765), it probes the next `PORT_FALLBACK_ATTEMPTS` ports and
 * binds to the first free one. Returns the port it actually bound to, so the
 * caller can persist it and keep the UI / client config in sync.
 */
export async function startMcpServer(opts: McpServerOptions): Promise<number> {
  if (httpServer) {
    if (activeConfig && activeConfig.port === opts.port && activeConfig.token === opts.token) {
      return activeConfig.port;
    }
    await stopMcpServer();
  }
  const server = http.createServer((req, res) => {
    void handleRequest(req, res, opts.token);
  });
  let boundPort = -1;
  for (let i = 0; i < PORT_FALLBACK_ATTEMPTS; i += 1) {
    const port = opts.port + i;
    if (port > 65535) break;
    if (await tryListen(server, port)) {
      boundPort = port;
      break;
    }
    if (i > 0) {
      logger.warn('mcp port in use, trying next', { event: 'mcp-port-busy', port });
    }
  }
  if (boundPort === -1) {
    server.close();
    throw new Error(
      `MCP 端口 ${opts.port}–${Math.min(opts.port + PORT_FALLBACK_ATTEMPTS - 1, 65535)} 都被占用，无法启动。`,
    );
  }
  httpServer = server;
  activeConfig = { port: boundPort, token: opts.token };
  logger.info('mcp server started', {
    event: 'mcp-start',
    port: boundPort,
    requestedPort: opts.port,
    url: `http://127.0.0.1:${boundPort}`,
  });
  return boundPort;
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
