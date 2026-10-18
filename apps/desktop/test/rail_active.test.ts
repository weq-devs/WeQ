import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { AppRail } from '../src/renderer/src/im-template/template/rail';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';

it('收藏与后部页面入口按实际页面高亮，返回消息后清除旧高亮', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host),
    noop = () => {};
  const props = {
    user: createTemplateDemoData().user,
    onViewChange: noop,
    onOpenSettings: noop,
    onOpenCollection: noop,
    onOpenMarketBrowser: noop,
    onOpenDressUp: noop,
    onOpenProfile: noop,
    onOpenAbout: noop,
    onOpenInvite: noop,
    onOpenWonderfulTools: noop,
    onOpenAntiRecall: noop,
    onOpenDbRepair: noop,
    onOpenQzoneAlbum: noop,
  };
  try {
    act(() => root.render(h(AppRail, { ...props, view: 'collections' })));
    expect(host.querySelector('.rail-tab-collection')?.classList.contains('active')).toBe(true);
    for (const activeRailItem of ['market', 'dressup', 'settings'] as const) {
      act(() => root.render(h(AppRail, { ...props, view: 'messages', activeRailItem })));
      expect(host.querySelectorAll('.rail-tab.active')).toHaveLength(1);
      expect(host.querySelector(`.rail-tab-${activeRailItem}`)?.getAttribute('aria-current')).toBe(
        'page',
      );
    }
    act(() => root.render(h(AppRail, { ...props, view: 'messages' })));
    expect(host.querySelector('.rail-tab-messages')?.classList.contains('active')).toBe(true);
    expect(host.querySelector('.rail-tab-settings')?.classList.contains('active')).toBe(false);
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
