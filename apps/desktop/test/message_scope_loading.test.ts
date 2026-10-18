import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { MessageScopePicker } from '../src/renderer/src/views/export/MessageScopePicker';

const rpc = vi.hoisted(() => ({ query: vi.fn(), latest: vi.fn(), before: vi.fn() }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    account: {
      browseConversation: { query: rpc.query },
      guildDirectLatest: { query: rpc.latest },
      guildDirectBefore: { query: rpc.before },
    },
  },
}));
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

it('频道范围按原始 seq 分页，保留列表外的离散已选身份，不使用普通聊天消息源', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  rpc.latest.mockResolvedValue(
    Array.from({ length: 50 }, (_, index) => ({
      msgId: String(100 - index),
      msgSeq: String(9007199254741099n - BigInt(index)),
      sendType: '0',
      elements: [],
    })),
  );
  rpc.before.mockResolvedValue([{ msgId: '1', msgSeq: '3', sendType: '2', elements: [] }]);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const changed = vi.fn();
  try {
    await act(async () =>
      root.render(
        createElement(MessageScopePicker, {
          kind: 'guild',
          conv: '100',
          selected: ['100', '1'],
          onChange: changed,
        }),
      ),
    );
    expect(rpc.query).not.toHaveBeenCalled();
    expect(rpc.latest).toHaveBeenCalledWith({ nodeId: '100', limit: 50, stablePaging: true });
    expect(host.textContent).toContain('当前列表之外的已选消息');
    const more = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('加载更多'),
    )!;
    await act(async () => more.click());
    expect(rpc.before).toHaveBeenCalledWith({
      nodeId: '100',
      beforeSeq: '9007199254741050',
      beforeMsgId: '51',
      limit: 50,
    });
    expect(host.querySelectorAll('.weq-message-scope-rows > label')).toHaveLength(51);
    expect(host.querySelector('details')).toBeNull();
    expect(changed).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('按会话导出不预取消息，只有启用精确选择才读取当前会话', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  rpc.query.mockResolvedValue({ items: [], cursor: null });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  function Harness() {
    const [selected, setSelected] = useState<string[]>();
    return createElement(MessageScopePicker, {
      kind: 'c2c',
      conv: 'u_fixture',
      selected,
      onChange: setSelected,
    });
  }
  try {
    act(() => root.render(createElement(Harness)));
    await act(async () => {});
    expect(rpc.query).not.toHaveBeenCalled();
    await act(async () => {
      host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
    });
    expect(rpc.query).toHaveBeenCalledOnce();
    expect(rpc.query).toHaveBeenCalledWith(
      expect.objectContaining({ conv: 'u_fixture', limit: 50 }),
    );
    await act(async () => {
      host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
    });
    expect(rpc.query).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
