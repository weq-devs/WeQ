interface FullModeHost {
  account: object | null;
  bootstrap: { userConfig: { getSettings(): { autoAttachQq: boolean } } } | null;
}

const retiredSources = new WeakSet<object>();

export function fullModeAllowed(host: FullModeHost, expected = host.account): boolean {
  if (host.account !== expected || (expected && retiredSources.has(expected))) return false;
  return host.bootstrap?.userConfig.getSettings().autoAttachQq === true;
}

export function assertFullModeSource(host: FullModeHost, expected: object): void {
  if (host.account !== expected || retiredSources.has(expected))
    throw new Error('账号来源已切换或关闭，请重新启用 QQ 在线能力');
}

export function retireFullModeSource(host: FullModeHost): void {
  if (host.account) retiredSources.add(host.account);
}
