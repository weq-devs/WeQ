import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({
  consume: vi.fn<() => Promise<{ configId: string; uin: string } | null>>(),
  config: vi.fn(async () => ({ configId: 'cfg-current' })),
  configs: vi.fn(async () => [
    { configId: 'cfg-10001', uin: '10001', dbKey: 'synthetic' },
    { configId: 'cfg-10002', uin: '10002', dbKey: 'synthetic' },
  ]),
  switch: vi.fn<(options: unknown) => Promise<{ switched: boolean; reason?: 'busy' }>>(),
  error: vi.fn(),
  unsubscribe: vi.fn(),
  signal: () => {},
  queryClient: {},
  utils: {},
}));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => io.queryClient }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: { useUtils: () => io.utils },
  client: {
    bootstrap: {
      consumeAccountSwitchRequest: { query: io.consume },
      listAccountConfigs: { query: io.configs },
      onAccountSwitchRequested: {
        subscribe: (_input: unknown, options: { onData: () => void }) => {
          io.signal = options.onData;
          return { unsubscribe: io.unsubscribe };
        },
      },
    },
    account: { getAccountConfig: { query: io.config } },
  },
}));
vi.mock('../src/renderer/src/components/Dialog', () => ({
  useDialog: () => io.error,
}));
vi.mock('../src/renderer/src/lib/switchAccount', () => ({ switchAccount: io.switch }));
import { AccountSwitchRequestHost } from '../src/renderer/src/components/AccountSwitchRequestHost';
import { useAccountSwitch } from '../src/renderer/src/state/accountSwitch';
import { useViewState } from '../src/renderer/src/state/view';

let root: Root;
let host: HTMLDivElement;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  io.consume.mockReset().mockResolvedValue(null);
  io.switch.mockReset().mockResolvedValue({ switched: true });
  useAccountSwitch.getState().end();
  useViewState.setState({ view: 'main', openedUin: '99999' });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useAccountSwitch.getState().end();
  vi.unstubAllGlobals();
});
function mount() {
  act(() => root.render(createElement(AccountSwitchRequestHost)));
}

it('多个信号共享一个消费者，先完成当前目标再按 FIFO 读取下一项', async () => {
  const first = deferred<{ configId: string; uin: string } | null>();
  const switching = deferred<{ switched: boolean }>();
  io.consume.mockReturnValueOnce(first.promise);
  io.consume.mockResolvedValueOnce({ configId: 'cfg-10002', uin: '10002' });
  io.switch.mockReturnValueOnce(switching.promise);
  mount();
  await vi.waitFor(() => expect(io.consume).toHaveBeenCalledOnce());
  act(() => {
    io.signal();
    io.signal();
  });
  expect(io.consume).toHaveBeenCalledOnce();
  first.resolve({ configId: 'cfg-10001', uin: '10001' });
  await vi.waitFor(() => expect(io.switch).toHaveBeenCalledOnce());
  act(() => io.signal());
  expect(io.consume).toHaveBeenCalledOnce();
  switching.resolve({ switched: true });
  await vi.waitFor(() => expect(io.switch).toHaveBeenCalledTimes(2));
  expect(
    io.switch.mock.calls.map(([options]) => (options as { target: { uin: string } }).target.uin),
  ).toEqual(['10001', '10002']);
});

it('领空的在途查询遇到新信号后继续消费，不遗漏最后一条请求', async () => {
  const empty = deferred<{ configId: string; uin: string } | null>();
  io.consume.mockReturnValueOnce(empty.promise);
  io.consume.mockResolvedValueOnce({ configId: 'cfg-10001', uin: '10001' });
  mount();
  await vi.waitFor(() => expect(io.consume).toHaveBeenCalledOnce());
  act(() => io.signal());
  empty.resolve(null);
  await vi.waitFor(() => expect(io.switch).toHaveBeenCalledOnce());
});

it('界面切号在进行时保留队列，结束后才领取外部请求', async () => {
  useAccountSwitch.getState().begin('合成切号');
  io.consume.mockResolvedValueOnce({ configId: 'cfg-10001', uin: '10001' });
  mount();
  act(() => io.signal());
  await Promise.resolve();
  expect(io.consume).not.toHaveBeenCalled();
  act(() => useAccountSwitch.getState().end());
  await vi.waitFor(() => expect(io.switch).toHaveBeenCalledOnce());
});

it('卸载会解除等待和订阅，不在切号结束后继续消费', async () => {
  useAccountSwitch.getState().begin('合成切号');
  mount();
  act(() => root.unmount());
  act(() => useAccountSwitch.getState().end());
  await Promise.resolve();
  expect(io.consume).not.toHaveBeenCalled();
  expect(io.unsubscribe).toHaveBeenCalledOnce();
});

it('目标已领取后遇到繁忙仍保留，结束后重新核当前账号再执行', async () => {
  io.consume.mockResolvedValueOnce({ configId: 'cfg-10001', uin: '10001' });
  io.switch.mockImplementationOnce(async () => {
    useAccountSwitch.getState().begin('界面入口正在切号');
    return { switched: false, reason: 'busy' };
  });
  mount();
  await vi.waitFor(() => expect(io.switch).toHaveBeenCalledOnce());
  expect(io.consume).toHaveBeenCalledOnce();
  io.config.mockResolvedValueOnce({ configId: 'cfg-10002' });
  useViewState.setState({ openedUin: '10002' });
  act(() => useAccountSwitch.getState().end());
  await vi.waitFor(() => expect(io.switch).toHaveBeenCalledTimes(2));
  expect(io.switch.mock.calls[1]?.[0]).toMatchObject({
    target: { uin: '10001' },
    currentConfigId: 'cfg-10002',
    currentUin: '10002',
  });
  expect(io.config).toHaveBeenCalledTimes(2);
});

it('StrictMode 重挂只领取一次，模拟清理不会吞掉积压请求', async () => {
  io.consume.mockResolvedValueOnce({ configId: 'cfg-10001', uin: '10001' });
  act(() => root.render(createElement(StrictMode, null, createElement(AccountSwitchRequestHost))));
  await vi.waitFor(() => expect(io.switch).toHaveBeenCalledOnce());
  expect(io.unsubscribe).toHaveBeenCalledOnce();
});

it('目标已删除只提示该项失败，后续目标仍按顺序执行', async () => {
  io.consume.mockResolvedValueOnce({ configId: 'deleted', uin: '0' });
  io.consume.mockResolvedValueOnce({ configId: 'cfg-10001', uin: '10001' });
  mount();
  await vi.waitFor(() => expect(io.switch).toHaveBeenCalledOnce());
  expect(io.error).toHaveBeenCalledOnce();
  expect(io.switch.mock.calls[0]?.[0]).toMatchObject({ target: { uin: '10001' } });
});
