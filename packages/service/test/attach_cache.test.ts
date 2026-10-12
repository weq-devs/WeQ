import { describe, expect, it, vi } from 'vitest';
import { createCachedAttachHook } from '../src/bootstrap/attach';

const material = { a2: 'aa', d2: 'bb', d2Key: 'cc'.repeat(16) };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('account and generation scoped attach cache', () => {
  it('coalesces a simultaneous read of the same account and process', async () => {
    const read = vi.fn(async () => material);
    const hook = createCachedAttachHook(read);
    expect(await Promise.all([hook.ensure(42, '10001'), hook.attach(42, '10001')])).toEqual([
      material,
      material,
    ]);
    expect(await hook.ensure(42, '10001')).toBe(material);
    expect(read).toHaveBeenCalledOnce();
  });
  it('does not reuse one account material for another account on the same PID', async () => {
    const read = vi.fn(async (_pid, uin) => ({ ...material, a2: uin }));
    const hook = createCachedAttachHook(read);
    expect((await hook.ensure(42, '10001')).a2).toBe('10001');
    expect((await hook.ensure(42, '10002')).a2).toBe('10002');
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('rejects a late result after reset and waits before reading the next generation', async () => {
    const old = deferred<typeof material>();
    const read = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce({ ...material, a2: 'dd' });
    const hook = createCachedAttachHook(read);
    const first = hook.ensure(42, '10001').catch((error) => error);
    await Promise.resolve();
    hook.reset(42);
    const next = hook.ensure(42, '10001');
    await Promise.resolve();
    expect(read).toHaveBeenCalledOnce();
    old.resolve(material);
    expect(await first).toBeInstanceOf(Error);
    expect((await next).a2).toBe('dd');
    expect((await hook.ensure(42, '10001')).a2).toBe('dd');
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('serializes different-account scans of one PID without opening concurrent workers', async () => {
    const old = deferred<typeof material>();
    const read = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce({ ...material, a2: 'dd' });
    const hook = createCachedAttachHook(read);
    const first = hook.ensure(42, '10001');
    const second = hook.ensure(42, '10002');
    await Promise.resolve();
    expect(read).toHaveBeenCalledOnce();
    old.resolve(material);
    await first;
    expect((await second).a2).toBe('dd');
    expect(read).toHaveBeenCalledTimes(2);
  });
});
