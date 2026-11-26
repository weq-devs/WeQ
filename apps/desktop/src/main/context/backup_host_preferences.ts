import {
  finishWeqBackupHostRestore,
  getHost,
  type WeqBackupHost,
  type WeqRestoreResult,
} from '@weq/service';
import { getPerformanceMonitor } from '@weq/service/performance';
import {
  desktopServiceCommand,
  desktopWebStatus,
  setDesktopWebEnabled,
} from '../desktop_services/host';
import { nativeDebugLogStatus, setNativeDebugLog } from '../ipc/routers/help';
import { qqSyncStatus, setQqSyncPort, setQqSyncProxyEnabled } from '../qq_sync/runtime';
import { remoteRuntime } from '../remote/runtime';
import { getAppContext } from './app_context';

export async function readBackupHostPreferences(
  sections: readonly string[],
  desktop: boolean,
): Promise<WeqBackupHost> {
  const options: WeqBackupHost = {};
  if (desktop && sections.includes('services')) {
    const proxyRoot = getAppContext().bootstrap?.qqSyncRoot;
    const [web, remote, proxy] = await Promise.all([
      desktopWebStatus(),
      desktopServiceCommand('remote.preferences', undefined, () => remoteRuntime.preferences()),
      proxyRoot ? qqSyncStatus(proxyRoot) : null,
    ]);
    options.services = {
      webEnabled: web.enabled,
      remoteEnabled: remote.enabled,
      remoteMode: remote.mode,
      tailscaleEnabled: remote.tailscaleEnabled,
      ...(proxy ? { qqProxyEnabled: proxy.enabled, qqProxyPort: proxy.port } : {}),
    };
  }
  if (sections.includes('device')) {
    const host = getHost();
    const autostart = desktop && host.canAutostart ? await host.getAutostart?.() : null;
    const debug = desktop ? nativeDebugLogStatus() : null;
    let performance: WeqBackupHost['device'];
    try {
      performance = { performance: getPerformanceMonitor().settings };
    } catch {
      // 组件诊断界面可在性能监视初始化前导出备份。
    }
    const device = {
      ...performance,
      ...(autostart ? { systemAutostart: autostart.enabled || autostart.registered } : {}),
      ...(debug?.available ? { nativeDebugLog: debug.enabled } : {}),
    };
    if (Object.keys(device).length) options.device = device;
  }
  return options;
}

export async function applyRestoredHostPreferences(
  root: string,
  result: WeqRestoreResult,
  desktop: boolean,
) {
  const pending = result.hostPending;
  if (result.status !== 'applied' || !pending) return;
  const { services, device } = pending.options;
  const attempt = async (label: string, run: () => unknown) => {
    try {
      await run();
    } catch (error) {
      result.warnings.push(
        `${label}未应用：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  if (services && desktop) {
    const { qqProxyPort, qqProxyEnabled, remoteEnabled, remoteMode, tailscaleEnabled, webEnabled } =
      services;
    const proxyRoot = getAppContext().bootstrap?.qqSyncRoot;
    if (qqProxyPort !== undefined && proxyRoot)
      await attempt('QQ 代理端口', async () => {
        const proxy = await qqSyncStatus(proxyRoot);
        if (!pending.activateServices && proxy.enabled) {
          if (proxy.port !== qqProxyPort) throw new Error('当前代理正在运行');
          return;
        }
        await setQqSyncPort(proxyRoot, qqProxyPort);
      });
    if (pending.activateServices) {
      if (qqProxyEnabled !== undefined && proxyRoot)
        await attempt('QQ 代理', () => setQqSyncProxyEnabled(proxyRoot, qqProxyEnabled));
      if (remoteMode !== undefined)
        await attempt('Remote 连接模式', () =>
          desktopServiceCommand('remote.mode', remoteMode, () => remoteRuntime.setMode(remoteMode)),
        );
      if (tailscaleEnabled !== undefined)
        await attempt('Tailscale', () =>
          desktopServiceCommand('remote.tailscale', tailscaleEnabled, async () => {
            await remoteRuntime.setTailscaleEnabled(tailscaleEnabled);
            return remoteRuntime.status();
          }),
        );
      if (remoteEnabled !== undefined)
        await attempt('Remote', () =>
          desktopServiceCommand(
            'remote.enabled',
            { enabled: remoteEnabled, configId: null },
            async () => {
              if (remoteEnabled) await remoteRuntime.start();
              else remoteRuntime.stop(true);
              return remoteRuntime.status();
            },
          ),
        );
      if (webEnabled !== undefined)
        await attempt('Web 服务', () => setDesktopWebEnabled(webEnabled));
    }
  }
  if (device?.performance)
    await attempt('性能记录', () => getPerformanceMonitor().configure(device.performance!, false));
  if (device && desktop) {
    if (device.systemAutostart !== undefined)
      await attempt('系统登录自启', async () => {
        const host = getHost();
        if (!host.setAutostart) throw new Error('当前系统未提供开机启动设置');
        await host.setAutostart(device.systemAutostart!);
      });
    if (device.nativeDebugLog !== undefined)
      await attempt('原生调试日志', () => {
        const value = setNativeDebugLog(device.nativeDebugLog!);
        if (!value.ok || value.enabled !== device.nativeDebugLog)
          throw new Error(value.error || '未生效');
      });
  }
  if (
    !desktop &&
    (services || device?.nativeDebugLog !== undefined || device?.systemAutostart !== undefined)
  )
    result.warnings.push('系统自启、原生调试和本机连接设置需在桌面端导入。');
  finishWeqBackupHostRestore(root, result);
}
