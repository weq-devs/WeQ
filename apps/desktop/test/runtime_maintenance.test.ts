// @vitest-environment node
import { expect, it } from 'vitest';
import { RuntimeMaintenance } from '../src/main/runtime_maintenance';

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
