import { act, createElement as h, Profiler, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { AppRail } from '../src/renderer/src/im-template/template/rail';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import type { MainView } from '../src/renderer/src/im-template/template/types';

afterEach(() => vi.unstubAllGlobals());

const noop = () => {};
const props = {
  user: createTemplateDemoData().user,
  onOpenSettings: noop,
  onOpenCollection: noop,
  onOpenDressUp: noop,
  onOpenProfile: noop,
  onOpenAbout: noop,
  onOpenInvite: noop,
  onOpenWonderfulTools: noop,
  onOpenAntiRecall: noop,
  onOpenDbRepair: noop,
  onOpenQzoneAlbum: noop,
};

it('点击消息入口时实际视图与图标高亮同一次提交，不单独排入低优先级更新', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const commits: Array<{ active: boolean; view: string | null }> = [];
  function Harness() {
    const [view, setView] = useState<MainView>('contacts');
    return h(
      Profiler,
      {
        id: 'navigation',
        onRender: () => {
          commits.push({
            active:
              host.querySelector('.rail-tab-messages')?.getAttribute('aria-current') === 'page',
            view:
              host.querySelector('[data-active-view]')?.getAttribute('data-active-view') ?? null,
          });
        },
      },
      h(AppRail, { ...props, view, onViewChange: setView }),
      h('main', { 'data-active-view': view }, view),
    );
  }
  try {
    act(() => root.render(h(Harness)));
    commits.length = 0;
    act(() => host.querySelector<HTMLButtonElement>('.rail-tab-messages')!.click());
    expect(commits.length).toBeGreaterThan(0);
    expect(commits.every((commit) => commit.active && commit.view === 'messages')).toBe(true);
    act(() => host.querySelector<HTMLButtonElement>('.rail-tab-contacts')!.click());
    act(() => host.querySelector<HTMLButtonElement>('.rail-tab-messages')!.click());
    expect(host.querySelector('[data-active-view]')?.getAttribute('data-active-view')).toBe(
      'messages',
    );
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('未读角标没有可定位目标时不伪造消息页高亮', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    act(() =>
      root.render(
        h(AppRail, {
          ...props,
          view: 'contacts',
          onViewChange: noop,
          messageBadgeCount: 1,
          onMessageBadgeClick: noop,
        }),
      ),
    );
    act(() => host.querySelector<HTMLButtonElement>('.rail-message-badge')!.click());
    expect(host.querySelector('.rail-tab-contacts')?.getAttribute('aria-current')).toBe('page');
    expect(host.querySelector('.rail-tab-messages')?.getAttribute('aria-current')).toBeNull();
  } finally {
    act(() => root.unmount());
  }
});
