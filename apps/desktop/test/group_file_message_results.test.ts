import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GroupFileMessageResults } from '../src/renderer/src/components/GroupFileMessageResults';
const rpc = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: { account: { findGroupFileMessages: { query: rpc.query } } },
}));
const row = (seq: string) => ({
  msgId: `900${seq}`,
  msgSeq: seq,
  sendTime: '1794380000',
  senderUid: 'u_fixture',
});
const props = {
  groupCode: '777',
  fileId: 'file',
  fileName: '合成文件.txt',
  binding: { expectedAccountUin: '10001', expectedAccountConfigId: 'source-a' },
  onJump: vi.fn(),
  onClose: vi.fn(),
};
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const render = async () => act(async () => root.render(h(GroupFileMessageResults, props)));
const click = async (label: string) =>
  act(async () => host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click());

it('仅挂载定位结果时查询，唯一命中携带精确消息 ID 跳转', async () => {
  expect(rpc.query).not.toHaveBeenCalled();
  rpc.query.mockResolvedValue({ messages: [row('12')], nextBefore: null });
  await render();
  expect(rpc.query).toHaveBeenCalledWith({
    ...props.binding,
    groupCode: '777',
    fileId: 'file',
    before: undefined,
  });
  expect(props.onJump).toHaveBeenCalledWith('12', '90012');
});
it('多条命中不自动跳转，保留分页结果并允许逐条选择', async () => {
  const before = { msgId: '90011', msgSeq: '11', sendTime: '1794380000' };
  rpc.query.mockResolvedValueOnce({ messages: [row('12'), row('11')], nextBefore: before });
  await render();
  expect(props.onJump).not.toHaveBeenCalled();
  rpc.query.mockResolvedValueOnce({ messages: [row('10')], nextBefore: null });
  await act(async () =>
    [...host.querySelectorAll('button')].find((b) => b.textContent === '查找更早记录')!.click(),
  );
  expect(rpc.query.mock.calls.at(-1)?.[0].before).toEqual(before);
  const hits = host.querySelectorAll<HTMLButtonElement>('li button');
  expect(hits.length).toBe(3);
  await act(async () => hits[2]!.click());
  expect(props.onJump).toHaveBeenCalledWith('10', '90010');
});
it('空结果不跳转，查询失败可重试', async () => {
  rpc.query.mockRejectedValueOnce(new Error('合成查询失败'));
  await render();
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('合成查询失败');
  rpc.query.mockResolvedValueOnce({ messages: [], nextBefore: null });
  await click('重试定位');
  expect(host.textContent).toContain('本地未找到对应消息');
  expect(props.onJump).not.toHaveBeenCalled();
});
it('卸载或切换来源后丢弃迟到结果', async () => {
  let resolve!: (value: unknown) => void;
  rpc.query.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  await render();
  rpc.query.mockResolvedValueOnce({ messages: [], nextBefore: null });
  await act(async () =>
    root.render(
      h(GroupFileMessageResults, {
        ...props,
        binding: { ...props.binding, expectedAccountConfigId: 'source-b' },
      }),
    ),
  );
  await act(async () => resolve({ messages: [row('12')], nextBefore: null }));
  expect(props.onJump).not.toHaveBeenCalled();
  expect(host.textContent).toContain('本地未找到对应消息');
});
