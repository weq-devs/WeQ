import type { QQRuntimeDependencies } from './qq_runtime';

export interface QQExternalRuntimeSource {
  uin: string;
  uid(): string | null;
  resolvePid(): Promise<number | null>;
  hasLease(pid: number): boolean;
  hasNativeSession(pid: number): Promise<boolean>;
  isCurrent(): boolean;
  databaseReady(): boolean;
  pushReady(): boolean;
}

/** 接现有检测与登记链路，只观察，不读内存、不另行上线、更不结束 QQ。 */
export function createExternalQQRuntimeProbe(
  source: QQExternalRuntimeSource,
): QQRuntimeDependencies['inspectExternal'] {
  return async (uin, signal) => {
    const current = () => !signal.aborted && source.isCurrent();
    if (uin !== source.uin || !current()) return null;
    const pid = await source.resolvePid();
    if (!current()) throw new Error('QQ 运行时账号已切换');
    if (pid === null) return null;
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('QQ 检测返回了无效进程');
    const rawUid = source.uid();
    const uid = rawUid && /^u_[A-Za-z0-9_-]+$/.test(rawUid) ? rawUid : null;
    const registered = source.hasLease(pid) && (await source.hasNativeSession(pid));
    if (!current()) throw new Error('QQ 运行时账号已切换');
    const sso = Boolean(uid && registered && source.hasLease(pid));
    const database = source.databaseReady();
    return {
      pid,
      account: { uin, uid },
      phase: sso && database ? 'online' : 'initializing-session',
      capabilities: { login: false, sso, database, push: source.pushReady() },
      qr: null,
      error: null,
    };
  };
}
