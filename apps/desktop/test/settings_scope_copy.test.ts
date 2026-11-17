import { act, createElement as h, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  SettingsResetButton,
  SettingsResetProvider,
} from '../src/renderer/src/components/settings/SettingsReset';
import { searchAppEntries } from '../src/renderer/src/components/search/appSearchCatalog';
import { resolveSettingsTarget } from '../src/renderer/src/components/settings/navigation';
import type { SettingsResetItem } from '../src/shared/settings_reset';

const api = vi.hoisted(() => ({ preview: vi.fn(), restore: vi.fn() }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: { useUtils: () => ({}) },
  client: {
    settingsReset: { preview: { query: api.preview }, restore: { mutate: api.restore } },
  },
}));
vi.mock('../src/renderer/src/components/Dialog', () => ({
  Modal: ({ children }: { children: ReactNode }) => h('div', { role: 'dialog' }, children),
}));

const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  api.preview.mockReset();
  api.restore.mockReset();
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});

it('恢复预览省略全局标签，保留账号和设备标签且不改变范围数据', async () => {
  const items: SettingsResetItem[] = [
    { id: 'shared', label: '通用设置', scope: '全局', current: true, defaultValue: false },
    { id: 'account', label: '账号设置', scope: '当前账号', current: true, defaultValue: false },
    { id: 'device', label: '设备设置', scope: '此设备', current: true, defaultValue: false },
  ];
  api.preview.mockResolvedValue({ source: 'synthetic-source', items });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  act(() => root.render(h(SettingsResetProvider, { page: 'qzone' }, h(SettingsResetButton))));
  await act(async () => host.querySelector<HTMLButtonElement>('button')!.click());
  const rows = [...host.querySelectorAll('.weq-settings-reset-item')];
  expect(rows).toHaveLength(3);
  expect(rows[0]!.querySelector('small')).toBeNull();
  expect(rows.slice(1).map((row) => row.querySelector('small')?.textContent)).toEqual([
    '当前账号',
    '此设备',
  ]);
  expect(host.querySelector('[role="dialog"]')?.textContent).not.toContain('全局');
  expect(items.map((item) => item.scope)).toEqual(['全局', '当前账号', '此设备']);
  expect(api.restore).not.toHaveBeenCalled();
});

it.each(['意图模型资源', '意图模型资源（全局）'])(
  '搜索 %s 显示精简名称，旧名称仍可定位',
  (keyword) => {
    const matches = searchAppEntries(keyword).filter(
      (entry) =>
        entry.target.kind === 'setting' && entry.target.settingId === 'intent-model-resources',
    );
    expect(matches).not.toHaveLength(0);
    expect(matches.every((entry) => entry.title === '意图模型资源')).toBe(true);
    expect(resolveSettingsTarget({ section: 'intent-models', item: keyword })).toEqual({
      section: 'intent-sense',
      item: '意图模型资源',
      settingId: 'intent-model-resources',
    });
  },
);
