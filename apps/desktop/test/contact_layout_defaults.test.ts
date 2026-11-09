import { afterEach, expect, it, vi } from 'vitest';
import {
  loadLayoutNumber,
  DEFAULT_SIDEBAR_WIDTH,
} from '../src/renderer/src/im-template/template/layoutStorage';
afterEach(() => vi.unstubAllGlobals());
it('未保存栏宽使用指定的 240px 默认值，不把 null 转成零再夹到最小值', () => {
  vi.stubGlobal('window', { localStorage: { getItem: () => null } });
  expect(DEFAULT_SIDEBAR_WIDTH).toBe(240);
  expect(loadLayoutNumber('weq.desktop.sidebarWidth.v2', DEFAULT_SIDEBAR_WIDTH, 220, 520)).toBe(
    240,
  );
});
it.each(['', ' ', 'NaN'])('空白或非法宽度使用默认值：%s', (value) => {
  vi.stubGlobal('window', { localStorage: { getItem: () => value } });
  expect(loadLayoutNumber('width', 242, 220, 520)).toBe(242);
});
it('已有手动设置保留，超出范围仍执行原有夹取', () => {
  vi.stubGlobal('window', { localStorage: { getItem: () => '242.1328125' } });
  expect(loadLayoutNumber('width', 242, 220, 520)).toBe(242.1328125);
  vi.stubGlobal('window', { localStorage: { getItem: () => '800' } });
  expect(loadLayoutNumber('width', 242, 220, 520)).toBe(520);
});
