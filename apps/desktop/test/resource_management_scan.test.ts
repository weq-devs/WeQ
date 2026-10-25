import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ResourceStat, ResourceTreeKey } from '@weq/service';
import { useResourceManagementScan } from '../src/renderer/src/views/cache/useResourceManagementScan';
import {
  RESOURCE_CATEGORIES,
  type ResourceSource,
} from '../src/renderer/src/views/cache/resourceManagement';

const f = vi.hoisted(() => ({ analyze: vi.fn(), targets: vi.fn() }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    account: {
      mediaResource: { analyzeTree: { query: f.analyze } },
      resourceCleanup: { listTargets: { query: f.targets } },
    },
  },
}));
const source = { expectedAccountUin: '10001', expectedAccountConfigId: 'synthetic-source' };
function stat(key: ResourceTreeKey): ResourceStat {
  return {
    key,
    present: true,
    files: 1,
    bytes: 10,
    byMonth: { '2026-10': { files: 1, bytes: 10 } },
    ori: { files: 0, bytes: 0 },
    thumb: { files: 0, bytes: 0 },
    other: { files: 1, bytes: 10 },
  };
}
const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  f.analyze.mockReset().mockImplementation(async ({ key }: { key: ResourceTreeKey }) => stat(key));
  f.targets.mockReset().mockResolvedValue([]);
});
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  vi.unstubAllGlobals();
});
async function mount() {
  const host = document.createElement('div'),
    root = createRoot(host);
  let value: ReturnType<typeof useResourceManagementScan>;
  function Probe({ enabled, binding }: { enabled: boolean; binding: ResourceSource }) {
    value = useResourceManagementScan(binding, enabled);
    return h('span', null, value?.stats.length);
  }
  const render = async (enabled = true, binding = source) =>
    act(async () => root.render(h(Probe, { enabled, binding })));
  cleanups.push(() => act(() => root.unmount()));
  await render();
  return { render, current: () => value! };
}
it('统一顺序扫描八个顶层目录后读取一次清理目标，每次调用都绑定来源', async () => {
  const page = await mount();
  expect(page.current().complete).toBe(true);
  expect(page.current().stats).toHaveLength(8);
  expect(f.analyze.mock.calls.map(([input]) => input.key)).toEqual(
    RESOURCE_CATEGORIES.map((category) => category.key),
  );
  for (const [input] of f.analyze.mock.calls) expect(input).toMatchObject(source);
  expect(f.targets).toHaveBeenCalledOnce();
  expect(f.targets).toHaveBeenCalledWith(source);
  await page.render();
  expect(f.analyze).toHaveBeenCalledTimes(8);
});
it('隐藏时丢弃迟到统计并停止后续请求，重新激活后完成统一扫描', async () => {
  let finish!: (value: ResourceStat) => void;
  f.analyze.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const page = await mount();
  await page.render(false);
  await act(async () => finish(stat('pic')));
  expect(page.current().stats).toHaveLength(0);
  expect(f.analyze).toHaveBeenCalledOnce();
  expect(f.targets).not.toHaveBeenCalled();
  await page.render();
  expect(page.current().complete).toBe(true);
  expect(f.analyze).toHaveBeenCalledTimes(9);
});
it('同号换源后旧统计及旧刷新回调都不能影响新来源', async () => {
  let finish!: (value: ResourceStat) => void;
  f.analyze.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const page = await mount(),
    oldRefresh = page.current().refresh;
  const next = { ...source, expectedAccountConfigId: 'synthetic-next' };
  await page.render(true, next);
  const count = f.analyze.mock.calls.length;
  await act(async () => {
    finish(stat('pic'));
    await oldRefresh();
  });
  expect(page.current().source).toEqual(next);
  expect(page.current().stats).toHaveLength(8);
  expect(f.analyze).toHaveBeenCalledTimes(count);
  expect(f.targets).toHaveBeenCalledWith(next);
});
it('错误不会自动循环扫描，显式重试和隐藏期间的刷新各只发起一轮', async () => {
  f.analyze.mockRejectedValueOnce(new Error('合成目录失败'));
  const page = await mount();
  expect(page.current().error).toBe('合成目录失败');
  expect(page.current().complete).toBe(false);
  expect(f.targets).not.toHaveBeenCalled();
  await page.render();
  expect(f.analyze).toHaveBeenCalledOnce();
  await act(async () => page.current().refresh());
  expect(page.current().revision).toBe(1);
  await page.render(false);
  const calls = f.analyze.mock.calls.length;
  await act(async () => page.current().refresh());
  expect(f.analyze).toHaveBeenCalledTimes(calls);
  await page.render();
  expect(page.current().revision).toBe(2);
  expect(f.analyze).toHaveBeenCalledTimes(calls + 8);
});
it('返回的目录身份与请求不符时停止扫描，不启用清理目标', async () => {
  f.analyze.mockResolvedValueOnce(stat('file'));
  const page = await mount();
  expect(page.current().error).toContain('目录与请求不符');
  expect(page.current().complete).toBe(false);
  expect(page.current().stats).toHaveLength(0);
  expect(f.analyze).toHaveBeenCalledOnce();
  expect(f.targets).not.toHaveBeenCalled();
});
