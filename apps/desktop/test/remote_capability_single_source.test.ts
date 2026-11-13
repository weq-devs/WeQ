import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import {
  APP_SEARCH_ENTRIES,
  searchAppEntries,
} from '../src/renderer/src/components/search/appSearchCatalog';
import {
  SETTINGS_ITEM_TARGETS,
  SETTINGS_PAGE_LABELS,
} from '../src/renderer/src/components/settings/navigation';
import { Card } from '../src/renderer/src/components/settings/controls';
import {
  REMOTE_BLOCKED_MAINTENANCE_TOOLS,
  REMOTE_BLOCKED_RESET_CARDS,
  REMOTE_BLOCKED_SETTING_IDS,
  REMOTE_BLOCKED_SETTING_ITEMS,
  REMOTE_BLOCKED_SETTING_PAGES,
  remoteMaintenanceToolAvailable,
  remoteResetCardAvailable,
  remoteSettingAvailable,
} from '../src/shared/remote_capabilities';

const state = vi.hoisted(() => ({ remote: false, resets: 0 }));
vi.mock('../src/renderer/src/lib/remoteClient', () => ({
  useRemoteClient: () => state.remote,
  isRemoteClient: () => state.remote,
}));
vi.mock('../src/renderer/src/components/settings/SettingsReset', () => ({
  SettingsResetButton: () => {
    state.resets += 1;
    return null;
  },
}));

afterEach(() => {
  state.remote = false;
  state.resets = 0;
  vi.unstubAllGlobals();
});

/**
 * 能力表是唯一真源：本测试不列具体禁项，而是**遍历表本身**。
 * 往 shared/remote_capabilities 里新增一条禁项而忘了让搜索/重置消费，这里就会红。
 */
it('搜索按能力表逐项过滤：表里每一项都不会被 Remote 搜到', () => {
  state.remote = true;
  const visibleIds = (keyword: string) => new Set(searchAppEntries(keyword).map((e) => e.id));
  const expectHidden = (keyword: string, id: string, reason: string) => {
    expect(visibleIds(keyword).has(id), `${reason}：${keyword}`).toBe(false);
  };

  for (const page of REMOTE_BLOCKED_SETTING_PAGES) {
    const label = SETTINGS_PAGE_LABELS[page as keyof typeof SETTINGS_PAGE_LABELS];
    if (!label) continue;
    for (const entry of APP_SEARCH_ENTRIES) {
      if (entry.target.kind !== 'setting') continue;
      if (entry.target.section !== page && !entry.id.includes(`:${page}:`)) continue;
      expectHidden(label, entry.id, `页面 ${page} 应整体隐藏`);
    }
  }

  for (const settingId of REMOTE_BLOCKED_SETTING_IDS) {
    const item = SETTINGS_ITEM_TARGETS.find((entry) => entry.id === settingId);
    for (const entry of APP_SEARCH_ENTRIES) {
      if (entry.target.kind !== 'setting') continue;
      const matches =
        entry.target.settingId === settingId ||
        entry.id.includes(`:${settingId}`) ||
        (item ? entry.target.item === item.label : false);
      if (!matches) continue;
      for (const keyword of [entry.title, ...entry.keywords]) {
        if (!keyword) continue;
        expectHidden(keyword, entry.id, `设置项 ${settingId} 应隐藏`);
      }
    }
  }

  for (const item of REMOTE_BLOCKED_SETTING_ITEMS) {
    const visible = searchAppEntries(item).map((entry) => entry.title);
    expect(visible, `行 ${item} 仍被搜到`).not.toContain(item);
  }
});

it('每条设置搜索结果都满足能力表：可见 ⇔ 未被表禁止', () => {
  state.remote = true;
  for (const entry of APP_SEARCH_ENTRIES) {
    if (entry.target.kind !== 'setting') continue;
    const resolved = searchAppEntries(entry.title).find((row) => row.id === entry.id);
    const allowed = remoteSettingAvailable(
      entry.target.section ?? '',
      entry.target.settingId,
      entry.target.item,
    );
    expect(Boolean(resolved), `${entry.id} 可见性与能力表不一致`).toBe(allowed);
  }
});

it('重置卡片按能力表遍历：表内一律不出现，表外正常渲染', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.remote = true;
  const host = document.createElement('div');
  const root = createRoot(host);
  const render = (card: string) =>
    act(() =>
      root.render(
        h(
          Card as never,
          {
            title: `卡片 ${card}`,
            resetId: card,
            children: '内容',
          } as never,
        ),
      ),
    );
  try {
    for (const card of REMOTE_BLOCKED_RESET_CARDS) {
      state.resets = 0;
      render(card);
      expect(remoteResetCardAvailable(card)).toBe(false);
      expect(state.resets, `${card} 的恢复默认按钮不该出现`).toBe(0);
    }
    state.resets = 0;
    render('general-kept');
    expect(state.resets, '表外卡片仍应渲染恢复默认').toBe(1);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('维护工具清单来自同一张表', () => {
  for (const tool of REMOTE_BLOCKED_MAINTENANCE_TOOLS)
    expect(remoteMaintenanceToolAvailable(tool)).toBe(false);
  expect(remoteMaintenanceToolAvailable('cache')).toBe(true);
  expect(remoteMaintenanceToolAvailable('database')).toBe(true);
});
