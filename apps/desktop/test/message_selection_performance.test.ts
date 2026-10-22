import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useMessageSelectionFlow } from '../src/renderer/src/hooks/useMessageSelectionFlow';
import { useContentMultiSelect } from '../src/renderer/src/state/contentSelection';
import type { Message } from '../src/renderer/src/im-template/template/types';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import { useMultiSelection } from '../src/renderer/src/hooks/useMultiSelection';

vi.mock('../src/renderer/src/im-template/template/messageRow', () => ({ grayTipOf: () => null }));
afterEach(() => vi.unstubAllGlobals());

it('通用多选的输入模式和禁用状态变更不重建稳定 ID 快照', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let reads = 0;
  const ids = new Proxy(
    Array.from({ length: 2000 }, (_, i) => String(i)),
    {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
        return Reflect.get(target, key, receiver);
      },
    },
  );
  const selected = new Set<string>();
  function Probe({ disabled }: { disabled: boolean }) {
    const multi = useMultiSelection({ ids, selected, disabled, onChange: () => {} });
    return createElement('div', multi.rootProps);
  }
  const host = document.createElement('div'),
    root = createRoot(host);
  try {
    act(() => root.render(createElement(Probe, { disabled: false })));
    reads = 0;
    act(() => root.render(createElement(Probe, { disabled: true })));
    expect(reads).toBe(0);
    act(() => root.render(createElement(Probe, { disabled: false })));
    expect(reads).toBe(0);
  } finally {
    act(() => root.unmount());
  }
});

it('消息快照不变时，单条选择不重新遍历全部消息身份', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const conversation = createTemplateDemoData().conversations.find((row) => row.type === 'group')!;
  let reads = 0;
  const messages: Message[] = Array.from({ length: 2000 }, (_, index) => ({
    get id() {
      reads++;
      return String(index + 1);
    },
    conversationId: conversation.id,
    senderId: 'u_synthetic',
    body: '合成消息',
    createdAt: new Date(0).toISOString(),
    msgSeq: String(index + 1),
  }));
  let flow: ReturnType<typeof useMessageSelectionFlow> | undefined;
  let selection: ReturnType<typeof useContentMultiSelect> | undefined;
  function Probe() {
    selection = useContentMultiSelect({ kind: 'messages', container: conversation.id });
    flow = useMessageSelectionFlow({ conversation, messages, selection, active: true });
    return null;
  }
  const host = document.createElement('div'),
    root = createRoot(host);
  try {
    act(() => root.render(createElement(Probe)));
    act(() => selection?.setSelectionMode(true));
    reads = 0;
    act(() => selection?.setSelectedIds(new Set(['1500'])));
    expect(flow?.selectedMessages.map((row) => row.id)).toEqual(['1500']);
    expect(reads).toBeLessThan(20);
    reads = 0;
    act(() => selection?.setSelectedIds(new Set(['1600'])));
    expect(flow?.selectedMessages.map((row) => row.id)).toEqual(['1600']);
    expect(reads).toBeLessThan(20);
  } finally {
    act(() => root.unmount());
  }
});
