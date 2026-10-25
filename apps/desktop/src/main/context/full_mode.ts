interface FullModeHost {
  account: object | null;
  bootstrap: { userConfig: { getSettings(): { autoAttachQq: boolean } } } | null;
}

/** 宿主与完整会话实例双重绑定；不进入配置、备份或 renderer 状态。 */
const manualRequests = new WeakMap<FullModeHost, object>();

export function fullModeAllowed(host: FullModeHost, expected = host.account): boolean {
  if (host.account !== expected) return false;
  return Boolean(
    host.bootstrap?.userConfig.getSettings().autoAttachQq ||
      (expected && manualRequests.get(host) === expected),
  );
}

export function requestFullMode(host: FullModeHost, expected: object): void {
  if (host.account !== expected) throw new Error('账号来源已切换，请重新启用完整功能');
  manualRequests.set(host, expected);
}

export function clearFullMode(host: FullModeHost): void {
  manualRequests.delete(host);
}
