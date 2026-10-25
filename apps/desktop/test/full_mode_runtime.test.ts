// @vitest-environment node
import { expect, it } from 'vitest';
import { clearFullMode, fullModeAllowed, requestFullMode } from '../src/main/context/full_mode';

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
it('关闭自动仍可手动请求，重新读/renderer 重载不丢，偏好保持关闭', () => {
  const f = fixture();
  expect(fullModeAllowed(f.host)).toBe(false);
  requestFullMode(f.host, f.account);
  expect(fullModeAllowed(f.host)).toBe(true);
  expect(fullModeAllowed(f.host)).toBe(true);
  expect(f.host.bootstrap.userConfig.getSettings().autoAttachQq).toBe(false);
  expect(JSON.stringify(f.host)).not.toContain('manual');
});
it('自动策略与手动请求独立，关闭自动不撤销手动请求；仅自动时立即受限', () => {
  const f = fixture();
  f.auto(true);
  expect(fullModeAllowed(f.host)).toBe(true);
  f.auto(false);
  expect(fullModeAllowed(f.host)).toBe(false);
  f.auto(true);
  requestFullMode(f.host, f.account);
  f.auto(false);
  expect(fullModeAllowed(f.host)).toBe(true);
});
it('同号换源/重开会话/换宿主不能继承，旧请求不能授权新来源', () => {
  const f = fixture();
  requestFullMode(f.host, f.account);
  f.host.account = { ...f.account, configId: 'synthetic-static' };
  expect(fullModeAllowed(f.host)).toBe(false);
  expect(() => requestFullMode(f.host, f.account)).toThrow('来源已切换');
  expect(fullModeAllowed(f.host, f.account)).toBe(false);
  f.host.account = { ...f.account };
  expect(fullModeAllowed(f.host)).toBe(false);
  expect(fullModeAllowed({ ...f.host })).toBe(false);
});
it('退出显式清除，即使重用旧对象也不恢复授权', () => {
  const f = fixture();
  requestFullMode(f.host, f.account);
  clearFullMode(f.host);
  f.host.account = null;
  expect(fullModeAllowed(f.host)).toBe(false);
  f.host.account = f.account;
  expect(fullModeAllowed(f.host)).toBe(false);
});
