import { act, createElement, type CSSProperties } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChannelView } from '../src/renderer/src/views/ChannelView';
import { AppRail } from '../src/renderer/src/im-template/template/rail';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';

const rpc = vi.hoisted(() => ({
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
      expect(rpc.latest).toHaveBeenCalledWith({ nodeId: 'synthetic-node', limit: 50 });
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
    const market = vi.fn();
    const dress = vi.fn();
    const changeView = vi.fn();
    const f = mount(
      createElement(AppRail, {
        user: createTemplateDemoData().user,
        view: 'channel',
        onViewChange: changeView,
        mailBadgeCount: 2,
        onOpenSettings: noop,
        onOpenCollection: collection,
        onOpenMarketBrowser: market,
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
        [...f.host.querySelectorAll('.rail-nav > button')].map((b) => b.getAttribute('title')),
      ).toEqual([
        '消息',
        '联系人',
        'QQ 空间',
        'QQ 频道',
        'QQ 邮箱',
        '我的收藏',
        '商城表情',
        '个性装扮',
        '设置',
        '应用',
      ]);
      for (const title of ['我的收藏', '商城表情', '个性装扮']) {
        act(() => f.host.querySelector<HTMLButtonElement>(`[title="${title}"]`)!.click());
      }
      expect(collection).toHaveBeenCalledOnce();
      expect(market).toHaveBeenCalledOnce();
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
      f.close();
    }
  });
});
