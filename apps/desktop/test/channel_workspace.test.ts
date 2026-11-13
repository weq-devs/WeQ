import { act, createElement, type ComponentProps, type CSSProperties, type ReactNode } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { PageSnapshots } from '../src/renderer/src/components/PageSnapshots';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelView } from '../src/renderer/src/views/ChannelView';
import { GuildDirectDialog } from '../src/renderer/src/components/GuildDirectDialog';
import type { MessageRenderer } from '../src/renderer/src/im-template/template/messageRenderers';
import { AppRail } from '../src/renderer/src/im-template/template/rail';
import { createTemplateDemoData } from './support/templateDemoData';
import { useUpdateStore } from '../src/renderer/src/state/update';
import * as mentionClipboard from '../src/renderer/src/lib/mentionClipboard';
import {
  ContentSelectionProvider,
  useCurrentContentSelection,
  useContentExportRequest,
  useContentMultiSelect,
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
      elements: [{ type: 'text', data: { textContent: '合成频道消息' } }] as unknown[],
    },
  ]),
}));
vi.mock('../src/renderer/src/trpc/client', () => {
  // 频道数据仍走下方显式 RPC；共用聊天模板的辅助查询保持无数据。
  const auxiliary = (): unknown =>
    new Proxy(() => auxiliary(), {
      get: (_target, key) =>
        key === 'useQuery'
          ? () => ({ data: undefined })
          : key === 'useMutation'
            ? () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isLoading: false })
            : auxiliary(),
    });
  return {
    client: {
      account: {
        guildDirectListSessions: { query: rpc.sessions },
        guildDirectLatest: { query: rpc.latest },
        guildDirectAround: { query: rpc.around },
        guildDirectBefore: { query: vi.fn(async () => []) },
      },
    },
    trpc: auxiliary(),
  };
});
vi.mock('../src/renderer/src/lib/target', () => ({ IS_WEB: true }));
vi.mock('../src/renderer/src/views/ExternalSiteView', () => ({
  ExternalSiteView: () =>
    createElement('input', { 'aria-label': '合成频道浏览现场', defaultValue: '初始' }),
}));

beforeEach(() => vi.stubGlobal('localStorage', new Storage()));

