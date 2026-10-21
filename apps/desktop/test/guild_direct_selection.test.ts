import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { Storage } from 'happy-dom';
import { GuildDirectDialog } from '../src/renderer/src/components/GuildDirectDialog';
import {
  ContentSelectionProvider,
  useContentExportRequest,
} from '../src/renderer/src/state/contentSelection';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import {
  fixedScopeSummary,
  initialExportMode,
  initialGuildScope,
} from '../src/renderer/src/views/export/exportScope';

const rpc = vi.hoisted(() => ({ list: vi.fn(), latest: vi.fn() }));
vi.mock('../src/renderer/src/trpc/client', () => {
  const proxy = (): unknown =>
    new Proxy(() => proxy(), {
      get: (_target, key) =>
        key === 'useQuery'
          ? () => ({ data: undefined })
          : key === 'useMutation'
            ? () => ({ mutate: vi.fn() })
            : proxy(),
    });
  return {
    trpc: proxy(),
    client: {
      account: {
        guildDirectListSessions: { query: rpc.list },
        guildDirectLatest: { query: rpc.latest },
      },
    },
  };
});
afterEach(() => vi.unstubAllGlobals());
it('频道会话多选支持范围、全选、导出，消息选区独立且只有气泡绘制选中态', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  const demo = createTemplateDemoData();
  rpc.list.mockResolvedValue(
    ['11', '22', '33'].map((nodeId) => ({
      nodeId,
      peerTinyId: nodeId,
      peerNick: `频道好友 ${nodeId}`,
      guildName: '合成频道',
      lastTime: '1792544400',
      lastSeq: '2',
      preview: null,
      peerAvatarUrl: null,
    })),
  );
  rpc.latest.mockResolvedValue(
    ['2', '1'].map((msgId) => ({
      msgId,
      msgSeq: msgId,
      sendType: msgId === '1' ? '2' : '0',
      sendTime: '1792544400',
      elements: [],
    })),
  );
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  function Probe() {
    return h(
      'pre',
      { 'data-export': true },
      JSON.stringify(useContentExportRequest()?.selection ?? null),
    );
  }
  const click = async (selector: string, options = {}) =>
    act(async () =>
      host
        .querySelector(selector)!
        .dispatchEvent(new MouseEvent('click', { bubbles: true, ...options })),
    );
  try {
    await act(async () =>
      root.render(
        h(
          ContentSelectionProvider,
          null,
          h(GuildDirectDialog, {
            open: true,
            embedded: true,
            selfUser: demo.user,
            onClose: vi.fn(),
          }),
          h(Probe),
        ),
      ),
    );
    await click('[aria-label="多选频道私聊"]');
    await click('.weq-guild-direct-item[data-weq-select-id="11"]');
    await click('.weq-guild-direct-item[data-weq-select-id="33"]', { shiftKey: true });
    expect(host.querySelectorAll('.weq-guild-direct-item.is-multiselected')).toHaveLength(3);
    expect(host.querySelector('.weq-guild-direct-chat-namewrap')).toBeNull();
    await click('[aria-label="导出所选频道私聊"]');
    const selection = JSON.parse(host.querySelector('[data-export]')!.textContent!);
    expect(initialExportMode(selection)).toBe('guild');
    expect(initialGuildScope(selection)).toEqual({ nodeIds: ['11', '22', '33'], messageIds: {} });
    expect(fixedScopeSummary(selection)).toContain('3 个会话');
    await click('[aria-label="退出会话多选"]');
    await click('.weq-guild-direct-item[data-weq-select-id="11"]');
    await click('[aria-label="多选消息"]');
    await click('.weq-guild-direct-msg[data-guild-msg-id="1"]');
    expect(host.querySelector('.weq-guild-direct-msg.is-selected')).toBeNull();
    expect(host.querySelectorAll('.message-line.is-selected')).toHaveLength(1);
    await click('[aria-label="导出所选消息"]');
    expect(JSON.parse(host.querySelector('[data-export]')!.textContent!)).toMatchObject({
      owner: { kind: 'guild-direct', container: '11' },
      scope: { ids: ['1'] },
    });
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
