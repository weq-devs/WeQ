// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { RuntimeMaintenance, MAINTENANCE_DRAIN_TIMEOUT_MS } from '../src/main/runtime_maintenance';

afterEach(() => vi.useRealTimers());

it('先进入维护态、拒绝新请求，等待旧请求结束后再替换文件', async () => {
  const maintenance = new RuntimeMaintenance();
  let release!: () => void;
  const old = maintenance.operation(() => new Promise<void>((resolve) => (release = resolve)));
  let applied = false;
  const work = maintenance.run(async () => {
    applied = true;
  });
  expect(maintenance.status().state).toBe('maintenance');
  expect(applied).toBe(false);
  await expect(maintenance.operation(async () => {})).rejects.toThrow('维护中');
  await expect(maintenance.run(async () => {})).rejects.toThrow('已有维护');
  release();
  await old;
  await work;
  expect(applied).toBe(true);
  expect(maintenance.status().state).toBe('ready');
});

it('维护失败仍释放入口，不自动增加界面版本', async () => {
  const maintenance = new RuntimeMaintenance();
  await expect(
    maintenance.run(async () => {
      throw new Error('synthetic');
    }),
  ).rejects.toThrow('synthetic');
  expect(maintenance.status()).toEqual({ state: 'ready', revision: 0 });
  expect(await maintenance.operation(async () => 1)).toBe(1);
});

it('旧请求长期不返回时有界退出，列明阻塞请求且不执行文件替换', async () => {
  vi.useFakeTimers();
  const maintenance = new RuntimeMaintenance();
  let release!: () => void;
  const old = maintenance.operation(
    () => new Promise<void>((resolve) => (release = resolve)),
    'account.intentSense.ensureAnalysis',
  );
  const apply = vi.fn(async () => {});
  const work = maintenance.run(apply);
  const rejected = expect(work).rejects.toThrow(
    /等待已有请求结束超时.*account\.intentSense\.ensureAnalysis.*未修改.*重试/,
  );
  await vi.advanceTimersByTimeAsync(MAINTENANCE_DRAIN_TIMEOUT_MS);
  await rejected;
  expect(apply).not.toHaveBeenCalled();
  expect(maintenance.status()).toEqual({ state: 'ready', revision: 0 });
  expect(await maintenance.operation(async () => 1)).toBe(1);
  expect(vi.getTimerCount()).toBe(0);

  // 超时不代表旧请求已取消；重试仍须等它真正结束。
  const retry = maintenance.run(apply);
  expect(apply).not.toHaveBeenCalled();
  release();
  await old;
  await retry;
  expect(apply).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it('同名请求分别计数，结束一个仍等待另一个；正常完成后清理超时器', async () => {
  vi.useFakeTimers();
  const maintenance = new RuntimeMaintenance();
  let first!: () => void;
  let second!: () => void;
  const a = maintenance.operation(
    () => new Promise<void>((resolve) => (first = resolve)),
    'same-query',
  );
  const b = maintenance.operation(
    () => new Promise<void>((resolve) => (second = resolve)),
    'same-query',
  );
  const apply = vi.fn(async () => {});
  const work = maintenance.run(apply);
  first();
  await a;
  expect(apply).not.toHaveBeenCalled();
  second();
  await b;
  await work;
  expect(apply).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(MAINTENANCE_DRAIN_TIMEOUT_MS);
  expect(maintenance.status().state).toBe('ready');
});
