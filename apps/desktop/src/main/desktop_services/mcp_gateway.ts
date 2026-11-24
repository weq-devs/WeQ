import { SELECT_OPEN_ACCOUNT_TOOL } from '../mcp/tool_permissions';
import { createHash, randomUUID } from 'node:crypto';
import {
  createServer,
  request,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { servicePortCandidates } from '@weq/service/service-ports';
import { z } from 'zod/v3';
import { externalMcpTools, isCompactMcpTool, type McpServerOptions } from '../mcp/server';
import { MCP_MAIL_ATTACHMENT_ROUTE } from '../mcp/mail_tools';
import { MCP_CHAT_VIDEO_ROUTE } from '../mcp/chat_video_download';
import { PRIVATE_ACCOUNT_HEADER, type DesktopAccountRoutes, type RoutedAccount } from './accounts';
import { PRIVATE_TOKEN_HEADER, readControlJson, sendJson, stopPrivate } from './control';

const SESSION_TTL = 12 * 60 * 60_000;
const MAX_SESSIONS = 128;
const MAX_TICKETS = 256;
const TICKET_TTL = 5 * 60_000;
const LEGACY_READS = new Set([
  'get_self_profile',
  'list_groups',
  'list_buddies',
  'list_conversations',
  'get_messages',
  'get_message_details',
  'get_forward_messages',
  'get_db_columns',
  'list_db_tables',
  'list_databases',
  'list_group_members',
]);
const legacyRead = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.number(), z.string()]),
  method: z.literal('tools/call'),
  params: z.object({ name: z.string(), arguments: z.unknown().optional() }),
});

export function mcpCredentialId(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

interface ToolSession {
  credential: string;
  compact: boolean;
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  selected?: RoutedAccount;
  pendingSelection?: { configId: string; open: boolean; promise: Promise<RoutedAccount> };
  selection: AbortController;
  lastActive: number;
  switchRevision: number;
}

interface DownloadTicket {
  session: ToolSession;
  account: RoutedAccount;
  workerPath: string;
  expiresAt: number;
  selection: AbortSignal;
}

function workerHeaders(target: RoutedAccount) {
  return {
    [PRIVATE_TOKEN_HEADER]: target.mcp.token,
    [PRIVATE_ACCOUNT_HEADER]: target.account.generation,
  };
}

function sdkError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { jsonrpc: '2.0', id: null, error: { code: -32000, message } });
}

function result(data: unknown, isError = false) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data ?? null) }], isError };
}

