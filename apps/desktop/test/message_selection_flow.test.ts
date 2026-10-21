import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { Storage } from 'happy-dom';
import { ChatPane } from '../src/renderer/src/im-template/template/chatPane';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import {
  ContentSelectionProvider,
  useContentMultiSelect,
  useContentExportRequest,
  useContentAnalysisRequest,
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
  const remove = vi.fn();
  const forward = vi.fn(),
    merge = vi.fn(),
    composition = vi.fn();
  function Probe({ id }: { id: string }) {
    const exportRequest = useContentExportRequest();
    const analysisRequest = useContentAnalysisRequest();
    const selection = useContentMultiSelect({
      kind: 'messages',
      container: `${conversation.type}:${id}`,
    });
    return h(
      'aside',
      null,
      h('pre', { 'data-export': true }, JSON.stringify(exportRequest?.selection ?? null)),
      h('pre', { 'data-analysis': true }, JSON.stringify(analysisRequest)),
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
  const render = (
    messages = [message(1), message(5)],
    id = conversation.id,
    deletion: {
      deletedIds?: Set<string>;
      onRestoreMessage?: (id: string) => Promise<void>;
    } = {},
  ) =>
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
            onDeleteMessage: remove,
            onForwardMessages: forward,
            onMergeForward: merge,
            onAddToComposition: composition,
            ...deletion,
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
    remove,
    forward,
    merge,
    composition,
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

it('缺口选择只计数且不提醒，导出前才确认，取消不拉取或执行操作', async () => {
  const confirm = vi.spyOn(useDialog.getState(), 'confirm').mockResolvedValue(false);
  const f = fixture();
  try {
    await f.click('[data-enter]');
    expect(
      f.host.querySelector('[aria-label="转发"]')?.classList.contains('selection-action-primary'),
    ).toBe(false);
    await f.click('[data-message-id="gap:1:5"]');
    expect(confirm).not.toHaveBeenCalled();
    expect(f.load).not.toHaveBeenCalled();
    expect(useToast.getState().toasts).toHaveLength(0);
    expect(f.host.querySelector('[aria-label="已选 4 条消息"]')).not.toBeNull();
    expect(f.host.querySelector<HTMLButtonElement>('[aria-label="导出所选消息"]')!.disabled).toBe(
      false,
    );
    await f.click('[aria-label="导出所选消息"]');
    expect(confirm).toHaveBeenCalledOnce();
    expect(f.load).not.toHaveBeenCalled();
    expect(JSON.parse(f.host.querySelector('[data-export]')!.textContent!)).toBeNull();
    expect(f.state().ids).toEqual(['1', 'gap:1:5']);
    confirm.mockResolvedValue(true);
    f.load.mockImplementation(async (request, onPage) => {
      if (request.mode === 'local') return;
      expect(request.mode).toBe('roaming');
      onPage([2, 3, 4].map((seq) => f.message(seq)));
    });
    await f.click('[aria-label="导出所选消息"]');
    expect(f.load).toHaveBeenCalledTimes(2);
    expect(JSON.parse(f.host.querySelector('[data-export]')!.textContent!).scope.ids).toEqual([
      '1',
      '2',
      '3',
      '4',
    ]);
  } finally {
    f.close();
  }
});

it.each(['分析所选消息', '删除', '添加到素材库', '合并转发', '逐条转发'] as const)(
  '只选缺口也可在%s前确认拉取，不用先选一条已有消息',
  async (action) => {
    const confirm = vi.spyOn(useDialog.getState(), 'confirm').mockResolvedValue(true);
    const f = fixture();
    try {
      await f.click('[data-enter]');
      await f.click('[data-message-id="gap:1:5"]');
      await f.click('[data-weq-select-id="1"]');
      expect(f.state().ids).toEqual(['gap:1:5']);
      expect(confirm).not.toHaveBeenCalled();
      f.load.mockImplementation(async (_request, onPage) =>
        onPage([2, 3, 4].map((seq) => f.message(seq))),
      );
      if (action === '合并转发' || action === '逐条转发') {
        await f.click('[aria-label="转发"]');
        expect(confirm).not.toHaveBeenCalled();
        await act(async () =>
          [...document.querySelectorAll<HTMLButtonElement>('button')]
            .find((row) => row.textContent === action)!
            .click(),
        );
      } else await f.click(`[aria-label="${action}"]`);
      expect(confirm).toHaveBeenCalledTimes(action === '删除' ? 2 : 1);
      expect(f.load).toHaveBeenCalledOnce();
      if (action === '分析所选消息')
        expect(
          JSON.parse(f.host.querySelector('[data-analysis]')!.textContent!).messageIds,
        ).toEqual(['2', '3', '4']);
      else if (action === '删除') {
        expect(f.remove).toHaveBeenCalledTimes(3);
        expect(f.state().mode).toBe(false);
      } else {
        const callback =
          action === '添加到素材库' ? f.composition : action === '合并转发' ? f.merge : f.forward;
        expect(callback).toHaveBeenCalledOnce();
        expect(callback.mock.calls[0]![0].map((message: Message) => message.id)).toEqual([
          '2',
          '3',
          '4',
        ]);
      }
    } finally {
      f.close();
    }
  },
);

it('Shift 跨缺口与跨窗口范围只选择和计数，操作前加载且保留锚点', async () => {
  const confirm = vi.spyOn(useDialog.getState(), 'confirm').mockResolvedValue(true),
    f = fixture();
  try {
    f.load.mockImplementation(async (request, onPage) => {
      if (request.mode === 'local') return;
      expect(request.mode).toBe('roaming');
      onPage([2, 3, 4].map((seq) => f.message(seq)));
      onPage([f.message(4)]);
    });
    await f.click('[data-enter]');
    await f.click('[data-weq-select-id="5"]', true);
    expect(confirm).not.toHaveBeenCalled();
    expect(f.load).not.toHaveBeenCalled();
    expect(f.state().ids).toEqual(['1', 'gap:1:5', '5']);
    expect(f.host.querySelector('[aria-label="已选 5 条消息"]')).not.toBeNull();
    await f.click('[aria-label="导出所选消息"]');
    expect(confirm).toHaveBeenCalledOnce();
    expect(f.state().ids.sort()).toEqual(['1', '2', '3', '4', '5']);
    expect(f.state().anchor).toBe('1');
    expect(f.host.textContent).toContain('已加载 3 条消息');
    expect(f.host.querySelector('[aria-label="已选 5 条消息"]')).not.toBeNull();
    f.render([f.message(10), f.message(12)]);
    f.load.mockImplementation(async (request, onPage) => {
      const first = Number(request.startSeq),
        last = Number(request.endSeq);
      onPage(Array.from({ length: last - first + 1 }, (_, i) => f.message(first + i)));
    });
    await f.click('[data-weq-select-id="12"]', true);
    expect(confirm).toHaveBeenCalledOnce();
    expect(f.host.querySelector('[aria-label="已选 12 条消息"]')).not.toBeNull();
    await f.click('[aria-label="导出所选消息"]');
    expect(f.state().ids).toHaveLength(12);
    expect(f.state().anchor).toBe('1');
  } finally {
    f.close();
  }
});

it.each(['导出所选消息', '分析所选消息', '删除'] as const)(
  '混合自己的正式记录和待同步记录：%s 可确认、预览并仅处理支持项',
  async (label) => {
    const actionLabel = label === '删除' ? '删除' : label === '分析所选消息' ? '分析' : '导出';
    if (label === '删除') vi.spyOn(useDialog.getState(), 'confirm').mockResolvedValue(true);
    const f = fixture();
    const own = { ...f.message(1), senderId: 'self', body: '自己的正式消息' };
    const pending = {
      ...f.message(2),
      id: 'optimistic-pending',
      body: '等待同步的消息',
      optimistic: 'sent' as const,
    };
    try {
      f.render([own, pending]);
      await f.click('[data-enter]');
      await f.click('[data-weq-select-id="optimistic-pending"]');
      const button = f.host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
      expect(button.disabled).toBe(false);
      await act(async () => button.click());
      expect(document.body.textContent).toContain(`1 条消息不支持${actionLabel}，1 条可以继续`);
      const clickText = async (text: string) =>
        act(async () =>
          [...document.querySelectorAll<HTMLButtonElement>('button')]
            .find((item) => item.textContent === text)!
            .click(),
        );
      await clickText('预览不支持的消息');
      expect(document.querySelector('.weq-private-preview-inline')).not.toBeNull();
      expect(document.body.textContent).toContain('等待同步的消息');
      expect(document.body.textContent).toContain('等待正式记录同步入库');
      expect(f.remove).not.toHaveBeenCalled();
      await clickText(`仅${actionLabel}支持的 1 条`);
      if (label === '删除') {
        expect(f.remove).toHaveBeenCalledOnce();
        expect(f.remove).toHaveBeenCalledWith(own, expect.anything(), false);
        expect(f.state().ids).toEqual([pending.id]);
      } else if (label === '分析所选消息')
        expect(
          JSON.parse(f.host.querySelector('[data-analysis]')!.textContent!).messageIds,
        ).toEqual([own.id]);
      else
        expect(JSON.parse(f.host.querySelector('[data-export]')!.textContent!).scope.ids).toEqual([
          own.id,
        ]);
      expect(document.querySelector('.weq-message-batch-dialog')).toBeNull();
    } finally {
      f.close();
    }
  },
);

it('全部不支持时仍可打开说明，取消保留选区，切会话销毁旧确认而不操作', async () => {
  const f = fixture();
  try {
    f.render([{ ...f.message(1), optimistic: 'sending' }]);
    await f.click('[data-enter]');
    await f.click('[aria-label="删除"]');
    const continueButton = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === '仅删除支持的 0 条',
    )!;
    expect(continueButton.disabled).toBe(true);
    await act(async () =>
      [...document.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === '取消')!
        .click(),
    );
    expect(f.state().ids).toEqual(['1']);
    await f.click('[aria-label="删除"]');
    f.render([f.message(1, 'other')], 'other');
    expect(document.querySelector('.weq-message-batch-dialog')).toBeNull();
    expect(f.remove).not.toHaveBeenCalled();
  } finally {
    f.close();
  }
});

it('取消删除确认不发请求且保留原选区', async () => {
  const confirm = vi.spyOn(useDialog.getState(), 'confirm').mockResolvedValue(false);
  const f = fixture();
  try {
    f.render([f.message(1), f.message(2)]);
    await f.click('[data-enter]');
    await f.click('[aria-label="删除"]');
    expect(confirm).toHaveBeenCalledOnce();
    expect(f.remove).not.toHaveBeenCalled();
    expect(f.state().ids).toEqual(['1']);
    expect(f.state().mode).toBe(true);
  } finally {
    f.close();
  }
});

it('批量恢复只处理选中的已删除消息，失败条目与普通消息保留选中', async () => {
  const f = fixture();
  const restore = vi.fn(async (id: string) => {
    if (id === '3') throw Error('合成恢复失败');
  });
  try {
    f.render(
      [1, 2, 3].map((seq) => f.message(seq)),
      f.id,
      { deletedIds: new Set(['2', '3']), onRestoreMessage: restore },
    );
    await f.click('[data-enter]');
    expect(f.host.querySelector('[aria-label="恢复所选已删除消息"]')).toBeNull();
    await f.click('[data-weq-select-id="2"]');
    await f.click('[data-weq-select-id="3"]');
    await f.click('[aria-label="恢复所选已删除消息"]');
    expect(restore.mock.calls.map(([id]) => id)).toEqual(['2', '3']);
    expect(f.state().ids).toEqual(['1', '3']);
    expect(useToast.getState().toasts.some((toast) => toast.title === '恢复消息失败')).toBe(true);
  } finally {
    f.close();
  }
});

it('批量删除仅移除成功项的选择，失败项可再次操作', async () => {
  vi.spyOn(useDialog.getState(), 'confirm').mockResolvedValue(true);
  const f = fixture();
  f.remove.mockRejectedValueOnce(Error('合成删除失败')).mockResolvedValueOnce(undefined);
  try {
    f.render([f.message(1), f.message(2)]);
    await f.click('[data-enter]');
    await f.click('[data-weq-select-id="2"]');
    await f.click('[aria-label="删除"]');
    expect(f.remove).toHaveBeenCalledTimes(2);
    expect(f.state().ids).toEqual(['1']);
    expect(f.state().mode).toBe(true);
  } finally {
    f.close();
  }
});

it.each(['切换会话', '卸载'] as const)(
  '删除确认等待中%s，迟到确认不删除旧消息或新目标',
  async (change) => {
    let resolve!: (accepted: boolean) => void;
    vi.spyOn(useDialog.getState(), 'confirm').mockImplementation(
      () =>
        new Promise<boolean>((done) => {
          resolve = done;
        }),
    );
    const f = fixture();
    let closed = false;
    try {
      f.render([f.message(1), f.message(2)]);
      await f.click('[data-enter]');
      await f.click('[aria-label="删除"]');
      expect(f.remove).not.toHaveBeenCalled();
      if (change === '切换会话') f.render([f.message(1, 'other')], 'other');
      else {
        f.close();
        closed = true;
      }
      await act(async () => resolve(true));
      expect(f.remove).not.toHaveBeenCalled();
    } finally {
      if (!closed) f.close();
    }
  },
);

it('同序号但发送 random 不同的正式记录不能替换自己的已选占位', async () => {
  const f = fixture();
  try {
    f.render([{ ...f.message(1), optimistic: 'sent', msgRandom: '777' }]);
    await f.click('[data-enter]');
    f.render([{ ...f.message(1), id: '9001', msgId: '9001', msgRandom: '888' }]);
    expect(f.state().ids).toEqual(['1']);
    expect(f.state().anchor).toBe('1');
  } finally {
    f.close();
  }
});

it.each(['导出所选消息', '删除'] as const)(
  '正式消息与自己已持久化的缓存一起选择时可直接%s',
  async (label) => {
    if (label === '删除') vi.spyOn(useDialog.getState(), 'confirm').mockResolvedValue(true);
    const f = fixture();
    const cached = {
      ...f.message(2),
      id: 'roaming:protocol:2:77',
      msgId: '77',
      source: 'roaming' as const,
      sourceFormat: 'protocol' as const,
      localSent: true,
    };
    try {
      f.render([f.message(1), cached]);
      await f.click('[data-enter]');
      await f.click('[data-weq-select-id="roaming:protocol:2:77"]');
      await f.click(`[aria-label="${label}"]`);
      expect(document.querySelector('.weq-message-batch-dialog')).toBeNull();
      if (label === '删除') {
        expect(f.remove).toHaveBeenCalledTimes(2);
        expect(f.remove).toHaveBeenCalledWith(cached, expect.anything(), false);
        expect(f.state().mode).toBe(false);
      } else
        expect(JSON.parse(f.host.querySelector('[data-export]')!.textContent!).scope.ids).toEqual([
          '1',
          cached.id,
        ]);
    } finally {
      f.close();
    }
  },
);

it('自己的占位持久化为协议缓存后立即迁移已选身份，不等待 QQ 原库同步', async () => {
  const f = fixture();
  try {
    f.render([{ ...f.message(1), optimistic: 'sent', msgRandom: '77' }]);
    await f.click('[data-enter]');
    f.render([
      {
        ...f.message(1),
        id: 'roaming:protocol:1:77',
        msgId: '77',
        msgRandom: '77',
        source: 'roaming',
        sourceFormat: 'protocol',
        localSent: true,
      },
    ]);
    expect(f.state().ids).toEqual(['roaming:protocol:1:77']);
    expect(f.state().anchor).toBe('roaming:protocol:1:77');
  } finally {
    f.close();
  }
});
it('部分缺口尚未补全时不漏选执行操作，重试只拉剩余区间', async () => {
  const confirm = vi.spyOn(useDialog.getState(), 'confirm').mockResolvedValue(true),
    f = fixture();
  try {
    await f.click('[data-enter]');
    await f.click('[data-weq-select-id="5"]', true);
    expect(f.load).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(f.state().anchor).toBe('1');
    f.load.mockImplementationOnce(async (_request, onPage) => onPage([f.message(2)]));
    await f.click('[aria-label="导出所选消息"]');
    expect(f.state().ids).toEqual(['1', '5', '2', 'gap:2:5']);
    expect(JSON.parse(f.host.querySelector('[data-export]')!.textContent!)).toBeNull();
    expect(f.host.textContent).toContain('所选缺口尚未补全，未执行导出');
    f.load.mockImplementation(async (request, onPage) => {
      if (request.mode === 'local') return;
      expect(request.mode).toBe('roaming');
      expect(request.startSeq).toBe('3');
      expect(request.endSeq).toBe('4');
      onPage([3, 4].map((seq) => f.message(seq)));
    });
    await f.click('[aria-label="导出所选消息"]');
    expect(f.load).toHaveBeenCalledTimes(4);
    expect(f.state().ids.sort()).toEqual(['1', '2', '3', '4', '5']);
    expect(JSON.parse(f.host.querySelector('[data-export]')!.textContent!).scope.ids).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
    ]);
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
    expect(signal).toBeUndefined();
    await f.click('[aria-label="导出所选消息"]');
    expect(f.host.textContent).toContain('已加载 1 条消息');
    f.render([f.message(1, 'other')], 'other');
    expect(signal?.aborted).toBe(true);
    await act(async () => release());
    expect(f.state().mode).toBe(false);
    f.render([f.message(1), f.message(5)]);
    expect(f.state()).toEqual({ mode: true, ids: ['1', 'gap:1:5', '5'], anchor: '1' });
  } finally {
    f.close();
  }
});

