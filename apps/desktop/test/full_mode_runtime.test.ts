// @vitest-environment node
import { expect, it } from 'vitest';
import {
  assertFullModeSource,
  fullModeAllowed,
  retireFullModeSource,
} from '../src/main/context/full_mode';

function fixture() {
  let automatic = false;
  const account = { uin: '10001', configId: 'synthetic-live' };
  const host = {
    account: account as object | null,
    bootstrap: { userConfig: { getSettings: () => ({ autoAttachQq: automatic }) } },
  };
  return {
    host,
    account,
    auto: (value: boolean) => {
      automatic = value;
    },
  };
}
it('关闭设置时当前来源立即受限，切换来源后仍受限', () => {
  const f = fixture();
  f.auto(true);
  expect(fullModeAllowed(f.host)).toBe(true);
  f.auto(false);
  expect(fullModeAllowed(f.host)).toBe(false);
  f.host.account = { ...f.account };
  expect(fullModeAllowed(f.host)).toBe(false);
});
it('同号换源后即使设置开启，也拒绝旧来源操作', () => {
  const f = fixture();
  f.auto(true);
  f.host.account = { ...f.account, configId: 'synthetic-static' };
  expect(fullModeAllowed(f.host)).toBe(true);
  expect(() => assertFullModeSource(f.host, f.account)).toThrow('来源已切换');
  expect(fullModeAllowed(f.host, f.account)).toBe(false);
});
it('退出显式清除，即使重用旧对象也不恢复授权', () => {
  const f = fixture();
  f.auto(true);
  retireFullModeSource(f.host);
  f.host.account = null;
  expect(fullModeAllowed(f.host, f.account)).toBe(false);
  f.host.account = f.account;
  expect(fullModeAllowed(f.host)).toBe(false);
});
it('账号清理等待期间旧指针尚未替换，自动策略也不能继续旧来源工作', () => {
  const f = fixture();
  f.auto(true);
  expect(fullModeAllowed(f.host)).toBe(true);
  retireFullModeSource(f.host);
  expect(fullModeAllowed(f.host, f.account)).toBe(false);
  expect(() => assertFullModeSource(f.host, f.account)).toThrow();
  f.host.account = { ...f.account };
  expect(fullModeAllowed(f.host)).toBe(true);
});
