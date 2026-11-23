import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { UserConfigService } from '@weq/service';
import { getLogger } from '@weq/service';
import { onSettingsChanged } from '@weq/service/settings-changes';
import { DesktopWebRuntime, desktopWebRuntime } from '../web/runtime';
import { DesktopAccountRoutes } from './accounts';
import {
  callControl,
  connectDesktopService,
  currentDesktopServiceGeneration,
  DesktopServiceRegistry,
  desktopServiceGeneration,
  openControl,
  type ServiceEndpoint,
} from './control';
import { DesktopWebEntry } from './web_entry';
import { RemoteRuntime } from '../remote/runtime';
import { RemoteWebGateway } from '../remote/web_gateway';
import { remoteConnectionMode, remoteInviteInput } from '../../shared/remote_bootstrap';
import { migrateRemoteDevices } from './remote_migration';
import { DesktopMcpGateway, mcpCredentialId } from './mcp_gateway';
import { McpGrants } from './mcp_grants';

export const DESKTOP_SERVICE_ARG = '--weq-desktop-service';

export async function runDesktopServices(options: {
  dataRoot: string;
  config: UserConfigService;
  publicDir: string;
  developmentUrl?: string;
  remoteDirectory: string;
  remoteHelper: string;
  quit: () => void;
}): Promise<() => void> {
  const { config, publicDir, developmentUrl } = options;
  const generation = currentDesktopServiceGeneration();
  const registry = new DesktopServiceRegistry(options.dataRoot);
  const accounts = new DesktopAccountRoutes(options.dataRoot, registry);
  const mcpGrants = new McpGrants(options.dataRoot);
  const mcp = new DesktopMcpGateway(accounts, (id) => {
    const settings = config.getSettings().mcp;
    if (!settings.enabled) return undefined;
    return mcpGrants.list(settings.token).find((grant) => grant.id === id)?.configIds;
  });
  const configureMcp = async () => {
    const settings = config.getSettings().mcp;
    await mcp.configure(settings.enabled ? { port: settings.port, token: settings.token } : null);
    return mcpStatus();
  };
  const mcpStatus = () => ({ running: mcp.boundPort !== null, port: mcp.boundPort });
  const web = new DesktopWebRuntime();
  const remote = new RemoteRuntime();
  web.configure({
    core: {
      assetsInstalled: !!developmentUrl || existsSync(join(publicDir, 'index.html')),
      entry: (auth) => new DesktopWebEntry({ auth, accounts, publicDir, developmentUrl }),
    },
    getAutoStart: () => config.getSettings().webServiceAutoStart,
    setAutoStart: (enabled) => config.setSettings({ webServiceAutoStart: enabled }),
  });
  migrateRemoteDevices(options.dataRoot, options.remoteDirectory);
  remote.configure({
    helper: options.remoteHelper,
    stateDir: options.remoteDirectory,
    web: () =>
      new RemoteWebGateway(
        remote.pairing,
        (auth) => new DesktopWebEntry({ auth, accounts, publicDir, developmentUrl }),
      ),
    onRequest: () => {
      void accounts
        .windows()
        .then(([window]) =>
          window
            ? callControl(window.control, 'reveal', undefined, AbortSignal.timeout(1000))
            : undefined,
        )
        .catch(() => undefined);
    },
  });
  async function remoteCommand(method: string, input: unknown): Promise<unknown> {
    switch (method) {
      case 'remote.enabled': {
        const { enabled, configId } = z
          .object({
            enabled: z.boolean(),
            configId: z.string().nullable(),
          })
          .parse(input);
        const exists = configId && accounts.list().some((account) => account.configId === configId);
        if (enabled) await remote.start(exists ? configId : null);
        else remote.stop(true);
        return remote.status();
      }
      case 'remote.mode':
        return remote.setMode(remoteConnectionMode.parse(input));
      case 'remote.tailscale':
        await remote.setTailscaleEnabled(z.boolean().parse(input));
        return remote.status();
      case 'remote.changeNetwork':
        return remote.changeNetwork();
      case 'remote.refreshNetwork':
        return remote.refreshNetwork();
      case 'remote.invite':
        return remote.invite(remoteInviteInput.parse(input));
      case 'remote.decide': {
        const { id, approve } = z
          .object({ id: z.string().uuid(), approve: z.boolean() })
          .parse(input);
        const configId = remote.defaultAccountConfigId();
        const exists = configId && accounts.list().some((account) => account.configId === configId);
        return remote.pairing.decide(id, approve, exists ? configId : null);
      }
      case 'remote.revoke':
        return remote.pairing.revoke(z.string().uuid().parse(input));
      case 'remote.accountConfigIds': {
        const { id, configIds } = z
          .object({
            id: z.string().uuid(),
            configIds: z.array(z.string()).max(256),
          })
          .parse(input);
        const saved = new Set(accounts.list().map((account) => account.configId));
        if (configIds.some((configId) => !saved.has(configId)))
          throw new Error('账号数据源已经变化。');
        return remote.pairing.setAccountConfigIds(id, configIds);
      }
      case 'remote.restore':
        return remote.restorePreferences(z.array(z.string()).parse(input));
      default:
        throw new Error('未知 WeQ Remote 服务命令。');
    }
  }
  let commandQueue: Promise<unknown> = Promise.resolve();
  const stopSettings = onSettingsChanged((change) => {
    if (!change?.fields.includes('mcp')) return;
    const pending = commandQueue.then(configureMcp);
    commandQueue = pending.catch((error: unknown) =>
      getLogger().warn('应用 MCP 共享设置失败', { error: String(error) }),
    );
  });
  const controller = await openControl((method, input) => {
    if (method === 'ping') return true;
    if (method === 'service.generation') return generation;
    if (method === 'service.retire') {
      const next = desktopServiceGeneration.parse(input);
      if (generation === null || next === null || next <= generation)
        throw new Error('只有更新的开发进程可以接管桌面服务。');
      setImmediate(options.quit);
      return true;
    }
    if (method === 'web.status') return web.status();
    if (method === 'web.token') return web.accessToken();
    if (method === 'remote.status') return remote.status();
    if (method === 'remote.preferences') return remote.preferences();
    if (method === 'remote.accounts') return accounts.list();
    if (method === 'mcp.status') return mcpStatus();
    if (method === 'mcp.grants')
      return { accounts: accounts.list(), grants: mcpGrants.list(config.getSettings().mcp.token) };
    const run = commandQueue.then(async () => {
      if (method.startsWith('remote.')) return remoteCommand(method, input);
      if (method === 'mcp.configure') {
        config.reload();
        return configureMcp();
      }
      if (method === 'mcp.rotate') {
        const { previous, next } = z
          .object({ previous: z.string(), next: z.string() })
          .parse(input);
        config.reload();
        if (next !== config.getSettings().mcp.token) throw new Error('MCP 令牌已变化。');
        mcpGrants.rotate(previous, next);
        mcp.invalidateCredential(mcpCredentialId(previous));
        return configureMcp();
      }
      if (method === 'mcp.grant') {
        const { id, configIds } = z
          .object({ id: z.string(), configIds: z.array(z.string()).max(256) })
          .parse(input);
        const saved = new Set(accounts.list().map((account) => account.configId));
        if (configIds.some((configId) => !saved.has(configId)))
          throw new Error('账号数据源已经变化。');
        mcpGrants.set(config.getSettings().mcp.token, id, configIds);
        mcp.invalidateCredential(id);
        return;
      }
      if (method === 'mcp.create')
        return mcpGrants.create(z.string().trim().min(1).max(64).parse(input));
      if (method === 'mcp.revoke') {
        const id = z.string().parse(input);
        if (id === mcpCredentialId(config.getSettings().mcp.token))
          throw new Error('默认令牌请使用重新生成操作。');
        mcpGrants.remove(id);
        mcp.invalidateCredential(id);
        return;
      }
      if (method === 'web.enabled') {
        if (z.boolean().parse(input)) await web.start();
        else web.stop();
      } else if (method === 'web.autoStart') {
        web.setAutoStart(z.boolean().parse(input));
      } else throw new Error('未知 WeQ 服务命令。');
      return web.status();
    });
    commandQueue = run.catch(() => undefined);
    return run;
  });
  const unpublish = await registry.publish('service', controller.endpoint);
  void configureMcp().catch((error: unknown) =>
    getLogger().warn('MCP 服务恢复失败', { error: String(error) }),
  );
  if (web.status().autoStart)
    void web
      .start()
      .catch((error: unknown) =>
        getLogger().warn('本机 Web 服务自动恢复失败', { error: String(error) }),
      );
  void remote
    .resume()
    .catch((error: unknown) => getLogger().warn('远程连接恢复失败', { error: String(error) }));
  let lastActive = Date.now();
  let checking = false;
  const lifecycle = setInterval(() => {
    if (checking) return;
    checking = true;
    void accounts
      .windows()
      .then((windows) => {
        if (windows.length) lastActive = Date.now();
        else if (Date.now() - lastActive >= 15000) options.quit();
      })
      .finally(() => {
        checking = false;
      });
  }, 2000);
  return () => {
    clearInterval(lifecycle);
    stopSettings();
    web.stop();
    remote.stop();
    void mcp.stop();
    controller.close();
    void unpublish();
  };
}

