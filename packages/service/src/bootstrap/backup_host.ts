import { isRecord } from '../common/client_preferences';
import type { MonitorSettings } from '../performance/types';
import { parseWeqBackupJson, type WeqBackupBundle } from './backup_bundle';
import { BACKUP_HOST_PATHS } from './backup_selective';

export interface WeqBackupHost {
  paths?: Partial<Record<(typeof BACKUP_HOST_PATHS)[number], string | null>>;
  services?: {
    webEnabled?: boolean;
    remoteEnabled?: boolean;
    remoteMode?: 'lan' | 'existing' | 'tailscale';
    tailscaleEnabled?: boolean;
    qqProxyEnabled?: boolean;
    qqProxyPort?: number;
  };
  device?: {
    systemAutostart?: boolean;
    nativeDebugLog?: boolean;
    performance?: MonitorSettings;
  };
}

function fields(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).every((key) => keys.includes(key));
}

function integer(value: unknown, min: number, max: number) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

function checkBools(value: Record<string, unknown>, keys: readonly string[]) {
  return keys.every((key) => value[key] === undefined || typeof value[key] === 'boolean');
}

export function validateBackupHost(value: unknown): asserts value is WeqBackupHost {
  const invalid = () => {
    throw new Error('备份的设备或服务配置无效');
  };
  if (!fields(value, ['paths', 'services', 'device'])) return invalid();
  const { paths, services, device } = value;
  if (
    paths !== undefined &&
    (!fields(paths, BACKUP_HOST_PATHS) ||
      Object.values(paths).some(
        (path) =>
          path !== null && (typeof path !== 'string' || path.length > 4096 || path.includes('\0')),
      ))
  )
    invalid();
  const serviceFlags = ['webEnabled', 'remoteEnabled', 'tailscaleEnabled', 'qqProxyEnabled'];
  if (
    services !== undefined &&
    (!fields(services, [...serviceFlags, 'remoteMode', 'qqProxyPort']) ||
      !checkBools(services, serviceFlags) ||
      (services.remoteMode !== undefined &&
        !['lan', 'existing', 'tailscale'].includes(String(services.remoteMode))) ||
      (services.qqProxyPort !== undefined && !integer(services.qqProxyPort, 1, 65535)))
  )
    invalid();
  if (device === undefined) return;
  const deviceFlags = ['systemAutostart', 'nativeDebugLog'];
  if (!fields(device, [...deviceFlags, 'performance']) || !checkBools(device, deviceFlags))
    return invalid();
  const perf = device.performance;
  if (
    perf !== undefined &&
    (!fields(perf, ['version', 'mode', 'retentionDays', 'capacityMiB', 'fullUntil']) ||
      perf.version !== 1 ||
      !['off', 'light', 'full'].includes(String(perf.mode)) ||
      !integer(perf.retentionDays, 1, 365) ||
      typeof perf.capacityMiB !== 'number' ||
      ![64, 128, 256, 512].includes(perf.capacityMiB) ||
      (perf.fullUntil !== null && !integer(perf.fullUntil, 0, Number.MAX_SAFE_INTEGER)))
  )
    invalid();
}

export function readBackupHost(bundle: WeqBackupBundle): WeqBackupHost | undefined {
  const file = bundle.files.find(({ path }) => path === 'settings/host.json');
  if (!file) return;
  const value = parseWeqBackupJson(file.data);
  validateBackupHost(value);
  return value;
}
