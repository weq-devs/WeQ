import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { Storage } from 'happy-dom';
import { ChatPane } from '../src/renderer/src/im-template/template/chatPane';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import {
  ContentSelectionProvider,
  useContentMultiSelect,
} from '../src/renderer/src/state/contentSelection';
import { useDialog } from '../src/renderer/src/components/Dialog';
import { ToastHost, useToast } from '../src/renderer/src/components/Toast';
import type { Message } from '../src/renderer/src/im-template/template/types';
import type { LoadSelectionMessages } from '../src/renderer/src/lib/messageSelection';

vi.mock('../src/renderer/src/trpc/client', () => {
  const proxy = (): unknown =>
    new Proxy(() => proxy(), {
      get: (_target, key) =>
        key === 'useQuery'
          ? () => ({ data: undefined })
          : key === 'useMutation'
            ? () => ({ mutate: vi.fn(), isLoading: false })
            : proxy(),
    });
  return { trpc: proxy(), client: proxy() };
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useToast.setState({ toasts: [], leaving: [], seq: 0 });
});
function fixture(kind: 'group' | 'direct' = 'group') {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  const demo = createTemplateDemoData(),
    conversation = demo.conversations.find((row) => row.type === kind)!;
  const message = (seq: number, conv = conversation.id): Message => ({
    id: String(seq),
    conversationId: conv,
    senderId: 'u_peer',
    body: `消息 ${seq}`,
    createdAt: new Date(1792544400000 + seq * 1000).toISOString(),
    msgSeq: String(seq),
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const load = vi.fn<LoadSelectionMessages>(async () => {});
  function Probe({ id }: { id: string }) {
    const selection = useContentMultiSelect({
      kind: 'messages',
      container: `${conversation.type}:${id}`,
    });
    return h(
      'aside',
      null,
      h(
        'button',
        {
          'data-enter': true,
          onClick: () => {
            selection.setSelectionMode(true);
            selection.setSelectedIds(new Set(['1']));
            selection.anchorRef.current = '1';
          },
        },
        '进入多选',
      ),
      h(
        'output',
        null,
        JSON.stringify({
          mode: selection.selectionMode,
          ids: [...selection.selectedIds],
          anchor: selection.anchorRef.current,
        }),
      ),
    );
  }
  const render = (messages = [message(1), message(5)], id = conversation.id) =>
    act(() =>
      root.render(
        h(
          ContentSelectionProvider,
          null,
          h(Probe, { id }),
          h(ChatPane, {
            user: demo.user,
            conversation: { ...conversation, id },
            messages,
            loading: false,
            draft: '',
            onDraftChange: vi.fn(),
            onBack: vi.fn(),
            onLoadSelectionMessages: load,
          }),
          h(ToastHost),
        ),
      ),
    );
  render();
  const click = async (selector: string, shiftKey = false) =>
    act(async () => {
      host
        .querySelector(selector)!
        .dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey }));
    });
  return {
    host,
    load,
    message,
    render,
    click,
    state: () => JSON.parse(host.querySelector('output')!.textContent!),
    id: conversation.id,
    close: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

it('Shift 跨缺口先确认加载，本地加载完成按消息条数反馈并保留锚点', async () => {
  const confirm = vi.spyOn(useDialog.getState(), 'confirm').mockResolvedValue(true),
    f = fixture();
  try {
    f.load.mockImplementation(async (request, onPage) => {
      expect(request.mode).toBe('local');
      onPage([2, 3, 4].map((seq) => f.message(seq)));
      onPage([f.message(4)]);
    });
    await f.click('[data-enter]');
    await f.click('[data-weq-select-id="5"]', true);
    expect(confirm).toHaveBeenCalledOnce();
    expect(f.state().ids.sort()).toEqual(['1', '2', '3', '4', '5']);
    expect(f.state().anchor).toBe('1');
    expect(f.host.textContent).toContain('已加载 3 条消息');
    expect(f.host.querySelector('[aria-label="已选 5 条消息"]')).not.toBeNull();
    f.render([f.message(10), f.message(12)]);
    f.load.mockImplementation(async (request, onPage) => {
      expect(request.startSeq).toBe('1');
      expect(request.endSeq).toBe('12');
      onPage(Array.from({ length: 12 }, (_, i) => f.message(i + 1)));
    });
    await f.click('[data-weq-select-id="12"]', true);
    expect(f.state().ids).toHaveLength(12);
    expect(f.state().anchor).toBe('1');
  } finally {
    f.close();
  }
});
it('拒绝加载不改变已有选区；选中缺口单独确认漫游，补到消息后替换缺口', async () => {
  const confirm = vi.spyOn(useDialog.getState(), 'confirm').mockResolvedValue(false),
    f = fixture();
  try {
    await f.click('[data-enter]');
    await f.click('[data-weq-select-id="5"]', true);
    expect(f.load).not.toHaveBeenCalled();
    expect(f.state().ids).toEqual(['1']);
    expect(f.state().anchor).toBe('1');
    confirm.mockResolvedValue(true);
    f.load.mockImplementation(async (request, onPage) => {
      expect(request.mode).toBe('roaming');
      expect(request.startSeq).toBe('2');
      expect(request.endSeq).toBe('4');
      onPage(
        [2, 3, 4].map((seq) => ({
          ...f.message(seq),
          source: 'roaming' as const,
          sourceFormat: 'protocol' as const,
        })),
      );
    });
    await f.click('[data-message-id="gap:1:5"]');
    expect(f.load).toHaveBeenCalledOnce();
    expect(f.state().ids.sort()).toEqual(['1', '2', '3', '4']);
    expect(f.host.textContent).toContain('拉取漫游消息完成 · 已加载 3 条消息');
  } finally {
    f.close();
  }
});
it('同会话搜索或日历窗口变化和切换会话返回均保留选区与锚点', async () => {
  const f = fixture();
  try {
    await f.click('[data-enter]');
    f.render([f.message(20), f.message(21)]);
    expect(f.state().ids).toEqual(['1']);
    expect(f.state().anchor).toBe('1');
    f.render([f.message(1, 'other')], 'other');
    expect(f.state().mode).toBe(false);
    f.render([f.message(1), f.message(5)]);
    expect(f.state()).toEqual({ mode: true, ids: ['1'], anchor: '1' });
  } finally {
    f.close();
  }
});

it('加载中换会话中止后续读取，不把迟到结果选到新会话', async () => {
  vi.spyOn(useDialog.getState(), 'confirm').mockResolvedValue(true);
  const f = fixture();
  let release!: () => void;
  let signal: AbortSignal | undefined;
  try {
    f.load.mockImplementation(async (_request, onPage, current) => {
      signal = current;
      onPage([f.message(2)]);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      current.throwIfAborted();
      onPage([f.message(3), f.message(4)]);
    });
    await f.click('[data-enter]');
    await f.click('[data-weq-select-id="5"]', true);
    expect(f.host.textContent).toContain('已加载 1 条消息');
    f.render([f.message(1, 'other')], 'other');
    expect(signal?.aborted).toBe(true);
    await act(async () => release());
    expect(f.state().mode).toBe(false);
    f.render([f.message(1), f.message(5)]);
    expect(f.state()).toEqual({ mode: true, ids: ['1'], anchor: '1' });
  } finally {
    f.close();
  }
});

it('已选漫游消息同步为本地记录时迁移可靠身份，选择和锚点不丢失', async () => {
  vi.spyOn(useDialog.getState(), 'confirm').mockResolvedValue(true);
  const f = fixture();
  const old = {
    ...f.message(2),
    id: 'roaming:protocol:2:old',
    msgId: 'old',
    msgRandom: '777',
    source: 'roaming' as const,
    sourceFormat: 'protocol' as const,
  };
  try {
    f.load.mockImplementation(async (_request, onPage) =>
      onPage([old, f.message(3), f.message(4)]),
    );
    await f.click('[data-enter]');
    await f.click('[data-message-id="gap:1:5"]');
    f.render([f.message(1), old, f.message(3), f.message(4), f.message(5)]);
    await f.click('[data-weq-select-id="roaming:protocol:2:old"]');
    await f.click('[data-weq-select-id="roaming:protocol:2:old"]');
    f.render([
      f.message(1),
      { ...f.message(2), id: '20', msgId: '9002', msgRandom: '777' },
      f.message(3),
      f.message(4),
      f.message(5),
    ]);
    expect(f.state().ids).toContain('20');
    expect(f.state().ids).not.toContain(old.id);
    expect(f.state().anchor).toBe('20');
  } finally {
    f.close();
  }
});

it('私聊未确认的协议序号不能进入所选范围，失败保留原选择', async () => {
  vi.spyOn(useDialog.getState(), 'confirm').mockResolvedValue(true);
  const f = fixture('direct');
  try {
    f.load.mockImplementation(async (_request, onPage) =>
      onPage([
        { ...f.message(2), source: 'roaming', sourceFormat: 'protocol', ntSeqVerified: false },
      ]),
    );
    await f.click('[data-enter]');
    await f.click('[data-message-id="gap:1:5"]');
    expect(f.state().ids).toEqual(['1', 'gap:1:5']);
    expect(f.host.textContent).toContain('NT 序号尚未确认');
  } finally {
    f.close();
  }
});
