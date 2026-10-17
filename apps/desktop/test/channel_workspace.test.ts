import { act, createElement } from 'react';
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

  it('更多功能不再提供第二个频道私聊入口', () => {
    const noop = () => {};
    const f = mount(
      createElement(AppRail, {
        user: createTemplateDemoData().user,
        view: 'channel',
        onViewChange: noop,
        onOpenSettings: noop,
        onOpenCollection: noop,
        onOpenMarketBrowser: noop,
        onOpenDressUp: noop,
        onOpenProfile: noop,
        onOpenAbout: noop,
        onOpenHelp: noop,
        onOpenInvite: noop,
        onOpenWonderfulTools: noop,
        onOpenAntiRecall: noop,
        onOpenDbRepair: noop,
        onOpenQzoneAlbum: noop,
        onOpenMergeForward: noop,
      }),
    );
    try {
      act(() => f.host.querySelector<HTMLButtonElement>('[title="更多功能"]')!.click());
      expect(f.host.querySelector('[title="频道私聊"]')).toBeNull();
      expect(f.host.querySelector('[title="QQ 频道"]')).not.toBeNull();
    } finally {
      f.close();
    }
  });
});
