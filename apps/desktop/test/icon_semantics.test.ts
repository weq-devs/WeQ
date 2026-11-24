import './support/development-features.stub';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { APP_NAVIGATION, navigationEntries } from '../src/renderer/src/lib/appNavigation';
import { APP_SEARCH_ENTRIES } from '../src/renderer/src/components/search/appSearchCatalog';
import { AppSearchResults } from '../src/renderer/src/components/search/AppSearchResults';
import { appSearchIcon } from '../src/renderer/src/components/search/appSearchCatalog';
import { SETTINGS_PAGE_LABELS } from '../src/renderer/src/components/settings/navigation';
import { SETTINGS_PAGE_ICONS } from '../src/renderer/src/components/settings/pageIcons.shared';
import {
  DRESS_KIND_ICONS,
  EXPORT_MODE_ICONS,
  FEATURE_ICONS,
  MAINTENANCE_TOOL_ICONS,
} from '../src/renderer/src/lib/featureIcons.shared';
import {
  SEARCH_CATEGORY_ICONS,
  SEARCH_SOURCE_ICONS,
} from '../src/renderer/src/components/search/searchIcons';
import { SectionHeader } from '../src/renderer/src/components/settings/controls';

function shape(Icon: ComponentType<{ size?: number }>) {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(createElement(Icon));
  return host.querySelector('svg')!.innerHTML;
}

describe('功能图标语义', () => {
  it('QQ 空间保留实心品牌轮廓，不接受通用线稿图标的描边宽度', () => {
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(
      createElement(FEATURE_ICONS.qzone, { size: 22, strokeWidth: 1.8 }),
    );
    const svg = host.querySelector('svg')!;
    expect(svg.getAttribute('stroke')).toBe('none');
    expect(svg.getAttribute('stroke-width')).toBe('0');
    expect(svg.getAttribute('fill')).toBe('currentColor');
  });

  it('导航中的不同功能不共用同一个图标', () => {
    const icons = Object.values(APP_NAVIGATION).map(({ icon }) => shape(icon));
    expect(new Set(icons).size).toBe(icons.length);
  });

  it('功能搜索结果显示对应导航图标，而非全部显示设置图标', () => {
    for (const { label, icon: Icon } of navigationEntries('search')) {
      const entry = APP_SEARCH_ENTRIES.find(({ title }) => title === label)!;
      const host = document.createElement('div');
      host.innerHTML = renderToStaticMarkup(
        createElement(AppSearchResults, {
          keyword: '',
          entries: [entry],
          onSelect: vi.fn(),
          onExpand: vi.fn(),
        }),
      );
      expect(host.querySelector('.weq-search-source-icon svg')!.innerHTML, label).toBe(shape(Icon));
    }
  });

  it('设置页面和搜索入口的图标覆盖完整，不同页面不撞图标', () => {
    expect(Object.keys(SETTINGS_PAGE_ICONS).sort()).toEqual(
      Object.keys(SETTINGS_PAGE_LABELS).sort(),
    );
    for (const icons of [
      SETTINGS_PAGE_ICONS,
      EXPORT_MODE_ICONS,
      DRESS_KIND_ICONS,
      MAINTENANCE_TOOL_ICONS,
    ]) {
      const shapes = Object.values(icons).map(shape);
      expect(new Set(shapes).size).toBe(shapes.length);
    }
    for (const [page, Icon] of Object.entries(SETTINGS_PAGE_ICONS)) {
      const section = page as keyof typeof SETTINGS_PAGE_ICONS;
      expect(appSearchIcon({ kind: 'setting', section })).toBe(Icon);
      const host = document.createElement('div');
      host.innerHTML = renderToStaticMarkup(
        createElement(SectionHeader, { page: section, title: SETTINGS_PAGE_LABELS[section] }),
      );
      const svg = host.querySelector('svg')!;
      expect(svg.innerHTML, page).toBe(shape(Icon));
      expect(svg.getAttribute('width')).toBe('16');
      if (svg.classList.contains('lucide')) expect(svg.getAttribute('stroke-width')).toBe('1.8');
    }
  });

  it('导出和装扮子项使用对应的内容图标，旧设置目标仍正确解析', () => {
    for (const [exportMode, Icon] of Object.entries(EXPORT_MODE_ICONS))
      expect(
        appSearchIcon({
          kind: 'tool',
          tool: 'export',
          exportMode: exportMode as keyof typeof EXPORT_MODE_ICONS,
        }),
      ).toBe(Icon);
    for (const [dressKind, Icon] of Object.entries(DRESS_KIND_ICONS))
      expect(
        appSearchIcon({ kind: 'dressup', dressKind: dressKind as keyof typeof DRESS_KIND_ICONS }),
      ).toBe(Icon);
    expect(appSearchIcon({ kind: 'setting', section: 'database-tolerance' })).toBe(
      SETTINGS_PAGE_ICONS['database-management'],
    );
    expect(appSearchIcon({ kind: 'setting', section: 'help' })).toBe(SETTINGS_PAGE_ICONS.faq);
  });

  it('助手、克隆和频道私聊在搜索来源、内容筛选和功能导航保持同义', () => {
    expect(SEARCH_SOURCE_ICONS.assistant).toBe(APP_NAVIGATION.assistant.icon);
    expect(SEARCH_CATEGORY_ICONS.assistantMessage).toBe(SEARCH_SOURCE_ICONS.assistant);
    expect(SEARCH_CATEGORY_ICONS.cloneMessage).toBe(SEARCH_SOURCE_ICONS.clone);
    expect(SEARCH_CATEGORY_ICONS.guildMessage).toBe(APP_NAVIGATION['guild-direct'].icon);
    expect(SEARCH_CATEGORY_ICONS.qzone).toBe(APP_NAVIGATION.qzone.icon);
    expect(SEARCH_CATEGORY_ICONS.cloneMessage).not.toBe(FEATURE_ICONS.assistant);
    for (const [a, b] of [
      ['groupBulletin', 'groupEssence'],
      ['groupFile', 'flashFile'],
      ['qzonePost', 'qzoneAlbum'],
    ] as const)
      expect(shape(SEARCH_CATEGORY_ICONS[a])).not.toBe(shape(SEARCH_CATEGORY_ICONS[b]));
  });
});
