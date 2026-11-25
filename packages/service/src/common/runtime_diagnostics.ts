import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { release, version } from 'node:os';
import { parseEnv } from 'node:util';
import type { NativeBuildInfo } from '@weq/native';
import { initLogger } from './logger';

interface RuntimeIdentity {
  version: string;
  build?: { commit: string | null; builtAt: string };
  mode: 'development' | 'production';
  host: 'desktop' | 'desktop-service' | 'web';
}

interface ComponentDiagnostics {
  ntHelper: { state: 'ready' | 'expired' | 'damaged'; build: NativeBuildInfo | null };
  qqVersion: string | null;
  qqProxy: {
    state: 'disabled' | 'unavailable' | 'listening' | 'connecting' | 'connected';
    protocolVersion?: number;
    error?: string;
  };
  dataSource: 'local-qq' | 'desktop-backup' | 'mobile-backup' | 'none';
}

let environment:
  | (RuntimeIdentity &
      Partial<ComponentDiagnostics> & {
        platform: NodeJS.Platform;
        arch: string;
        osVersion: string;
        osRelease: string;
        electron?: string;
        node: string;
      })
  | undefined;

function operatingSystemVersion(): string {
  try {
    if (process.platform === 'linux') {
      for (const path of ['/etc/os-release', '/usr/lib/os-release']) {
        try {
          const os = parseEnv(readFileSync(path, 'utf8'));
          if (os.PRETTY_NAME) return os.PRETTY_NAME;
        } catch {
          // 容器可能只提供其中一个路径。
        }
      }
    }
    if (process.platform === 'darwin') {
      const desktopProcess = process as NodeJS.Process & { getSystemVersion?(): string };
      return (
        desktopProcess.getSystemVersion?.() ??
        execFileSync('/usr/bin/sw_vers', ['-productVersion'], {
          encoding: 'utf8',
          timeout: 1000,
        }).trim()
      );
    }
  } catch {
    // 系统版本读取失败时仍保留 Node 识别到的系统与内核版本。
  }
  return version();
}

export function initRuntimeLogging(root: string, identity: RuntimeIdentity): void {
  environment = {
    ...identity,
    platform: process.platform,
    arch: process.arch,
    osVersion: operatingSystemVersion(),
    osRelease: release(),
    electron: process.versions.electron,
    node: process.versions.node,
    dataSource: 'none',
  };
  initLogger(root, () => ({ ...environment }));
}

/** 返回是否观察到变化，供调用方只记录状态转换。 */
export function updateRuntimeDiagnostics<K extends keyof ComponentDiagnostics>(
  key: K,
  value: ComponentDiagnostics[K],
): boolean {
  if (!environment || JSON.stringify(environment[key]) === JSON.stringify(value)) return false;
  environment = { ...environment, [key]: value };
  return true;
}

export function runtimeDiagnosticsMarkdown(): string {
  if (!environment) return '';
  const { version, build, mode, host, platform, osVersion, osRelease, arch, electron, node } =
    environment;
  const { ntHelper, qqVersion, qqProxy, dataSource } = environment;
  const lines = [
    '## 运行环境（自动记录）',
    '',
    `- WeQ：${version} · ${host} · ${mode}`,
    `- 系统：${platform} ${osVersion}（内核 ${osRelease}）· ${arch}`,
    `- 运行时：Node.js ${node}${electron ? ` · Electron ${electron}` : ''}`,
  ];
  if (build) lines.push(`- 构建：${build.commit ?? '提交未知'} · ${build.builtAt}`);
  if (ntHelper) {
    const nativeTime = new Date((ntHelper.build?.buildTime ?? Number.NaN) * 1000);
    const buildLabel = Number.isFinite(nativeTime.getTime())
      ? nativeTime.toISOString()
      : ntHelper.build?.isDev
        ? '本地开发构建'
        : '构建时间未知';
    const state = { ready: '已加载', expired: '已过期', damaged: '加载失败' }[ntHelper.state];
    lines.push(`- nt_helper：${state} · ${buildLabel}`);
  }
  if (qqVersion !== undefined) lines.push(`- QQ：${qqVersion ?? '未检测到版本'}`);
  if (qqProxy) {
    const state = {
      disabled: '已关闭',
      unavailable: '未就绪',
      listening: '等待连接',
      connecting: '正在连接',
      connected: '已连接',
    }[qqProxy.state];
    lines.push(`- QQ 代理：${state}`);
  }
  if (dataSource) {
    const source = {
      'local-qq': '本机 QQ',
      'desktop-backup': '电脑备份',
      'mobile-backup': '手机备份',
      none: '未打开账号',
    }[dataSource];
    lines.push(`- 数据来源：${source}`);
  }
  return lines.join('\n');
}
