import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ForwardWindowHost } from '../src/renderer/src/components/ForwardWindow';
import { ChatRecordsModal } from '../src/renderer/src/components/search/ChatRecordsModal';
import { qqMessageRenderer } from '../src/renderer/src/components/QqMessageContent.shared';
import {
  closeForwardWindows,
  openForwardWindow,
  useForwardStore,
} from '../src/renderer/src/state/forwardWindow';
import { Modal } from '../src/renderer/src/components/Dialog';

const search = vi.hoisted(() => vi.fn());
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: { account: { searchConversationRecords: { query: search } } },
  trpc: { account: { dressup: { resolveMsgDecoration: { useQuery: () => ({}) } } } },
}));
vi.mock('../src/renderer/src/hooks/useExportSavePolicy', () => ({
  useExportSavePolicy: () => ({
    binding: null,
    settings: { isLoading: false },
    isCurrent: () => true,
  }),
}));

it('复用转发宿主仍提升到新父窗上方，聚焦父记录不遮住子记录，并在入口附近避让窄屏', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('innerWidth', 375);
  vi.stubGlobal('innerHeight', 800);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const toolClose = vi.fn();
  const render = (open: boolean, presentation: 'floating' | 'modal' = 'floating') =>
    act(() =>
      root.render(
        h(
          'div',
          null,
          h(ForwardWindowHost),
          h(
            Modal,
            { open, presentation, title: '父工具', onClose: toolClose },
            h('button', null, '工具'),
          ),
        ),
      ),
    );
  const forwardLayer = () => document.querySelector<HTMLElement>('.weq-forward-layer')!;
  try {
    render(false);
    act(() =>
      openForwardWindow({
        title: '父记录',
        kind: 'c2c',
        conv: '',
        msgId: 'fixture-1',
        records: [],
      }),
    );
    render(true);
    const toolLayer = document.querySelector<HTMLElement>('.weq-window-layer')!;
    expect(Number(toolLayer.style.zIndex)).toBeGreaterThan(Number(forwardLayer().style.zIndex));
    act(() =>
      openForwardWindow({
        title: '子记录',
        kind: 'c2c',
        conv: '',
        msgId: 'fixture-2',
        records: [],
        parentId: 1,
        anchor: new DOMRect(340, 740, 27, 30),
      }),
    );
    expect(Number(forwardLayer().style.zIndex)).toBeGreaterThan(Number(toolLayer.style.zIndex));
    const parent = document.querySelector<HTMLElement>('[aria-label="父记录"]')!;
    const child = document.querySelector<HTMLElement>('[aria-label="子记录"]')!;
    act(() => parent.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(Number(child.style.zIndex)).toBeGreaterThan(Number(parent.style.zIndex));
    expect(child.style.left).toBe('8px');
    expect(child.style.top).toBe('172px');
    render(true, 'modal');
    act(() =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })),
    );
    expect(toolClose).toHaveBeenCalledOnce();
    expect(document.querySelectorAll('.weq-forward-window')).toHaveLength(2);
  } finally {
    act(() => {
      for (const button of document.querySelectorAll<HTMLButtonElement>('.weq-forward-close'))
        button.click();
      root.unmount();
    });
    host.remove();
    vi.unstubAllGlobals();
  }
});

it('聊天记录中的引用跳向被引用消息，并关掉叠开的转发窗口', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const onClose = vi.fn();
  const onJumpMessage = vi.fn();
  search.mockResolvedValue({
    total: 1,
    items: [
      {
        msgId: '38',
        msgSeq: '38',
        senderUid: 'u_peer',
        senderUin: '10002',
        senderName: '成员',
        sendTime: '1794528000',
        content: '回复正文',
        elements: [
          {
            type: 'reply',
            data: {
              origMsgSeq: 37,
              origElements: [{ type: 'text', data: { textContent: '被引用消息' } }],
            },
          },
          { type: 'text', data: { textContent: '回复正文' } },
        ],
      },
    ],
  });
  try {
    await act(async () =>
      root.render(
        h(ChatRecordsModal, {
          initialHit: {
            category: 'chatRecord',
            source: 'group',
            partition: '12345',
            targetUid: '12345',
            targetUin: '12345',
            name: '合成群',
            count: 1,
          },
          initialKeyword: '回复正文',
          embeddedKeyword: '回复正文',
          onClose,
          onJumpMessage,
          renderers: [qqMessageRenderer],
        }),
      ),
    );
    const records = { kind: 'group' as const, conv: '12345', msgId: '38', records: [] };
    openForwardWindow({ ...records, title: '父记录' });
    openForwardWindow({ ...records, title: '子记录', parentId: useForwardStore.getState().seq });
    await act(async () => host.querySelector<HTMLElement>('.qq-reply-quote')!.click());
    expect(onJumpMessage).toHaveBeenCalledOnce();
    expect(onJumpMessage).toHaveBeenCalledWith(
      expect.objectContaining({ msgSeq: '37', targetUid: '12345' }),
    );
    expect(onClose).toHaveBeenCalledOnce();
    expect(useForwardStore.getState().windows).toHaveLength(0);
  } finally {
    closeForwardWindows();
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