type WebStatus = ReturnType<DesktopWebRuntime['status']>;
type RemoteStatus = ReturnType<RemoteRuntime['status']>;

let desktopServices:
  | {
      getEndpoint: () => Promise<ServiceEndpoint>;
      state?: WebStatus;
      remote?: RemoteStatus;
      mcp?: { running: boolean; port: number | null };
    }
  | undefined;

export function connectDesktopServices(
  registry: DesktopServiceRegistry,
  launch: () => Promise<void>,
): void {
  let starting: Promise<ServiceEndpoint> | undefined;
  const generation = currentDesktopServiceGeneration();
  desktopServices = {
    getEndpoint: () =>
      (starting ??= connectDesktopService(registry, launch, generation).finally(() => {
        starting = undefined;
      })),
  };
}

export async function desktopWebStatus(): Promise<WebStatus> {
  if (!desktopServices) return desktopWebRuntime.status();
  const status = await callControl<WebStatus>(await desktopServices.getEndpoint(), 'web.status');
  desktopServices.state = status;
  return status;
}

export function desktopWebLastStatus(): WebStatus {
  return desktopServices?.state ?? desktopWebRuntime.status();
}

export async function setDesktopWebEnabled(enabled: boolean): Promise<WebStatus> {
  if (!desktopServices) {
    if (enabled) await desktopWebRuntime.start();
    else desktopWebRuntime.stop();
    return desktopWebRuntime.status();
  }
  const status = await callControl<WebStatus>(
    await desktopServices.getEndpoint(),
    'web.enabled',
    enabled,
  );
  desktopServices.state = status;
  return status;
}