it('已选漫游消息同步为本地记录时迁移可靠身份，选择和锚点不丢失', async () => {
  vi.spyOn(useDialog.getState(), 'confirm').mockResolvedValue(true);
  const f = fixture();
  const old = {
    ...f.message(2),
    id: 'roaming:protocol:2:77',
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
    await f.click('[aria-label="导出所选消息"]');
    f.render([f.message(1), old, f.message(3), f.message(4), f.message(5)]);
    await f.click(`[data-weq-select-id="${old.id}"]`);
    await f.click(`[data-weq-select-id="${old.id}"]`);
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
    await f.click('[aria-label="导出所选消息"]');
    expect(f.state().ids).toEqual(['1', 'gap:1:5']);
    expect(f.host.textContent).toContain('NT 序号尚未确认');
  } finally {
    f.close();
  }
});

it('已选自己的发送占位同步入库后迁移选择和锚点，不再阻断删除', async () => {
  const f = fixture();
  const own = { ...f.message(1), msgRandom: '777', optimistic: 'sent' as const };
  try {
    f.render([own]);
    await f.click('[data-enter]');
    f.render([{ ...f.message(1), id: '9001', msgId: '9001', msgRandom: '777' }]);
    expect(f.state().ids).toContain('9001');
    expect(f.state().ids).not.toContain(own.id);
    expect(f.state().anchor).toBe('9001');
    expect(f.host.querySelector<HTMLButtonElement>('[aria-label="删除"]')!.disabled).toBe(false);
  } finally {
    f.close();
  }
});
