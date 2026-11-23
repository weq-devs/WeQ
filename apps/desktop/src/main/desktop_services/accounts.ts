import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { setTimeout as pause } from 'node:timers/promises';
import { z } from 'zod';
import {
  accountIsRunning,
  savedInstanceAccounts,
  type AccountInstanceTarget,
} from '../account_instances';
import type { WebCore } from '../web/application';
import { withWebAccountRoute } from '../web/account_route';
import { runDesktopMcpTool } from '../mcp/server';
import { MCP_MAIL_ATTACHMENT_ROUTE } from '../mcp/mail_tools';
import { handleMcpMailDownload } from '../mcp/mail_download';
import { MCP_CHAT_VIDEO_ROUTE, handleMcpChatVideoDownload } from '../mcp/chat_video_download';
import { runtimeMaintenance } from '../runtime_maintenance';
import {
  callControl,
  type DesktopServiceRegistry,
  listenPrivate,
  newServiceToken,
  openControl,
  privateRequest,
  PRIVATE_WEB_ROUTE_HEADER,
  readControlJson,
  sendJson,
  stopPrivate,
  type ServiceEndpoint,
} from './control';

export const PRIVATE_ACCOUNT_HEADER = 'x-weq-desktop-account-session';
const configIdSchema = z.string().regex(/^[a-z\d][a-z\d_-]{0,127}$/i);

export interface LiveAccount {
  configId: string;
  uin: string;
  session: object;
}

interface ParticipantState {
  account: { configId: string; uin: string; generation: string } | null;
  browser: ServiceEndpoint;
  remote: ServiceEndpoint;
  mcp: ServiceEndpoint;
  assignedUin?: string;
}

export async function registerAccountWorker(options: {
  registry: DesktopServiceRegistry;
  core: WebCore;
  currentAccount: () => LiveAccount | null;
  watchClosing: (callback: () => void) => () => void;
  launch: (configId: string) => Promise<void>;
  assignedUin?: string;
  openHere: (configId: string) => Promise<void>;
  reveal: () => void;
}): Promise<() => void> {
  const { core, registry } = options;
  const watchers = new Set<() => void>();
  let previous: object | undefined;
  let generation = '';
  function current() {
    const account = options.currentAccount();
    if (previous !== account?.session) {
      previous = account?.session;
      generation = randomUUID();
    }
    return account ? { configId: account.configId, uin: account.uin, generation } : null;
  }
  async function listen(remoteClient: boolean) {
    const token = newServiceToken();
    const allowed = (request: IncomingMessage) => {
      const state = current();
      return (
        state &&
        privateRequest(request, token) &&
        request.headers[PRIVATE_ACCOUNT_HEADER] === state.generation
      );
    };
    const application = core.entry({
      remoteClient,
      accountScoped: true,
      login: async () => false,
      logout: () => {},
      isAuthed: (request) => Boolean(allowed(request)),
      watchSession: (_request, revoke) => {
        watchers.add(revoke);
        return () => {
          watchers.delete(revoke);
        };
      },
    });
    const server = createServer((req, res) => {
      if (!allowed(req)) {
        res.writeHead(401).end();
        return;
      }
      withWebAccountRoute(req.headers[PRIVATE_WEB_ROUTE_HEADER], () =>
        application.handle(req, res),
      );
    });
    try {
      const port = await listenPrivate(server);
      application.attach(server);
      return {
        endpoint: { port, token },
        close: () => {
          application.close();
          stopPrivate(server);
        },
      };
    } catch (error) {
      application.close();
      stopPrivate(server);
      throw error;
    }
  }
  const browser = await listen(false);
  const cleanup = [
    options.watchClosing(() => {
      for (const watcher of watchers) watcher();
      watchers.clear();
    }),
    browser.close,
  ];
  try {
    const remote = await listen(true);
    cleanup.push(remote.close);
    const mcpToken = newServiceToken();
    const mcp = createServer((req, res) => {
      const state = current();
      const account = options.currentAccount();
      if (
        !state ||
        !account ||
        !privateRequest(req, mcpToken) ||
        req.headers[PRIVATE_ACCOUNT_HEADER] !== state.generation
      ) {
        sendJson(res, 401, { error: '账号已关闭或切换。' });
        return;
      }
      const controller = new AbortController();
      const stop = () => controller.abort();
      watchers.add(stop);
      res.once('close', () => {
        watchers.delete(stop);
        stop();
      });
      const run = async () => {
        if (req.method === 'POST' && req.url === '/tool') {
          const input = z
            .object({ name: z.string(), args: z.unknown() })
            .parse(await readControlJson(req));
          const value = await runDesktopMcpTool(
            input.name,
            input.args,
            account.session,
            () => options.currentAccount()?.session ?? null,
            controller.signal,
          );
          sendJson(res, 200, { value });
        } else if (req.url?.startsWith(MCP_MAIL_ATTACHMENT_ROUTE)) {
          await runtimeMaintenance.operation(() => handleMcpMailDownload(req, res), 'MCP 邮箱附件');
        } else if (req.url?.startsWith(MCP_CHAT_VIDEO_ROUTE)) {
          await runtimeMaintenance.operation(
            () => handleMcpChatVideoDownload(req, res),
            'MCP 聊天视频',
          );
        } else sendJson(res, 404, { error: '接口不存在。' });
      };
      void run().catch((error: unknown) => {
        if (!res.headersSent && !res.destroyed)
          sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
      });
    });
    const mcpPort = await listenPrivate(mcp);
    cleanup.push(() => stopPrivate(mcp));
    const control = await openControl((method, input) => {
      if (method === 'state')
        return {
          account: current(),
          browser: browser.endpoint,
          remote: remote.endpoint,
          mcp: { port: mcpPort, token: mcpToken },
          assignedUin: options.assignedUin,
        };
      if (method === 'open') return options.launch(configIdSchema.parse(input));
      if (method === 'openHere') return options.openHere(configIdSchema.parse(input));
      if (method === 'reveal') return options.reveal();
      throw new Error('未知账号窗口命令。');
    });
    cleanup.push(control.close);
    const unpublish = await registry.publish(`window-${process.pid}`, control.endpoint);
    return () => {
      void unpublish();
      for (const close of cleanup.reverse()) close();
    };
  } catch (error) {
    for (const close of cleanup.reverse()) close();
    throw error;
  }
}

