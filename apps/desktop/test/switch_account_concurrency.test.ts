// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({
  close: vi.fn(async () => true),
  open: vi.fn(async () => ({})),
  warmup: vi.fn(async () => {}),
  confirm: vi.fn(async () => true),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: { bootstrap: { closeAccount: { mutate: io.close }, openAccount: { mutate: io.open } } },
}));
vi.mock('../src/renderer/src/lib/leaveAccount', () => ({ purgeAccountQueries: vi.fn() }));
vi.mock('../src/renderer/src/lib/accountWarmup', () => ({ runAccountWarmup: io.warmup }));
vi.mock('../src/renderer/src/state/mailDraft', () => ({ confirmMailAccountLeave: io.confirm }));

import { switchAccount } from '../src/renderer/src/lib/switchAccount';
import { useAccountSwitch } from '../src/renderer/src/state/accountSwitch';
import { useViewState } from '../src/renderer/src/state/view';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function run(uin: string) {
  return switchAccount({
    queryClient: {} as never,
    utils: {} as never,
    target: { configId: `cfg-${uin}`, uin, dbKey: 'synthetic' },
    currentConfigId: 'cfg-current',
    currentUin: '99999',
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  io.confirm.mockResolvedValue(true);
  io.close.mockResolvedValue(true);
  io.open.mockResolvedValue({});
  io.warmup.mockResolvedValue(undefined);
  useAccountSwitch.getState().end();
  useViewState.setState({ view: 'main', openedUin: '99999' });
});
afterEach(() => useAccountSwitch.getState().end());

it('真实 store：同轮两个入口仅一个关闭/打开，busy 调用不结束在途过渡', async () => {
  const close = deferred<boolean>();
  io.close.mockReturnValueOnce(close.promise);
  const first = run('10001');
  const second = run('10002');
  expect(await second).toEqual({ switched: false, reason: 'busy' });
  expect(useAccountSwitch.getState().active).toBe(true);
  expect(io.close).toHaveBeenCalledOnce();
  close.resolve(true);
  expect(await first).toEqual({ switched: true });
  expect(io.open).toHaveBeenCalledOnce();
  expect(io.open).toHaveBeenCalledWith(expect.objectContaining({ uin: '10001' }));
  expect(useViewState.getState().openedUin).toBe('10001');
  expect(useAccountSwitch.getState().active).toBe(false);
});

it('邮件确认迟到时重新检查占用，不抢另一入口已开始的切号', async () => {
  const confirm = deferred<boolean>();
  const close = deferred<boolean>();
  io.confirm.mockReturnValueOnce(confirm.promise);
  io.close.mockReturnValueOnce(close.promise);
  const waiting = run('10001');
  const active = run('10002');
  await vi.waitFor(() => expect(io.close).toHaveBeenCalledOnce());
  confirm.resolve(true);
  expect(await waiting).toEqual({ switched: false, reason: 'busy' });
  expect(useAccountSwitch.getState().active).toBe(true);
  close.resolve(true);
  expect(await active).toEqual({ switched: true });
  expect(io.open).toHaveBeenCalledOnce();
  expect(useViewState.getState().openedUin).toBe('10002');
});

it('取消邮件确认不关闭账号、不清除其他入口的过渡', async () => {
  const confirm = deferred<boolean>();
  const close = deferred<boolean>();
  io.confirm.mockReturnValueOnce(confirm.promise);
  io.close.mockReturnValueOnce(close.promise);
  const waiting = run('10001');
  const active = run('10002');
  await vi.waitFor(() => expect(io.close).toHaveBeenCalledOnce());
  confirm.resolve(false);
  expect(await waiting).toEqual({ switched: false, reason: 'cancelled' });
  expect(useAccountSwitch.getState().active).toBe(true);
  close.resolve(true);
  await active;
  expect(io.close).toHaveBeenCalledOnce();
});

it('切号失败释放占用，后续入口可以独立执行', async () => {
  const open = deferred<object>();
  io.open.mockReturnValueOnce(open.promise);
  const first = run('10001');
  await vi.waitFor(() => expect(io.open).toHaveBeenCalledOnce());
  expect(await run('10002')).toEqual({ switched: false, reason: 'busy' });
  open.reject(new Error('合成打开失败'));
  expect(await first).toEqual({ switched: false, reason: 'failed' });
  expect(useAccountSwitch.getState().active).toBe(false);
  expect(useViewState.getState().view).toBe('bootstrap');
  expect(await run('10002')).toEqual({ switched: true });
  expect(io.open).toHaveBeenCalledTimes(2);
  expect(useViewState.getState().openedUin).toBe('10002');
});
