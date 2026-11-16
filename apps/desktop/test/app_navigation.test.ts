import { describe, expect, it, vi } from 'vitest';
import {
  APP_NAVIGATION,
  activateNavigation,
  navigationEntries,
  type AppNavigationActions,
} from '../src/renderer/src/lib/appNavigation';
import { APP_SEARCH_ENTRIES } from '../src/renderer/src/components/search/appSearchCatalog';

describe('共用功能导航', () => {
  it('各导航位置使用同一份名称、图标、目标和预加载配置', () => {
    for (const surface of ['rail', 'mobile-tabs', 'mobile-more', 'workspace'] as const) {
      const entries = navigationEntries(surface);
      expect(new Set(entries.map(({ id }) => id)).size).toBe(entries.length);
      for (const { id, ...entry } of entries)
        expect(entry).toEqual(APP_NAVIGATION[id as keyof typeof APP_NAVIGATION]);
    }
    const tabs = navigationEntries('mobile-tabs');
    expect(tabs.map(({ id }) => id)).toEqual(['messages', 'contacts', 'qzone', 'more']);
  });

  it('竖版更多不再展示频道、频道私聊和助手，保留搜索及横版频道入口', () => {
    const moreIds = navigationEntries('mobile-more').map(({ id }) => id);
    const searchIds = navigationEntries('search').map(({ id }) => id);
    for (const id of ['channel', 'guild-direct', 'assistant']) {
      expect(moreIds).not.toContain(id);
      expect(searchIds).toContain(id);
    }
    expect(navigationEntries('rail').map(({ id }) => id)).toContain('channel');
  });

  it('搜索与导航展示同名功能并指向相同目标', () => {
    for (const { label, target } of navigationEntries('search')) {
      const entry = APP_SEARCH_ENTRIES.find((entry) => entry.title === label);
      expect(entry?.target).toEqual(target);
    }
  });

  it('五个产品名称保持用户指定值，不提供布局专用别名', () => {
    expect([
      APP_NAVIGATION['friend-notice'].label,
      APP_NAVIGATION.qzone.label,
      APP_NAVIGATION.mail.label,
      APP_NAVIGATION.home.label,
      APP_NAVIGATION.collections.label,
    ]).toEqual(['好友通知', 'QQ 空间', 'QQ 邮箱', '主页', '收藏']);
  });

  it('统一目标分派保留页面、收藏、设置、装扮、工具和通知回调', () => {
    const actions: AppNavigationActions = {
      onViewChange: vi.fn(),
      onOpenCollection: vi.fn(),
      onOpenSettings: vi.fn(),
      onOpenDressUp: vi.fn(),
      onOpenTool: vi.fn(),
      onOpenNotice: vi.fn(),
    };
    for (const entry of Object.values(APP_NAVIGATION)) activateNavigation(entry.target, actions);
    for (const view of [
      'home',
      'messages',
      'contacts',
      'qzone',
      'mail',
      'channel',
      'guild-direct',
      'annual',
      'tools',
      'more',
    ])
      expect(actions.onViewChange).toHaveBeenCalledWith(view);
    expect(actions.onViewChange).not.toHaveBeenCalledWith('collections');
    expect(actions.onOpenCollection).toHaveBeenCalledOnce();
    expect(actions.onOpenSettings).toHaveBeenCalledOnce();
    expect(actions.onOpenDressUp).toHaveBeenCalledOnce();
    for (const tool of [
      'tasks',
      'assistant',
      'analysis',
      'export',
      'viewer',
      'backfill',
      'composition',
    ])
      expect(actions.onOpenTool).toHaveBeenCalledWith(tool);
    expect(actions.onOpenNotice).toHaveBeenCalledWith('friend');
    expect(actions.onOpenNotice).toHaveBeenCalledWith('group');
  });
});
