import { act, createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useFailedOutgoingRemoval } from '../src/renderer/src/hooks/useFailedOutgoingRemoval';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import type { LocalOutgoingRecord } from '../src/renderer/src/lib/localOutgoing';
import type { Message } from '../src/renderer/src/im-template/template/types';

const demo = createTemplateDemoData();
const first = {
  ...demo.messages[0]!,
  id: 'optimistic-first',
  conversationId: '123',
  optimistic: 'failed' as const,
  msgSeq: undefined,
  msgRandom: undefined,
};
const second = { ...first, id: 'optimistic-second' };
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});
function fixture() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const refresh = vi.fn(async (_conversations: ReadonlySet<string>) => {});
  let dismiss!: ReturnType<typeof useFailedOutgoingRemoval>;
  let values: LocalOutgoingRecord[][] = [];
  let activate!: (convId: string | null) => void;
  const initial: LocalOutgoingRecord[] = [
    { id: first.id, convId: '123', state: 'failed' },
    { id: second.id, convId: '123', state: 'failed' },
    { id: first.id, convId: '456', state: 'failed' },
    { id: 'optimistic-sent', convId: '123', state: 'sent' },
  ];
  function Harness() {
    const [activeConv, setActiveConv] = useState<string | null>('123');
    activate = setActiveConv;
    const [messages, setMessages] = useState(initial),
      [arks, setArks] = useState(initial),
      [forwards, setForwards] = useState(initial);
    values = [messages, arks, forwards];
    dismiss = useFailedOutgoingRemoval((remove) => {
      setMessages(remove);
      setArks(remove);
      setForwards(remove);
    }, refresh);
    return activeConv
      ? h(
          'section',
          null,
          messages
            .filter((row) => row.convId === activeConv)
            .map((row) => h('span', { key: row.id }, row.id)),
        )
      : null;
  }
  const root = createRoot(document.createElement('div'));
  let mounted = true;
  const unmount = () => {
    if (mounted) {
      act(() => root.unmount());
      mounted = false;
    }
  };
  cleanups.push(unmount);
  act(() => root.render(h(Harness)));
  return {
    refresh,
    dismiss: (message: Message = first, convId = '123') => dismiss(message, convId),
    values: () => values,
    activate: (convId: string | null) => act(() => activate(convId)),
    update: () => act(() => root.render(h(Harness))),
    unmount,
  };
}

it('普通消息、Ark、转发占位一起清理，批量读取合并，重开视图不恢复旧条目', async () => {
  const f = fixture();
  await act(async () => {
    f.dismiss();
    f.dismiss(second);
  });
  for (const rows of f.values())
    expect(rows).toEqual([
      { id: first.id, convId: '456', state: 'failed' },
      { id: 'optimistic-sent', convId: '123', state: 'sent' },
    ]);
  expect(f.refresh).toHaveBeenCalledTimes(1);
  expect([...f.refresh.mock.calls[0]![0]]).toEqual(['123']);
  f.activate(null);
  f.activate('456');
  f.activate('123');
  f.update();
  expect(f.values()[0]!.some((row) => row.id === first.id && row.convId === '123')).toBe(false);
});

it('错会话和已发送的快照不触发清理或附带读取', async () => {
  const f = fixture();
  const before = f.values();
  await act(async () => {
    expect(f.dismiss(first, '456')).toBe(false);
    expect(f.dismiss({ ...first, optimistic: 'sent' })).toBe(false);
  });
  expect(f.values()).toEqual(before);
  expect(f.refresh).not.toHaveBeenCalled();
});

it('卸载取消排队读取，摘要读取失败也不恢复已移除的占位', async () => {
  const f = fixture();
  act(() => {
    f.dismiss();
    f.unmount();
  });
  await act(async () => {});
  expect(f.refresh).not.toHaveBeenCalled();
  const next = fixture();
  next.refresh.mockRejectedValue(new Error('合成读取失败'));
  await act(async () => {
    next.dismiss();
  });
  expect(next.values()[0]!.some((row) => row.id === first.id && row.convId === '123')).toBe(false);
});
