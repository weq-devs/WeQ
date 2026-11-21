import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import AnnouncementPanel from '../src/renderer/src/components/AnnouncementPanel';
import { onNotificationNavigation } from '../src/renderer/src/lib/notificationNavigation.shared';

const fixture = vi.hoisted(() => ({
  detail: {
    id: 'release-2-8-0',
    title: 'WeQ 2.8.0',
    body: '更新内容',
    level: 'normal',
    publishedAt: '2026-11-18T16:00:00Z',
    releasePageUrl: null as string | null,
  },
  openExternal: vi.fn(async () => ({ ok: true })),
  refresh: vi.fn(),
  markRead: vi.fn(),
  reset: vi.fn(),
}));

vi.mock('../src/renderer/src/lib/openExternalLink', () => ({
  openExternalLink: fixture.openExternal,
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    useUtils: () => ({}),
    announcements: {
      detail: { useQuery: () => ({ data: fixture.detail }) },
      refresh: { useMutation: () => ({ mutate: fixture.refresh }) },
      markRead: { useMutation: () => ({ mutate: fixture.markRead, reset: fixture.reset }) },
    },
  },
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it('公告打开时按需补读，断网时保留已显示的列表并可立即重试', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const root = createRoot(document.createElement('div'));
  const entry = {
    id: 'release-2-8-0',
    title: 'WeQ 2.8.0',
    level: 'normal' as const,
    publishedAt: '2026-11-18T16:00:00Z',
    unread: false,
  };
  const render = (status: 'ready' | 'cached') =>
    act(() =>
      root.render(
        h(AnnouncementPanel, {
          selected: null,
          onClose() {},
          onSelect() {},
          listFailed: false,
          canOpenUpdateSettings: false,
          list: { status, entries: [entry], unread: 0, reminder: null },
        }),
      ),
    );
  const retry = () =>
    [...document.querySelectorAll('button')].find((b) => b.textContent === '重试');
  try {
    render('ready');
    expect(fixture.refresh.mock.calls).toEqual([[{ ifStale: true }]]);
    expect(retry()).toBeUndefined();
    render('cached');
    expect(document.body.textContent).toContain(entry.title);
    act(() => retry()!.click());
    expect(fixture.refresh.mock.calls).toEqual([[{ ifStale: true }], [undefined]]);
  } finally {
    act(() => root.unmount());
  }
});

it('发布公告依据当前页面选择软件更新定位或官方发布页；升级后只保留正文', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const root = createRoot(document.createElement('div'));
  const close = vi.fn();
  const navigate = vi.fn();
  const unsubscribe = onNotificationNavigation(navigate);
  const render = (canOpenUpdateSettings: boolean) =>
    act(() =>
      root.render(
        h(AnnouncementPanel, {
          selected: fixture.detail.id,
          onClose: close,
          onSelect: () => {},
          listFailed: false,
          canOpenUpdateSettings,
        }),
      ),
    );
  const action = (label: string) =>
    [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === label);
  try {
    fixture.detail.releasePageUrl = 'https://github.com/weq-devs/WeQ/releases/tag/v2.8.0';
    render(true);
    expect(action('查看发布页')).toBeUndefined();
    act(() => action('前往更新')!.click());
    expect(close).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith({
      kind: 'app',
      target: { kind: 'setting', section: 'version', settingId: 'software-update' },
    });
    expect(fixture.openExternal).not.toHaveBeenCalled();

    render(false);
    expect(action('前往更新')).toBeUndefined();
    act(() => action('查看发布页')!.click());
    expect(fixture.openExternal).toHaveBeenCalledOnce();
    expect(fixture.openExternal).toHaveBeenCalledWith(fixture.detail.releasePageUrl);
    expect(navigate).toHaveBeenCalledOnce();

    fixture.detail.releasePageUrl = null;
    render(true);
    expect(action('前往更新')).toBeUndefined();
    expect(action('查看发布页')).toBeUndefined();
    expect(document.body.textContent).toContain(fixture.detail.body);
  } finally {
    act(() => root.unmount());
    unsubscribe();
  }
});
