import { afterEach, expect, it, vi } from 'vitest';
import { isRemoteClient } from '../src/renderer/src/lib/remoteClient';

const target = vi.hoisted(() => ({ web: true }));
vi.mock('../src/renderer/src/lib/target', () => ({
  get IS_WEB() {
    return target.web;
  },
}));
afterEach(() => {
  delete window.weqRemoteShell;
  target.web = true;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([390, 844, 1180])('Remote 身份不随宽度 %s 改变', (width) => {
  vi.stubGlobal('innerWidth', width);
  vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 WeQRemote/1.0');
  expect(isRemoteClient()).toBe(true);
});

it('普通电脑窄窗不变成 Remote，壳稍晚注入也可识别', () => {
  vi.stubGlobal('innerWidth', 390);
  vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0');
  expect(isRemoteClient()).toBe(false);
  window.weqRemoteShell = { openMenu() {} };
  expect(isRemoteClient()).toBe(true);
  target.web = false;
  expect(isRemoteClient()).toBe(false);
});