function SelectionMode({ nodeId }: { nodeId: string }) {
  const selection = useContentMultiSelect({ kind: 'guild-direct', container: nodeId });
  return createElement(
    'button',
    { 'data-enter-selection': true, onClick: () => selection.setSelectionMode(true) },
    '进入多选',
  );
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

function mount(element: Parameters<ReturnType<typeof createRoot>['render']>[0]) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(element));
  return {
    host,
    render: (next: Parameters<typeof root.render>[0]) => root.render(next),
    close: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

let targetRevision = 0;
function mainChat(
  nodeId = 'synthetic-node',
  props: Partial<ComponentProps<typeof GuildDirectDialog>> = {},
) {
  return createElement(GuildDirectDialog, {
    open: true,
    embedded: true,
    chatOnly: true,
    selfUser: createTemplateDemoData().user,
    onClose() {},
    searchTarget: { nodeId, msgId: '', msgSeq: '', revision: `main-chat-${++targetRevision}` },
    ...props,
  });
}

describe('主聊天区域的频道私聊', () => {
  it('频道所选消息可复制和导出，各会话分别保留自己的选区', async () => {
    const copy = vi.spyOn(mentionClipboard, 'writeMentionClipboard').mockResolvedValue(true);
    rpc.sessions.mockResolvedValueOnce(
      ['a', 'b'].map((nodeId) => ({
        nodeId,
        peerTinyId: '42',
        peerNick: nodeId,
        lastTime: '1700000000',
        lastSeq: '1',
        guildName: '频道',
        preview: null,
      })),
    );
    function ExportProbe() {
      return createElement(
        'output',
        { 'data-export-request': true },
        JSON.stringify(useContentExportRequest()),
      );
    }
    const renderNode = (nodeId: string) =>
      createElement(
        ContentSelectionProvider,
        null,
        mainChat(nodeId),
        createElement(ExportProbe),
        createElement(SelectionMode, { nodeId }),
      );
    const f = mount(renderNode('a'));
    try {
      await act(async () => {});
      expect(f.host.querySelector('.weq-guild-direct-side')).toBeNull();
      act(() => f.host.querySelector<HTMLButtonElement>('[data-enter-selection]')!.click());
      act(() => f.host.querySelector<HTMLElement>('[data-message-id]')!.click());
      expect(f.host.querySelector('[aria-label="导出所选消息"]')).not.toBeNull();
      await act(async () =>
        f.host.querySelector<HTMLButtonElement>('[aria-label="导出所选消息"]')!.click(),
      );
      expect(
        JSON.parse(f.host.querySelector('[data-export-request]')!.textContent!).selection,
      ).toEqual({
        owner: { kind: 'guild-direct', container: 'a' },
        scope: { type: 'items', ids: ['synthetic-message'] },
      });
      act(() => f.host.querySelector<HTMLButtonElement>('[aria-label="复制"]')!.click());
      await act(async () =>
        [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
          .find((button) => button.textContent === '纯文本')!
          .click(),
      );
      expect(copy).toHaveBeenCalledOnce();
      expect(copy.mock.calls[0]![0].text).toContain('合成频道消息');
      expect(f.host.querySelector('[aria-label="撤回所选消息"]')).toBeNull();
      await act(async () => f.render(renderNode('b')));
      expect(f.host.querySelector('.is-selected')).toBeNull();
      await act(async () => f.render(renderNode('a')));
      expect(f.host.querySelectorAll('.message-line.is-selected')).toHaveLength(1);
      expect(f.host.querySelectorAll('.message-line.is-selected')).toHaveLength(1);
      expect(f.host.querySelector('.weq-guild-direct-msg.is-selected')).toBeNull();
      expect(f.host.querySelector('[aria-label="退出多选"]')).not.toBeNull();
    } finally {
      f.close();
    }
  });
  it.each(['0', '-1', '', 'invalid'])(
    '频道时间 %s 无效时不伪造 1970 年分隔日期',
    async (sendTime) => {
      rpc.latest.mockResolvedValueOnce([
        { msgId: '1', msgSeq: '0', senderTinyId: '42', sendType: '0', sendTime, elements: [] },
      ]);
      const f = mount(mainChat());
      try {
        await act(async () => {});
        expect(f.host.querySelector('.message-time-divider')).toBeNull();
        expect(f.host.textContent).not.toContain('1970');
      } finally {
        f.close();
      }
    },
  );
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
      mainChat('100', {
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
          .querySelector('[data-message-id="9007199254740993"]')
          ?.getAttribute('data-message-id'),
      ).toBe('9007199254740993');
      await act(async () => {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      });
      expect(scroll).toHaveBeenCalledOnce();
      await act(async () =>
        f.host.querySelector('.message-scroll')!.dispatchEvent(new Event('scroll')),
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
    const f = mount(mainChat());
    try {
      await act(async () => {});
      expect(f.host.textContent).toContain('合成读取失败');
      await act(async () =>
        f.host.querySelector<HTMLButtonElement>('[aria-label="重新读取消息"]')!.click(),
      );
      expect(f.host.querySelector('[aria-label="重新读取消息"]')).toBeNull();
      expect(f.host.querySelectorAll('.message-line[data-message-id]')).toHaveLength(1);
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
        mainChat(),
        createElement(Probe),
        createElement(SelectionMode, { nodeId: 'synthetic-node' }),
      ),
    );
    try {
      await act(async () => {});
      act(() => f.host.querySelector<HTMLButtonElement>('[data-enter-selection]')!.click());
      const rows = f.host.querySelectorAll<HTMLElement>('.message-line[data-message-id]');
      act(() => {
        rows[0]!.click();
        rows[2]!.click();
      });
      expect(JSON.parse(f.host.querySelector('output')!.textContent!)).toEqual({
        owner: { kind: 'guild-direct', container: 'synthetic-node' },
        scope: { type: 'items', ids: ['1', '3'] },
      });
      expect(f.host.querySelectorAll('.message-line.is-selected')).toHaveLength(2);
      expect(f.host.querySelectorAll('.message-line.is-selected')).toHaveLength(2);
      expect(f.host.querySelector('.weq-guild-direct-msg.is-selected')).toBeNull();
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
      act(() => f.host.querySelector<HTMLButtonElement>('[aria-label="退出多选"]')!.click());
      expect(f.host.querySelector('output')!.textContent).toBe('null');
      expect(f.host.querySelector('.message-line.is-selected')).toBeNull();
      expect(f.host.querySelector('.message-line.is-selected')).toBeNull();
    } finally {
      f.close();
    }
  });
  it('主区域chatOnly直接使用共用聊天布局，外层侧栏宽度为零时不挂载独立侧栏', async () => {
    const style = document.createElement('style');
    style.textContent = readFileSync(
      resolve(__dirname, '../src/renderer/src/styles/channel.css'),
      'utf8',
    );
    document.head.append(style);
    const f = mount(
      createElement('div', { style: { '--sidebar-width': '0px' } as CSSProperties }, mainChat()),
    );
    try {
      await act(async () => {});
      expect(f.host.querySelector('.weq-guild-direct.is-chat-only')).not.toBeNull();
      expect(f.host.querySelector('.weq-guild-direct-side')).toBeNull();
      expect(f.host.querySelector('.weq-guild-direct-item')).toBeNull();
      expect(
        f.host.querySelector('.weq-guild-direct-body > .chat-pane.without-composer'),
      ).not.toBeNull();
    } finally {
      f.close();
      style.remove();
    }
  });
  it('导航在频道网站与主聊天区之间卸载重建，恢复所选频道会话并重新读取消息', async () => {
    const openDirect = vi.fn();
    const workspace = (direct: boolean, explicitTarget = false) =>
      createElement(
        PageSnapshots,
        { scope: 'synthetic' },
        direct
          ? mainChat('synthetic-node', explicitTarget ? {} : { searchTarget: null })
          : createElement(ChannelView, { onOpenDirect: openDirect }),
      );
    const f = mount(workspace(false));
    try {
      expect(rpc.sessions).not.toHaveBeenCalled();
      const browser = f.host.querySelector<HTMLInputElement>('[aria-label="合成频道浏览现场"]')!;
      browser.value = '保留的频道现场';
      const open = f.host.querySelector<HTMLButtonElement>('[aria-label="频道私聊"]')!;
      await act(async () => open.click());
      expect(openDirect).toHaveBeenCalledOnce();
      expect(rpc.sessions).not.toHaveBeenCalled();
      expect(browser.isConnected).toBe(true);
      await act(async () => f.render(workspace(true, true)));
      expect(rpc.sessions).toHaveBeenCalledOnce();
      expect(f.host.querySelector('.weq-channel-browser')).toBeNull();
      expect(browser.isConnected).toBe(false);
      expect(f.host.querySelector('.weq-guild-direct-side')).toBeNull();
      expect(rpc.latest).toHaveBeenCalledWith({
        nodeId: 'synthetic-node',
        limit: 50,
        stablePaging: true,
      });
      expect(f.host.querySelector('.has-selected-session')).not.toBeNull();
      await act(async () => f.render(workspace(false)));
      expect(f.host.querySelector('.weq-channel-browser')).not.toBeNull();
      expect(f.host.querySelector('[aria-label="合成频道浏览现场"]')).not.toBe(browser);
      expect(f.host.querySelector('.weq-guild-direct')).toBeNull();
      await act(async () =>
        f.host.querySelector<HTMLButtonElement>('[aria-label="频道私聊"]')!.click(),
      );
      expect(openDirect).toHaveBeenCalledTimes(2);
      await act(async () => f.render(workspace(true)));
      expect(rpc.sessions).toHaveBeenCalledTimes(2);
      expect(rpc.latest).toHaveBeenCalledTimes(2);
      expect(f.host.querySelector('.has-selected-session')).not.toBeNull();
      await act(async () => f.render(workspace(false)));
      expect(f.host.querySelector('.has-selected-session')).toBeNull();
    } finally {
      f.close();
    }
  });

  it('频道媒体和装扮交给共用渲染器，自发消息仍使用主界面自己的身份', async () => {
    const user = createTemplateDemoData().user;
    const element = { kind: 'image', fileName: 'synthetic-image.png' };
    const message = {
      msgId: 'media',
      msgSeq: '1',
      senderTinyId: 'other-device-id',
      sendType: '2',
      sendTime: '1700000000',
      elements: [element],
      decoration: { bubbleId: 7, fontId: 8, widgetId: 9 },
    };
    rpc.latest.mockImplementationOnce(async () => [message]);
    const src =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
    const render = vi.fn<MessageRenderer['render']>(() =>
      createElement('img', { src, alt: '合成频道图片' }),
    );
    const f = mount(
      mainChat('synthetic-node', {
        selfUser: user,
        renderers: [{ id: 'synthetic-media', match: () => true, render }],
      }),
    );
    try {
      await act(async () => {});
      expect(f.host.querySelector<HTMLImageElement>('img[alt="合成频道图片"]')?.src).toBe(src);
      expect(render).toHaveBeenCalledWith(
        expect.objectContaining({
          mine: true,
          sender: user,
          conversation: expect.objectContaining({ id: 'guild:synthetic-node' }),
          message: expect.objectContaining({
            qqElements: [element],
            decoration: message.decoration,
            msgId: 'media',
          }),
        }),
      );
      expect(f.host.querySelector('.weq-guild-direct-side')).toBeNull();
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
          createElement('div', { 'aria-label': '应用控制' }, settingsButton),
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
        '年度报告',
        '个性装扮',
        '应用',
      ]);
      const settingsButton = f.host.querySelector<HTMLButtonElement>(
        '.rail-footer [aria-label="设置"]',
      )!;
      expect(settingsButton.parentElement?.getAttribute('aria-label')).toBe('应用控制');
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
