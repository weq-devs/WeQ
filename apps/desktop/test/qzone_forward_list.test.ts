import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { QzoneForwardAction } from '../src/renderer/src/components/QzoneForwardAction';

const { query, cancel } = vi.hoisted(() => ({ query: vi.fn(), cancel: vi.fn(async () => {}) }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: { account: { qzone: { forwards: { query }, cancel: { mutate: cancel } } } },
}));
vi.mock('../src/renderer/src/components/QzoneProfileAvatar', () => ({
  QzonePersonIdentity: ({
    nickname,
    uin,
    onSpace,
  }: {
    nickname: string;
    uin: string;
    onSpace: (uin: string, nickname: string) => void;
  }) => h('button', { onClick: () => onSpace(uin, nickname) }, nickname),
}));
const target = { selfUin: '10001', hostUin: '10002', tid: 'post' };
const cursor = { attachInfo: 'next', previousPageKey: 'a'.repeat(64) };
const person = (key = 'a', content = '合成转发语') => ({
  key,
  uin: '10003',
  nickname: '合成用户',
  content,
  isFriend: true,
});
const result = (
  forwards = [person()],
  nextCursor: typeof cursor | null = cursor,
  stopReason: string | null = null,
) => ({ forwards, nextCursor, reportedTotal: 1288, rawCount: 20, hasMore: true, stopReason });
let root: ReturnType<typeof createRoot>, host: HTMLDivElement;
afterEach(() => {
  if (root) act(() => root.unmount());
  host?.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
async function setup() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const write = vi.fn(),
    onSpace = vi.fn();
  await act(async () => root.render(h(QzoneForwardAction, { target, onClick: write, onSpace })));
  return { write, onSpace };
}
async function open() {
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="查看转发者"]')!.click(),
  );
}
it('未打开时不读取；查看名单不发起转发，成功后校准数量', async () => {
  query.mockResolvedValue(result());
  const { write, onSpace } = await setup();
  expect(query).not.toHaveBeenCalled();
  await open();
  await vi.waitFor(() => expect(document.body.textContent).toContain('合成转发语'));
  expect(host.querySelector('[aria-label="转发"]')?.textContent).toContain('1288');
  expect(write).not.toHaveBeenCalled();
  await act(async () =>
    document.querySelector<HTMLButtonElement>('.weq-qzn-forward-row button')!.click(),
  );
  expect(onSpace).toHaveBeenCalledWith('10003', '合成用户');
});
it('按游标追加并去重，遇重复末页停止而不伪造已取得总数', async () => {
  query.mockResolvedValueOnce(result()).mockResolvedValueOnce(result([], null, 'repeated-page'));
  await setup();
  await open();
  const more = [...document.querySelectorAll('button')].find(
    (button) => button.textContent === '加载更多',
  )!;
  await act(async () => more.click());
  expect(query.mock.calls[1]![0].cursor).toEqual(cursor);
  expect(document.querySelectorAll('.weq-qzn-forward-row')).toHaveLength(1);
  expect(document.body.textContent).toContain('已读取 1 人 · 共 1288 次转发');
  expect(document.body.textContent).toContain('已到可读取末页');
  expect(document.body.textContent).not.toContain('加载更多');
  expect(query).toHaveBeenCalledTimes(2);
});
it('后续页失败保留名单，重试仍用失败的游标', async () => {
  query
    .mockResolvedValueOnce(result())
    .mockRejectedValueOnce(new Error('合成读取失败'))
    .mockResolvedValueOnce(result([person(), person('b', '第二条转发语')], null, 'complete'));
  await setup();
  await open();
  await act(async () =>
    [...document.querySelectorAll('button')]
      .find((button) => button.textContent === '加载更多')!
      .click(),
  );
  expect(document.querySelectorAll('.weq-qzn-forward-row')).toHaveLength(1);
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[title="重试转发名单"]')!.click(),
  );
  expect(query.mock.calls[2]![0].cursor).toEqual(cursor);
  expect(document.querySelectorAll('.weq-qzn-forward-row')).toHaveLength(2);
});
it('浮层关闭后取消自己的读取，不接受迟到回包', async () => {
  let finish!: (value: ReturnType<typeof result>) => void;
  query.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await setup();
  await open();
  await vi.waitFor(() => expect(query).toHaveBeenCalledOnce());
  await act(async () =>
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  );
  expect(cancel).toHaveBeenCalled();
  await act(async () => finish(result()));
  expect(document.querySelector('[aria-label="转发列表"]')).toBeNull();
  expect(host.querySelector('[aria-label="转发"]')?.textContent).toContain('?');
});
