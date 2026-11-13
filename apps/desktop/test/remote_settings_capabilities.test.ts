import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { searchAppEntries } from '../src/renderer/src/components/search/appSearchCatalog';
import { Card, Row } from '../src/renderer/src/components/settings/controls';
import { remoteSettingAvailable } from '../src/shared/remote_capabilities';

const state = vi.hoisted(() => ({ remote: false }));
vi.mock('../src/renderer/src/lib/remoteClient', () => ({
  useRemoteClient: () => state.remote,
  isRemoteClient: () => state.remote,
}));
vi.mock('../src/renderer/src/components/settings/SettingsReset', () => ({
  SettingsResetButton: () => null,
}));
afterEach(() => {
  state.remote = false;
  vi.unstubAllGlobals();
});

it.each([390, 844, 1180])('Remote 设置与搜索按身份过滤电脑入口，宽度 %s 不改变结果', (width) => {
  state.remote = true;
  vi.stubGlobal('innerWidth', width);
  expect(searchAppEntries('开机自动启动')).toHaveLength(0);
  expect(searchAppEntries('关联资源目录')).toHaveLength(0);
  expect(searchAppEntries('资源清理')).toHaveLength(0);
  expect(searchAppEntries('导出明文数据库').length).toBeGreaterThan(0);
  expect(searchAppEntries('配置备份').length).toBeGreaterThan(0);
  expect(remoteSettingAvailable('database-management')).toBe(true);
});

it('电脑窄窗口仍保留电脑设置，Remote 只隐藏明确的电脑卡片和行', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('innerWidth', 390);
  expect(searchAppEntries('开机自动启动').length).toBeGreaterThan(0);
  const host = document.createElement('div');
  const root = createRoot(host);
  const render = () =>
    act(() =>
      root.render(
        h(
          'div',
          null,
          h(Card, { title: '电脑目录', remoteUnsupported: true }, '电脑文件选择'),
          h(Row, {
            label: '电脑目录行',
            remoteUnsupported: true,
            control: h('button', null, '选择'),
          }),
          h(Card, { title: '设备上传' }, '上传'),
        ),
      ),
    );
  try {
    render();
    expect(host.textContent).toContain('电脑目录');
    state.remote = true;
    render();
    expect(host.textContent).not.toContain('电脑目录');
    expect(host.textContent).toContain('设备上传');
  } finally {
    act(() => root.unmount());
  }
});
