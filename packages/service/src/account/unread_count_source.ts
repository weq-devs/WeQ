import type { NtHelperBinding, QqUnreadSnapshot } from '@weq/native';

export const VERIFIED_QQ_UNREAD_LAYOUT = 'qqnt-macos-arm64-7.0.3-54395';
export const VERIFIED_WINDOWS_QQ_UNREAD_LAYOUT = 'qqnt-windows-x64-9.9.37-54395';
export const QQ_UNREAD_COVERAGE = 'instantiated-direct-and-group';

/** 来源负责身份校验；没有同批阅读边界的计数不得推算 QQ 阅读位置。 */
export interface UnreadCountSource {
  identity(): string | null;
  read(): Promise<QqUnreadSnapshot>;
  clear(): void;
}

export function createQqUnreadCountSource(
  nt: Pick<NtHelperBinding, 'getQqUnreadCapability' | 'readQqUnreadCounts' | 'clearQqUnreadCache'>,
  databasePath: string,
  resolvePid: () => number | null,
): UnreadCountSource | undefined {
  const layout =
    process.platform === 'darwin' && process.arch === 'arm64'
      ? VERIFIED_QQ_UNREAD_LAYOUT
      : process.platform === 'win32' && process.arch === 'x64'
        ? VERIFIED_WINDOWS_QQ_UNREAD_LAYOUT
        : undefined;
  if (!layout) return undefined;
  if (!nt.getQqUnreadCapability || !nt.readQqUnreadCounts || !nt.clearQqUnreadCache)
    return undefined;
  try {
    const capability = nt.getQqUnreadCapability();
    if (
      !capability.supported ||
      !capability.readOnly ||
      capability.coverage !== QQ_UNREAD_COVERAGE ||
      !capability.layouts.includes(layout)
    )
      return undefined;
  } catch {
    return undefined;
  }
  let ownedPid: number | null = null;
  return {
    identity: () => {
      const pid = resolvePid();
      return pid === null ? null : `${pid}:${databasePath}`;
    },
    async read() {
      const pid = resolvePid();
      if (ownedPid !== null && ownedPid !== pid) nt.clearQqUnreadCache!(ownedPid);
      ownedPid = pid;
      if (pid === null) throw new Error('QQ 未读来源不可用');
      return nt.readQqUnreadCounts!({ pid, databasePath, timeoutMs: 60000 });
    },
    clear() {
      if (ownedPid !== null) nt.clearQqUnreadCache!(ownedPid);
      ownedPid = null;
    },
  };
}