export type RoutedAccount = ParticipantState & {
  account: NonNullable<ParticipantState['account']>;
  control: ServiceEndpoint;
};

export class DesktopAccountRoutes {
  private readonly pending = new Map<string, Promise<RoutedAccount>>();

  constructor(
    private readonly dataRoot: string,
    private readonly registry: DesktopServiceRegistry,
  ) {}

  async windows() {
    const endpoints = await this.registry.participants();
    const results = await Promise.allSettled(
      endpoints.map(async (control) => ({
        ...(await callControl<ParticipantState>(
          control,
          'state',
          undefined,
          AbortSignal.timeout(1200),
        )),
        control,
      })),
    );
    return results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
  }

  list() {
    return savedInstanceAccounts(this.dataRoot).map(
      ({ configId, uin, displayName, static: isStatic }) => ({
        configId,
        uin,
        displayName: displayName ?? uin,
        static: isStatic ?? false,
      }),
    );
  }

  async find(configId: string): Promise<RoutedAccount | undefined> {
    const match = (await this.windows()).find((window) => window.account?.configId === configId);
    return match?.account ? { ...match, account: match.account } : undefined;
  }

  open(configId: string): Promise<RoutedAccount> {
    const existing = this.pending.get(configId);
    if (existing) return existing;
    const pending = this.openAccount(configId).finally(() => this.pending.delete(configId));
    this.pending.set(configId, pending);
    return pending;
  }

  private async openAccount(configId: string): Promise<RoutedAccount> {
    const target = this.list().find((account) => account.configId === configId);
    if (!target) throw new Error('账号数据源不存在。');
    const windows = await this.windows();
    const current = windows.find((window) => window.account?.configId === configId);
    if (current?.account) return { ...current, account: current.account };
    const idle = windows.find((window) => !window.account && window.assignedUin === target.uin);
    if (idle) {
      await callControl(idle.control, 'openHere', configId);
      const opened = await this.find(configId);
      if (!opened) throw new Error('账号尚未就绪。');
      return opened;
    }
    if (accountIsRunning(this.dataRoot, target.uin))
      throw new Error('此 QQ 号已被另一窗口或数据源使用。');
    const launcher = windows.at(0);
    if (!launcher) throw new Error('请先打开 WeQ 桌面。');
    await callControl(launcher.control, 'open', configId, AbortSignal.timeout(5000));
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const opened = await this.find(configId);
      if (opened) return opened;
      await pause(250);
    }
    throw new Error('账号未就绪，请在桌面窗口检查启动结果。');
  }
}

export function savedAccountTarget(root: string, value: string): AccountInstanceTarget {
  const target = savedInstanceAccounts(root).find((record) => record.configId === value);
  if (!target) throw new Error('账号数据源不存在。');
  return target;
}