export class DesktopMcpGateway {
  private readonly sessions = new Map<string, ToolSession>();
  private readonly tickets = new Map<string, DownloadTicket>();
  private server: Server | null = null;
  private options: McpServerOptions | undefined;
  private port: number | null = null;
  private interval: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly accounts: DesktopAccountRoutes,
    private readonly accountIds: (credential: string) => readonly string[] | undefined,
    private readonly canWrite?: (credential: string, configId: string) => boolean,
  ) {}

  get boundPort(): number | null {
    return this.port;
  }

  async configure(options: McpServerOptions | null): Promise<void> {
    if (options && this.options?.port === options.port && this.options.token === options.token)
      return;
    await this.stop();
    if (!options) return;
    const server = createServer((req, res) => {
      void this.handle(req, res).catch(() => {
        if (!res.headersSent && !res.destroyed) sdkError(res, 500, 'MCP 请求失败。');
      });
    });
    for (const port of servicePortCandidates('mcp', options.port, 20)) {
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(port, '127.0.0.1', () => {
            server.off('error', reject);
            resolve();
          });
        });
        const bound = server.address();
        if (!bound || typeof bound === 'string') throw new Error('MCP 地址不可用。');
        this.options = options;
        this.server = server;
        this.port = bound.port;
        this.interval = setInterval(() => this.prune(), 60_000);
        this.interval.unref();
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
      }
    }
    throw new Error('MCP 候选端口都被占用。');
  }

  private prune() {
    const now = Date.now();
    for (const [id, session] of this.sessions)
      if (now - session.lastActive >= SESSION_TTL) this.closeSession(id);
    for (const [id, ticket] of this.tickets)
      if (ticket.expiresAt <= now || ticket.selection.aborted) this.tickets.delete(id);
  }

  invalidateCredential(credential: string) {
    for (const [id, session] of this.sessions)
      if (session.credential === credential) this.closeSession(id);
  }

  private closeSession(id: string) {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    session.selection.abort();
    void session.server.close().catch(() => {});
  }

  async stop() {
    clearInterval(this.interval);
    for (const id of this.sessions.keys()) this.closeSession(id);
    this.tickets.clear();
    const server = this.server;
    if (server) {
      await new Promise<void>((resolve) => {
        server.once('close', resolve);
        stopPrivate(server);
      });
    }
    this.server = null;
    this.options = undefined;
    this.port = null;
  }

  private candidates(session: ToolSession) {
    const ids = this.accountIds(session.credential);
    return this.accounts.list().filter((account) => ids?.includes(account.configId));
  }

  private select(session: ToolSession, configId: string, open = true): Promise<RoutedAccount> {
    if (session.pendingSelection?.configId === configId && session.pendingSelection.open === open)
      return session.pendingSelection.promise;
    const pending = {
      configId,
      open,
      promise: this.selectAccount(session, configId, open).finally(() => {
        if (session.pendingSelection === pending) session.pendingSelection = undefined;
      }),
    };
    session.pendingSelection = pending;
    return pending.promise;
  }

  private async selectAccount(
    session: ToolSession,
    configId: string,
    open: boolean,
  ): Promise<RoutedAccount> {
    if (!this.accountIds(session.credential)?.includes(configId))
      throw new Error('此账号未向该 MCP 令牌授权。');
    const revision = ++session.switchRevision;
    const selected = open ? await this.accounts.open(configId) : await this.accounts.find(configId);
    if (!selected) throw new Error('授权账号未在 WeQ 窗口中打开。');
    if (
      revision !== session.switchRevision ||
      session.selection.signal.aborted ||
      !this.accountIds(session.credential)?.includes(configId)
    )
      throw new Error('MCP 会话或账号授权已变化。');
    session.selection.abort();
    session.selection = new AbortController();
    session.selected = selected;
    return selected;
  }

  private async runTool(session: ToolSession, name: string, args: unknown, signal: AbortSignal) {
    if (name === 'list_accounts') {
      const windows = await this.accounts.windows();
      const open = new Set(windows.map((window) => window.account?.configId));
      return this.candidates(session).map((account) => ({
        ...account,
        open: open.has(account.configId),
        current: session.selected?.account.configId === account.configId,
      }));
    }
    if (name === 'switch_account') {
      const { configId } = z.object({ configId: z.string() }).parse(args);
      const target = await this.select(session, configId);
      return { ok: true, configId, uin: target.account.uin };
    }
    const candidates = this.candidates(session);
    const target =
      session.selected ??
      (candidates.length === 1 ? await this.select(session, candidates[0]!.configId) : null);
    if (!target)
      throw new Error(
        candidates.length
          ? '请先使用 select_open_account 或 switch_account 选择账号。'
          : '此令牌尚未获账号授权。',
      );
    if (!this.accountIds(session.credential)?.includes(target.account.configId))
      throw new Error('此账号授权已撤销。');
    const selection = session.selection.signal;
    const allowWrites = this.canWrite?.(session.credential, target.account.configId) === true;
    const value = await this.callWorker(target, name, args, AbortSignal.any([signal, selection]), {
      allowWrites,
      compact: session.compact,
    });
    selection.throwIfAborted();
    if (
      value &&
      typeof value === 'object' &&
      'downloadPath' in value &&
      typeof value.downloadPath === 'string'
    ) {
      const workerPath = value.downloadPath;
      if (
        workerPath.startsWith(MCP_MAIL_ATTACHMENT_ROUTE) ||
        workerPath.startsWith(MCP_CHAT_VIDEO_ROUTE)
      ) {
        if (this.tickets.size >= MAX_TICKETS)
          this.tickets.delete(this.tickets.keys().next().value!);
        const id = randomUUID();
        this.tickets.set(id, {
          session,
          account: target,
          selection,
          workerPath,
          expiresAt: Date.now() + TICKET_TTL,
        });
        return { ...value, downloadPath: `/downloads/${id}` };
      }
    }
    return value;
  }

  private async callWorker(
    target: RoutedAccount,
    name: string,
    args: unknown,
    signal: AbortSignal,
    options?: { allowWrites: boolean; compact: boolean },
  ) {
    const response = await fetch(`http://127.0.0.1:${target.mcp.port}/tool`, {
      method: 'POST',
      headers: { ...workerHeaders(target), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, args, ...options }),
      signal,
      redirect: 'error',
    });
    const body = (await response.json()) as { value?: unknown; error?: string };
    if (!response.ok) throw new Error(body.error ?? '账号窗口不可用，请重新选择账号。');
    return body.value;
  }

  private async legacyRead(credential: string, body: unknown, res: ServerResponse) {
    const call = legacyRead.safeParse(body);
    if (!call.success) return sdkError(res, 400, '需要初始化 MCP 会话。');
    const { id, params } = call.data;
    const tool =
      LEGACY_READS.has(params.name) && externalMcpTools().find(({ name }) => name === params.name);
    if (!tool) return sdkError(res, 400, '此工具需要初始化 MCP 会话。');
    const grant = this.accountIds(credential);
    const configId = grant?.length === 1 ? grant[0]! : undefined;
    const stillGranted = () => {
      const current = this.accountIds(credential);
      return current?.length === 1 && current[0] === configId;
    };
    const finish = (data: unknown, isError = false) => {
      if (!res.destroyed) sendJson(res, 200, { jsonrpc: '2.0', id, result: result(data, isError) });
    };
    if (!configId) return finish('只读直连需要令牌仅授权一个账号。', true);
    const abort = new AbortController();
    res.once('close', () => abort.abort());
    try {
      const args = tool.input.parse(params.arguments ?? {});
      const target = await this.accounts.find(configId);
      if (!target || !stillGranted()) throw new Error('授权账号未在 WeQ 窗口中打开。');
      const value = await this.callWorker(target, params.name, args, abort.signal);
      if (!stillGranted()) throw new Error('此账号授权已变化。');
      finish(value);
    } catch (error) {
      finish(error instanceof Error ? error.message : String(error), true);
    }
  }

  private download(credential: string, req: IncomingMessage, res: ServerResponse) {
    const id = req.url?.slice('/downloads/'.length) ?? '';
    const ticket = this.tickets.get(id);
    if (
      req.method !== 'GET' ||
      !ticket ||
      ticket.selection.aborted ||
      ticket.expiresAt <= Date.now() ||
      credential !== ticket.session.credential ||
      !this.accountIds(credential)?.includes(ticket.account.account.configId)
    ) {
      res.writeHead(404, { 'Cache-Control': 'no-store' }).end('下载路径已失效。');
      return;
    }
    const upstream = request({
      hostname: '127.0.0.1',
      port: ticket.account.mcp.port,
      method: 'GET',
      path: ticket.workerPath,
      headers: workerHeaders(ticket.account),
      signal: ticket.selection,
    });
    upstream.once('error', () => {
      if (!res.headersSent) res.writeHead(502).end();
      else res.destroy();
    });
    upstream.once('response', (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
      res.once('close', () => response.destroy());
    });
    res.once('close', () => upstream.destroy());
    upstream.end();
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const match = /^Bearer (\S{16,256})$/.exec(req.headers.authorization ?? '');
    const credential = match && mcpCredentialId(match[1]!);
    if (!credential || this.accountIds(credential) === undefined)
      return sdkError(res, 401, 'MCP 令牌无效。');
    if (req.headers.origin && req.headers.origin !== `http://127.0.0.1:${this.port}`)
      return sdkError(res, 403, 'MCP 请求来源无效。');
    if (req.url?.startsWith('/downloads/')) return this.download(credential, req, res);
    const compact = req.url === '/mcp/compact';
    if (!compact && req.url !== '/' && req.url !== '/mcp')
      return sdkError(res, 404, 'MCP 接口不存在。');
    const id = req.headers['mcp-session-id'];
    if (typeof id === 'string') {
      const session = this.sessions.get(id);
      if (!session || session.credential !== credential || session.compact !== compact)
        return sdkError(res, 404, 'MCP 会话已结束，请重新连接。');
      session.lastActive = Date.now();
      await session.transport.handleRequest(req, res);
      return;
    }
    if (req.method !== 'POST') return sdkError(res, 400, '需要初始化 MCP 会话。');
    const body = await readControlJson(req);
    if (!isInitializeRequest(body)) {
      if (compact) return sdkError(res, 400, '需要初始化 MCP 会话。');
      return this.legacyRead(credential, body, res);
    }
    this.prune();
    if (this.sessions.size >= MAX_SESSIONS) return sdkError(res, 503, 'MCP 会话容量已满。');
    const server = new McpServer({ name: 'weq', version: '0.1.0' });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (sessionId) => {
        this.sessions.set(sessionId, session);
      },
      enableJsonResponse: true,
    });
    const session: ToolSession = {
      credential,
      compact,
      server,
      transport,
      selection: new AbortController(),
      lastActive: Date.now(),
      switchRevision: 0,
    };
    for (const tool of externalMcpTools()) {
      if (compact && !isCompactMcpTool(tool.name)) continue;
      const description =
        tool.name === 'list_accounts'
          ? '列出当前令牌可访问的账号与数据源。open=true 可用 select_open_account 选择；current=true 是当前 MCP 会话选中的数据源。'
          : tool.name === 'switch_account'
            ? '选择当前 MCP 会话的账号。目标就绪后返回，其他客户端与桌面窗口继续使用原账号。'
            : tool.description;
      server.registerTool(
        tool.name,
        { description, inputSchema: tool.input.shape },
        async (args, { signal }) => {
          try {
            const value = await this.runTool(session, tool.name, args, signal);
            return {
              ...result(value),
              ...(tool.structuredResult &&
              value &&
              typeof value === 'object' &&
              !Array.isArray(value)
                ? { structuredContent: value as Record<string, unknown> }
                : {}),
            };
          } catch (error) {
            return result(error instanceof Error ? error.message : String(error), true);
          }
        },
      );
    }
    server.registerTool(
      SELECT_OPEN_ACCOUNT_TOOL,
      {
        description: '在当前 MCP 会话中选择一个已经打开的授权账号。账号未打开时返回错误。',
        inputSchema: { configId: z.string().min(1) },
      },
      async ({ configId }) => {
        try {
          const target = await this.select(session, configId, false);
          return result({ ok: true, configId, uin: target.account.uin });
        } catch (error) {
          return result(error instanceof Error ? error.message : String(error), true);
        }
      },
    );
    transport.onclose = () => {
      session.selection.abort();
      if (transport.sessionId) this.sessions.delete(transport.sessionId);
    };
    await server.connect(transport);
    try {
      await transport.handleRequest(req, res, body);
    } finally {
      if (!transport.sessionId) await server.close();
    }
  }
}
