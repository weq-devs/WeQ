import { afterEach, expect, it, vi } from 'vitest';
import { runRemoteIdentityWarmup } from '../src/renderer/src/lib/accountWarmup';

afterEach(() => vi.useRealTimers());

function fixture() {
  const profile = vi.fn(async () => ({ uid: 'u_fixture', uin: '10001', nick: '正式昵称' }));
  const status = vi.fn(async () => ({ uid: 'u_fixture', typeName: '在线' }));
  const progress = vi.fn();
  const utils = {
    account: { getSelfProfile: { fetch: profile }, getOnlineStatus: { fetch: status } },
  };
  return {
    profile,
    status,
    progress,
    utils: utils as unknown as Parameters<typeof runRemoteIdentityWarmup>[0],
  };
}

it('先读取正式资料，再按资料 uid 预载同一查询键的状态，不沿用旧缓存', async () => {
  const f = fixture();
  await runRemoteIdentityWarmup(f.utils, f.progress);
  expect(f.profile).toHaveBeenCalledWith(undefined, { staleTime: 0 });
  expect(f.status).toHaveBeenCalledWith({ uid: 'u_fixture' }, { staleTime: 0 });
  expect(f.profile.mock.invocationCallOrder[0]).toBeLessThan(f.status.mock.invocationCallOrder[0]!);
  expect(f.progress).toHaveBeenLastCalledWith({ done: 1, total: 1, pending: null });
});

it('昵称已到但在线状态未到时，身份预载仍未完成', async () => {
  const f = fixture();
  let finish!: (value: { uid: string; typeName: string }) => void;
  f.status.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const ready = vi.fn();
  const warmup = runRemoteIdentityWarmup(f.utils, f.progress).then(ready);
  await vi.waitFor(() => expect(f.status).toHaveBeenCalledOnce());
  expect(ready).not.toHaveBeenCalled();
  finish({ uid: 'u_fixture', typeName: '在线' });
  await warmup;
  expect(ready).toHaveBeenCalledOnce();
});

it('资料没有 uid 时不发空状态查询', async () => {
  const f = fixture();
  f.profile.mockResolvedValueOnce({ uid: '', uin: '10001', nick: '静态账号' });
  await runRemoteIdentityWarmup(f.utils, f.progress);
  expect(f.status).not.toHaveBeenCalled();
});

it('资料读取失败不会阻塞进入，也不查询其他身份的状态', async () => {
  const f = fixture();
  f.profile.mockRejectedValueOnce(new Error('合成读取失败'));
  await expect(runRemoteIdentityWarmup(f.utils, f.progress)).resolves.toBeUndefined();
  expect(f.status).not.toHaveBeenCalled();
});

it('异常慢查询沿用有界等待，不把 Remote 永久卡在载入页', async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.profile.mockImplementationOnce(() => new Promise(() => {}));
  const ready = vi.fn();
  const warmup = runRemoteIdentityWarmup(f.utils, f.progress, 1000).then(ready);
  await vi.advanceTimersByTimeAsync(999);
  expect(ready).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await warmup;
  expect(ready).toHaveBeenCalledOnce();
  expect(f.status).not.toHaveBeenCalled();
});
