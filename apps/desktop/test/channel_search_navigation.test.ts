import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { Storage } from 'happy-dom';
import { ChannelView } from '../src/renderer/src/views/ChannelView';
import {
  GuildDirectDialog,
  type GuildSearchTarget,
} from '../src/renderer/src/components/GuildDirectDialog';
import { createTemplateDemoData } from './support/templateDemoData';

const rpc = vi.hoisted(() => ({ sessions: vi.fn(), latest: vi.fn(), around: vi.fn() }));
vi.mock('../src/renderer/src/trpc/client', () => {
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
  ExternalSiteView: () => h('div', { 'data-channel-site': true }, '频道网站'),
}));

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  rpc.sessions.mockReset().mockResolvedValue(
    ['first', 'second'].map((nodeId) => ({
      nodeId,
      peerTinyId: nodeId,
      peerNick: `频道好友 ${nodeId}`,
      guildName: '合成频道',
      lastTime: '1700000000',
      lastSeq: '1',
      preview: null,
      peerAvatarUrl: null,
    })),
  );
  rpc.latest.mockReset().mockResolvedValue([]);
  rpc.around.mockReset().mockImplementation(async (target: GuildSearchTarget) => ({
    found: true,
    hasMore: false,
    items: [
      {
        msgId: target.msgId,
        msgSeq: target.msgSeq,
        senderTinyId: '42',
        sendType: '0',
        sendTime: '1700000000',
        elements: [],
      },
    ],
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function fixture() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  return {
    host,
    render: async (element: Parameters<typeof root.render>[0]) =>
      act(async () => root.render(element)),
    close: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}
function searchTarget(nodeId: string, revision: string): GuildSearchTarget {
  return { nodeId, msgId: `${nodeId}-message`, msgSeq: '3', revision };
}
function mainChat(target: GuildSearchTarget, onActiveSessionChange = vi.fn()) {
  return h(GuildDirectDialog, {
    open: true,
    embedded: true,
    chatOnly: true,
    selfUser: createTemplateDemoData().user,
    onClose: vi.fn(),
    searchTarget: target,
    onActiveSessionChange,
  });
}

describe('频道入口导航', () => {
  it('网页按钮只触发主会话导航，不在页面内挂载私聊列表或读取消息', async () => {
    const f = fixture();
    const navigate = vi.fn();
    try {
      await f.render(h(ChannelView, { onOpenDirect: navigate }));
      const website = f.host.querySelector('[data-channel-site]');
      await act(async () =>
        f.host.querySelector<HTMLButtonElement>('[aria-label="频道私聊"]')!.click(),
      );
      expect(navigate).toHaveBeenCalledOnce();
      expect(f.host.querySelector('[data-channel-site]')).toBe(website);
      expect(f.host.querySelector('.weq-guild-direct')).toBeNull();
      expect(f.host.querySelector('.weq-guild-direct-side')).toBeNull();
      expect(rpc.sessions).not.toHaveBeenCalled();
      expect(rpc.latest).not.toHaveBeenCalled();
      expect(rpc.around).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  });

  it('兼容的初始私聊入口也只触发导航，重复普通渲染不新建独立面板', async () => {
    const f = fixture();
    const navigate = vi.fn();
    try {
      await f.render(h(ChannelView, { initialDirectOpen: true, onOpenDirect: navigate }));
      expect(navigate).toHaveBeenCalledOnce();
      await f.render(h(ChannelView, { initialDirectOpen: true, onOpenDirect: navigate }));
      expect(navigate).toHaveBeenCalledOnce();
      await f.render(h(ChannelView, { initialDirectOpen: false, onOpenDirect: navigate }));
      await f.render(h(ChannelView, { initialDirectOpen: true, onOpenDirect: navigate }));
      expect(navigate).toHaveBeenCalledTimes(2);
      expect(f.host.querySelector('.weq-guild-direct')).toBeNull();
      expect(f.host.querySelector('[data-channel-site]')).not.toBeNull();
      expect(rpc.sessions).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  });
});

describe('统一主聊天区域的频道搜索', () => {
  it('受控搜索直接打开节点和消息，离开后重复命中仍能重新定位，无独立aside', async () => {
    const f = fixture();
    const changed = vi.fn();
    try {
      await f.render(mainChat(searchTarget('first', 'request-1'), changed));
      expect(f.host.querySelector('.weq-guild-direct.is-chat-only')).not.toBeNull();
      expect(f.host.querySelector('.weq-guild-direct-side')).toBeNull();
      expect(f.host.querySelector('[data-message-id="first-message"]')).not.toBeNull();
      expect(changed).toHaveBeenLastCalledWith('first');
      await f.render(null);
      expect(f.host.querySelector('.weq-guild-direct')).toBeNull();
      await f.render(mainChat(searchTarget('first', 'request-2'), changed));
      expect(f.host.querySelector('[data-message-id="first-message"]')).not.toBeNull();
      expect(rpc.around).toHaveBeenCalledTimes(2);
      await f.render(mainChat(searchTarget('second', 'request-3'), changed));
      expect(f.host.querySelector('[data-message-id="second-message"]')).not.toBeNull();
      expect(f.host.querySelector('[data-message-id="first-message"]')).toBeNull();
      expect(changed).toHaveBeenLastCalledWith('second');
      expect(rpc.around).toHaveBeenLastCalledWith({
        nodeId: 'second',
        msgId: 'second-message',
        msgSeq: '3',
      });
      expect(rpc.latest).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  });

  it('同一条搜索命中在当前会话再次请求时重新定位，不复用旧跳转', async () => {
    const f = fixture();
    try {
      await f.render(mainChat(searchTarget('first', 'repeat-1')));
      expect(rpc.around).toHaveBeenCalledTimes(1);
      await f.render(mainChat(searchTarget('first', 'repeat-2')));
      expect(rpc.around).toHaveBeenCalledTimes(2);
      expect(rpc.latest).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  });

  it('失效节点不误开其他会话，也不退回最新消息', async () => {
    const f = fixture();
    try {
      await f.render(mainChat(searchTarget('missing', 'request-missing')));
      expect(f.host.textContent).toContain('已删除或本地不可用');
      expect(f.host.querySelector('.has-selected-session')).toBeNull();
      expect(f.host.querySelector('.weq-guild-direct-side')).toBeNull();
      expect(rpc.around).not.toHaveBeenCalled();
      expect(rpc.latest).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  });

  it('失效消息保留明确错误，不伪装成最新页的成功读取', async () => {
    rpc.around.mockResolvedValueOnce({ found: false, hasMore: false, items: [] });
    const f = fixture();
    try {
      await f.render(mainChat(searchTarget('first', 'request-missing-message')));
      expect(f.host.textContent).toContain('无法读取指定消息');
      expect(f.host.textContent).toContain('搜索命中的消息已删除或本地不可用');
      expect(f.host.querySelector('[aria-label="重新读取消息"]')).not.toBeNull();
      expect(f.host.querySelector('[data-message-id]')).toBeNull();
      expect(rpc.latest).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  });
});
