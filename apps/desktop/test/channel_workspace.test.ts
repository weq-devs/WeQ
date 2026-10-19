import { act, createElement, type CSSProperties, type ReactNode } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChannelView } from '../src/renderer/src/views/ChannelView';
import { AppRail } from '../src/renderer/src/im-template/template/rail';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import { RailUtilityDock } from '../src/renderer/src/components/RailUtilityDock';
import { useUpdateStore } from '../src/renderer/src/state/update';
import {
  ContentSelectionProvider,
  useCurrentContentSelection,
} from '../src/renderer/src/state/contentSelection';

const rpc = vi.hoisted(() => ({
  around: vi.fn(async () => ({
    found: true,
    hasMore: true,
    items: [
      {
        msgId: '9007199254740993',
        msgSeq: '3',
        senderTinyId: '42',
        sendType: '0',
        sendTime: '1700000000',
        elements: [],
      },
    ],
  })),
  sessions: vi.fn(async () => [
    {
      nodeId: 'synthetic-node',
      peerTinyId: '42',
      peerNick: '合成频道好友',
      lastTime: '1700000000',
      lastSeq: '1',
      guildName: '合成频道',
      preview: null,
    },
  ]),
  latest: vi.fn(async () => [
    {
      msgId: 'synthetic-message',
      msgSeq: '1',
      senderTinyId: '42',
      sendType: '0',
      sendTime: '1700000000',
      elements: [],
    },
  ]),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    account: {
      guildDirectListSessions: { query: rpc.sessions },
      guildDirectLatest: { query: rpc.latest },
      guildDirectAround: { query: rpc.around },
      guildDirectBefore: { query: vi.fn(async () => []) },
    },
  },
  trpc: {
    account: { dressup: { resolveMsgDecoration: { useQuery: () => ({ data: undefined }) } } },
  },
}));
vi.mock('../src/renderer/src/lib/target', () => ({ IS_WEB: true }));
vi.mock('../src/renderer/src/views/ExternalSiteView', () => ({
  ExternalSiteView: () =>
    createElement('input', { 'aria-label': '合成频道浏览现场', defaultValue: '初始' }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function mount(element: Parameters<ReturnType<typeof createRoot>['render']>[0]) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(element));
  return {
    host,
    close: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

describe('QQ 频道内的私聊工作区', () => {
  it('频道无有效时间的记录不伪造 1970 年分隔日期', async () => {
    rpc.latest.mockResolvedValueOnce([
      { msgId: '1', msgSeq: '0', senderTinyId: '42', sendType: '0', sendTime: '0', elements: [] },
    ]);
    const f = mount(
      createElement(ChannelView, {
        selfUser: createTemplateDemoData().user,
        initialDirectOpen: true,
      }),
    );
    try {
      await act(async () => {});
      await act(async () =>
        f.host.querySelector<HTMLButtonElement>('.weq-guild-direct-item')!.click(),
      );
      expect(f.host.querySelector('.message-time-divider')).toBeNull();
      expect(f.host.textContent).not.toContain('1970');
    } finally {
      f.close();
    }
  });
  it('频道搜索按 nodeId/seq/msgId 直接读取历史窗口，不退回最新页', async () => {
    rpc.sessions.mockResolvedValueOnce([
      {
        nodeId: '100',
        peerTinyId: '42',
        peerNick: '合成频道好友',
        lastTime: '1700000000',
        lastSeq: '60',
        guildName: '合成频道',
        preview: null,
      },
    ]);
    const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {});
    const f = mount(
      createElement(ChannelView, {
        selfUser: createTemplateDemoData().user,
        searchTarget: {
          nodeId: '100',
          msgId: '9007199254740993',
          msgSeq: '3',
          revision: 'fixture-search',
        },
      }),
    );
    try {
      await act(async () => {});
      expect(rpc.around).toHaveBeenCalledWith({
        nodeId: '100',
        msgId: '9007199254740993',
        msgSeq: '3',
      });
      expect(rpc.latest).not.toHaveBeenCalled();
      expect(
        f.host
          .querySelector('.weq-guild-direct-msg.is-search-hit')
          ?.getAttribute('data-guild-msg-id'),
      ).toBe('9007199254740993');
      await act(async () => {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      });
      expect(scroll).toHaveBeenCalledOnce();
      await act(async () =>
        f.host.querySelector('.weq-guild-direct-msgs')!.dispatchEvent(new Event('scroll')),
      );
      await act(async () => {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      });
      expect(scroll).toHaveBeenCalledOnce();
    } finally {
      f.close();
      vi.restoreAllMocks();
    }
  });
  it('消息读取失败保留重试入口，不将失败当作已成功读取', async () => {
    rpc.latest.mockRejectedValueOnce(new Error('合成读取失败'));
    const f = mount(
      createElement(ChannelView, {
        selfUser: createTemplateDemoData().user,
        initialDirectOpen: true,
      }),
    );
    try {
      await act(async () => {});
      await act(async () =>
        f.host.querySelector<HTMLButtonElement>('.weq-guild-direct-item')!.click(),
      );
      expect(f.host.textContent).toContain('消息读取失败');
      await act(async () =>
        f.host.querySelector<HTMLButtonElement>('[aria-label="重试读取消息"]')!.click(),
      );
      expect(f.host.querySelector('[aria-label="重试读取消息"]')).toBeNull();
      expect(f.host.querySelectorAll('.weq-guild-direct-msg')).toHaveLength(1);
    } finally {
      f.close();
    }
  });
  it('频道消息多选使用账号共享身份，支持间断选择和键盘全选', async () => {
    rpc.latest.mockResolvedValueOnce(
      ['3', '2', '1'].map((id) => ({
        msgId: id,
        msgSeq: id,
        senderTinyId: '42',
        sendType: '0',
        sendTime: '1700000000',
        elements: [],
      })),
    );
    function Probe() {
      return createElement(
        'output',
        { 'data-selection': true },
        JSON.stringify(useCurrentContentSelection()),
      );
    }
    const f = mount(
      createElement(
        ContentSelectionProvider,
        null,
        createElement(ChannelView, {
          selfUser: createTemplateDemoData().user,
          initialDirectOpen: true,
        }),
        createElement(Probe),
      ),
    );
    try {
      await act(async () => {});
      await act(async () =>
        f.host.querySelector<HTMLButtonElement>('.weq-guild-direct-item')!.click(),
      );
      act(() => f.host.querySelector<HTMLButtonElement>('[aria-label="多选消息"]')!.click());
      const rows = f.host.querySelectorAll<HTMLElement>('.weq-guild-direct-msg');
      act(() => {
        rows[0]!.click();
        rows[2]!.click();
      });
      expect(JSON.parse(f.host.querySelector('output')!.textContent!)).toEqual({
        owner: { kind: 'guild-direct', container: 'synthetic-node' },
        scope: { type: 'items', ids: ['1', '3'] },
      });
      expect(f.host.querySelectorAll('.weq-guild-direct-msg.is-selected')).toHaveLength(2);
      act(() =>
        rows[0]!.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true }),
        ),
      );
      expect(JSON.parse(f.host.querySelector('output')!.textContent!).scope.ids).toEqual([
        '1',
        '3',
        '2',
      ]);
      act(() => f.host.querySelector<HTMLButtonElement>('[aria-label="退出消息多选"]')!.click());
      expect(f.host.querySelector('output')!.textContent).toBe('null');
    } finally {
      f.close();
    }
  });
  it('全宽页面的外层侧栏为零时，频道私聊仍保留正常会话列表宽度', async () => {
    const style = document.createElement('style');
    style.textContent = readFileSync(
      resolve(__dirname, '../src/renderer/src/styles/channel.css'),
      'utf8',
    );
    document.head.append(style);
    const f = mount(
      createElement(
        'div',
        { style: { '--sidebar-width': '0px' } as CSSProperties },
        createElement(ChannelView, {
          selfUser: createTemplateDemoData().user,
          initialDirectOpen: true,
          sidebarWidth: 340,
        }),
      ),
    );
    try {
      await act(async () => {});
      expect(
        window.getComputedStyle(f.host.querySelector('.weq-guild-direct-side')!).flexBasis,
      ).toBe('340px');
    } finally {
      f.close();
      style.remove();
    }
  });
  it('只在频道内部提供入口，按需读取，返回与重开保留两个阅读现场', async () => {
    const f = mount(createElement(ChannelView, { selfUser: createTemplateDemoData().user }));
    try {
      expect(rpc.sessions).not.toHaveBeenCalled();
      const browser = f.host.querySelector<HTMLInputElement>('[aria-label="合成频道浏览现场"]')!;
      browser.value = '保留的频道现场';
      const open = f.host.querySelector<HTMLButtonElement>('[aria-label="频道私聊"]')!;
      await act(async () => open.click());
      expect(rpc.sessions).toHaveBeenCalledOnce();
      expect(f.host.querySelector<HTMLElement>('.weq-channel-browser')!.hidden).toBe(true);
      await act(async () =>
        f.host.querySelector<HTMLButtonElement>('.weq-guild-direct-item')!.click(),
      );
      expect(rpc.latest).toHaveBeenCalledWith({
        nodeId: 'synthetic-node',
        limit: 50,
        stablePaging: true,
      });
      expect(f.host.querySelector('.has-selected-session')).not.toBeNull();
      act(() => f.host.querySelector<HTMLButtonElement>('[aria-label="返回 QQ 频道"]')!.click());
      expect(f.host.querySelector<HTMLElement>('.weq-channel-browser')!.hidden).toBe(false);
      expect(browser.value).toBe('保留的频道现场');
      act(() => open.click());
      expect(rpc.sessions).toHaveBeenCalledOnce();
      expect(rpc.latest).toHaveBeenCalledOnce();
      expect(f.host.querySelector('.has-selected-session')).not.toBeNull();
      act(() => f.host.querySelector<HTMLButtonElement>('[aria-label="会话列表"]')!.click());
      expect(f.host.querySelector('.has-selected-session')).toBeNull();
    } finally {
      f.close();
    }
  });

  it('内容入口按顺序直接排列，移除更多、克隆和帮助的重复入口', () => {
    const noop = () => {};
    const collection = vi.fn();
    const dress = vi.fn();
    const settings = vi.fn();
    const changeView = vi.fn();
    const f = mount(
      createElement(AppRail, {
        user: createTemplateDemoData().user,
        view: 'channel',
        onViewChange: changeView,
        mailBadgeCount: 2,
        onOpenSettings: settings,
        activeRailItem: 'settings',
        footerContent: (settingsButton: ReactNode) =>
          createElement('div', null, createElement(RailUtilityDock, null), settingsButton),
        onOpenCollection: collection,
        onOpenDressUp: dress,
        onOpenProfile: noop,
        onOpenAbout: noop,
        onOpenInvite: noop,
        onOpenWonderfulTools: noop,
        onOpenAntiRecall: noop,
        onOpenDbRepair: noop,
        onOpenQzoneAlbum: noop,
      }),
    );
    try {
      expect(
        [...f.host.querySelectorAll('.rail-nav .rail-tab:not(.rail-mobile-settings)')].map((b) =>
          b.getAttribute('title'),
        ),
      ).toEqual([
        '消息',
        '联系人',
        'QQ 空间',
        'QQ 频道',
        'QQ 邮箱',
        '我的收藏',
        '个性装扮',
        '应用',
      ]);
      const settingsButton = f.host.querySelector<HTMLButtonElement>(
        '.rail-footer [aria-label="设置"]',
      )!;
      expect(settingsButton.previousElementSibling?.classList.contains('weq-rail-utilities')).toBe(
        true,
      );
      expect(settingsButton.classList.contains('weq-rail-control')).toBe(true);
      expect(settingsButton.getAttribute('aria-current')).toBe('page');
      expect(settingsButton.closest('[inert]')).toBeNull();
      act(() => settingsButton.click());
      expect(settings).toHaveBeenCalledOnce();
      act(() => useUpdateStore.getState().setAvailable('synthetic-version'));
      expect(settingsButton.title).toContain('有新版本可更新');
      expect(settingsButton.querySelector('[aria-label="有新版本可更新"]')).not.toBeNull();
      expect(f.host.querySelector('.rail-mobile-settings')).not.toBeNull();
      for (const title of ['我的收藏', '个性装扮']) {
        act(() => f.host.querySelector<HTMLButtonElement>(`[title="${title}"]`)!.click());
      }
      expect(collection).toHaveBeenCalledOnce();
      expect(dress).toHaveBeenCalledOnce();
      const mail = f.host.querySelector<HTMLButtonElement>('[title="QQ 邮箱"]')!;
      expect(mail.querySelector('.rail-badge')?.textContent).toBe('2');
      act(() => mail.click());
      expect(changeView).toHaveBeenCalledWith('mail');
      expect(f.host.querySelector('[title="更多功能"]')).toBeNull();
      expect(f.host.querySelector('[title="克隆消息（模拟）"]')).toBeNull();
      expect(f.host.querySelector('[title="帮助"]')).toBeNull();
      expect(f.host.querySelector('[title="频道私聊"]')).toBeNull();
      expect(f.host.querySelector('[title="QQ 频道"]')).not.toBeNull();
    } finally {
      act(() => useUpdateStore.getState().clear());
      f.close();
    }
  });
});