export async function setDesktopWebAutoStart(enabled: boolean): Promise<WebStatus> {
  if (!desktopServices) {
    desktopWebRuntime.setAutoStart(enabled);
    return desktopWebRuntime.status();
  }
  const status = await callControl<WebStatus>(
    await desktopServices.getEndpoint(),
    'web.autoStart',
    enabled,
  );
  desktopServices.state = status;
  return status;
}

export async function desktopWebToken(): Promise<string> {
  if (!desktopServices) return desktopWebRuntime.accessToken();
  return callControl(await desktopServices.getEndpoint(), 'web.token');
}

export async function desktopServiceCommand<T>(
  method: string,
  input: unknown,
  fallback: () => T | Promise<T>,
): Promise<T> {
  if (!desktopServices) return fallback();
  const value = await callControl<T>(await desktopServices.getEndpoint(), method, input);
  if (method === 'remote.status') desktopServices.remote = value as RemoteStatus;
  if (method === 'mcp.status')
    desktopServices.mcp = value as { running: boolean; port: number | null };
  return value;
}

export function hostedRemoteRunning(): boolean | undefined {
  return desktopServices?.remote?.enabled;
}

export function hostedMcpRunning(): boolean | undefined {
  return desktopServices?.mcp?.running;
}

export function hasDesktopServices(): boolean {
  return desktopServices !== undefined;
}

export async function desktopMcpStatus(): Promise<{ running: boolean; port: number | null }> {
  return desktopServiceCommand('mcp.status', undefined, () => ({ running: false, port: null }));
}
