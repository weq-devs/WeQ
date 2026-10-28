import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { PageSnapshots, usePageState } from '../src/renderer/src/components/PageSnapshots';
import { pageValue } from '../src/renderer/src/lib/pageSnapshots';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CleanupInstruction, CleanupTargetStat, ResourceTreeKey } from '@weq/service';
import { ResourceManagementSection } from '../src/renderer/src/components/settings/ResourceManagementSection';
import { RESOURCE_CATEGORIES } from '../src/renderer/src/views/cache/resourceManagement';
import { useViewState } from '../src/renderer/src/state/view';
import { TabActivity } from '../src/renderer/src/components/RetainedTabs';

const f = vi.hoisted(() => ({
  configId: 'synthetic',
  static: false,
  analyze: vi.fn(),
  list: vi.fn(),
  cleanup: vi.fn(),
  invalidate: vi.fn(),
  browse: vi.fn(),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    useUtils: () => ({ account: { invalidate: f.invalidate } }),
    account: {
      getAccountConfig: {
        useQuery: () => ({
          data: { uin: '10001', configId: f.configId, static: f.static },
          error: null,
        }),
      },
    },
  },
  client: {
    account: {
      mediaResource: { analyzeTree: { query: f.analyze } },
      resourceCleanup: { listTargets: { query: f.list }, cleanup: { mutate: f.cleanup } },
    },
  },
}));
vi.mock('../src/renderer/src/views/cache/CacheView', () => ({
  CacheView: ({ selection, revision }: { selection?: { category: string }; revision: number }) => {
    f.browse(selection, revision);
    const [value, setValue] = usePageState('resource-filter', '', pageValue.string);
    return h('input', {
      'aria-label': '合成资源筛选',
      value,
      onInput: (event) => setValue(event.currentTarget.value),
    });
  },
}));
const source = { expectedAccountUin: '10001', expectedAccountConfigId: 'synthetic' };
const variantTargets = new Set(['pic', 'video', 'emojiRecv', 'personalEmoji']);
const targets: CleanupTargetStat[] = RESOURCE_CATEGORIES.flatMap((category) => [
  ...category.cleanup,
]).map((id) => ({
  id,
  label: `合成目标 ${id}`,
  desc: '合成清理范围',
  path: `/synthetic/nt_data/${id}`,
  tier: ['pic', 'video', 'emojiRecv', 'personalEmoji', 'ptt', 'file'].includes(id)
    ? 'caution'
    : 'safe',
  hasVariants: variantTargets.has(id),
  present: true,
  files: variantTargets.has(id) ? 2 : 1,
  bytes: 10,
  ori: variantTargets.has(id) ? { files: 1, bytes: 8 } : { files: 0, bytes: 0 },
  thumb: variantTargets.has(id) ? { files: 1, bytes: 2 } : { files: 0, bytes: 0 },
}));
const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('localStorage', new Storage());
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  useViewState.setState({ openedUin: '10001' });
  f.configId = 'synthetic';
  f.static = false;
  f.analyze.mockReset().mockImplementation(async ({ key }: { key: ResourceTreeKey }) => ({
    key,
    present: true,
    files: 1,
    bytes: 10,
    byMonth: { '2026-10': { files: 1, bytes: 10 } },
    ori: { files: 1, bytes: 10 },
    thumb: { files: 0, bytes: 0 },
    other: { files: 0, bytes: 0 },
  }));
  f.list.mockReset().mockResolvedValue(targets);
  f.cleanup
    .mockReset()
    .mockImplementation(async ({ instructions }: { instructions: CleanupInstruction[] }) => ({
      freedBytes: instructions.length * 10,
      perTarget: instructions.map((item) => ({ ...item, freedBytes: 10, removed: 1, failed: 0 })),
    }));
  f.invalidate.mockReset().mockResolvedValue(undefined);
  f.browse.mockClear();
});
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  useViewState.setState({ openedUin: null });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = async (active = true) =>
    act(async () =>
      root.render(
        h(
          PageSnapshots,
          { scope: `10001:${f.configId}` },
          h(TabActivity, { active }, h(ResourceManagementSection)),
        ),
      ),
    );
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  await render();
  const view = async (id: string) =>
    act(async () =>
      host
        .querySelector(`[data-setting-id="${id}"]`)!
        .closest<HTMLButtonElement>('button')!
        .click(),
    );
  const button = (text: string) =>
    [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => !node.closest('[hidden],[inert]') && node.textContent?.includes(text),
    )!;
  return { host, render, view, button };
}
it('直接承载概览、清理和浏览，共享一次扫描，表情子目标不再计入总量', async () => {
  const page = await mount();
  expect(page.host.querySelector('.weq-ra-tile-value')?.textContent).toBe('80 B');
  expect(page.host.querySelector('.weq-maintenance-entry')).toBeNull();
  expect(document.querySelector('.weq-tool-modal')).toBeNull();
  expect(f.analyze).toHaveBeenCalledTimes(8);
  expect(f.list).toHaveBeenCalledOnce();
  await page.view('qq-storage-cleanup');
  const modes = [...page.host.querySelectorAll('.weq-clean-mode strong')].map(
    (node) => node.textContent,
  );
  expect(modes).toEqual([
    '完全安全清理',
    '清理原图',
    '清理缩略',
    '清理 File 目录',
    '全部清理',
    '自定义清理',
  ]);
  expect(f.analyze).toHaveBeenCalledTimes(8);
  expect(f.list).toHaveBeenCalledOnce();
  await page.view('resource-viewer');
  const input = page.host.querySelector<HTMLInputElement>('[aria-label="合成资源筛选"]')!;
  act(() => {
    input.value = '保留资源筛选';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.view('qq-storage-analysis');
  await page.view('resource-viewer');
  expect(page.host.querySelector('[aria-label="合成资源筛选"]')).not.toBe(input);
  expect(page.host.querySelector<HTMLInputElement>('[aria-label="合成资源筛选"]')!.value).toBe(
    '保留资源筛选',
  );
});
it('自定义保留全部/原图/缩略变体，确认显示真实范围，返回视图保留选择', async () => {
  const page = await mount();
  await page.view('qq-storage-cleanup');
  await act(async () => page.button('自定义清理').click());
  const pic = [...page.host.querySelectorAll<HTMLButtonElement>('.weq-clean-target-main')].find(
    (node) => node.textContent?.includes('合成目标 pic'),
  )!;
  await act(async () => pic.click());
  expect(
    [...page.host.querySelectorAll('.weq-clean-variants button')].map((node) =>
      node.textContent?.slice(0, 2),
    ),
  ).toEqual(['全部', '仅原', '仅缩']);
  await act(async () => page.button('仅缩略').click());
  await page.view('qq-storage-analysis');
  await page.view('qq-storage-cleanup');
  expect(page.host.querySelector('.weq-clean-target.is-on')?.textContent).toContain('合成目标 pic');
  await act(async () => page.button('清理所选').click());
  expect(page.host.querySelector('.weq-clean-review')?.textContent).toContain(
    '/synthetic/nt_data/pic',
  );
  expect(page.host.querySelector('.weq-clean-review-variant')?.textContent).toBe('仅缩略');
  expect(f.cleanup).not.toHaveBeenCalled();
});
it('全部清理仍需确认短语，只提交一次白名单 ID，完成后共享重扫并列出逐项结果', async () => {
  const page = await mount();
  await page.view('qq-storage-cleanup');
  await act(async () => page.button('全部清理').click());
  let run = page.host.querySelector<HTMLButtonElement>('.weq-clean-confirm-foot .weq-clean-go')!;
  expect(run.disabled).toBe(true);
  const phrase = page.host.querySelector<HTMLInputElement>('.weq-clean-phrase input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      phrase,
      '确认清理',
    );
    phrase.dispatchEvent(new Event('input', { bubbles: true }));
  });
  run = page.host.querySelector<HTMLButtonElement>('.weq-clean-confirm-foot .weq-clean-go')!;
  await act(async () => {
    run.click();
    run.click();
  });
  expect(f.cleanup).toHaveBeenCalledOnce();
  expect(f.cleanup).toHaveBeenCalledWith({
    ...source,
    instructions: targets.map((target) => ({ id: target.id, variant: 'all' })),
  });
  expect(f.analyze).toHaveBeenCalledTimes(16);
  expect(f.list).toHaveBeenCalledTimes(2);
  expect(page.host.querySelectorAll('.weq-clean-done .weq-clean-review-row')).toHaveLength(11);
  expect(page.host.querySelector('.weq-clean-done-title')?.textContent).toContain('逻辑文件量');
});
it('静态账号不挂载任何扫描或清理能力', async () => {
  f.static = true;
  const page = await mount();
  expect(page.host.textContent).toContain('静态账号不提供');
  expect(f.analyze).not.toHaveBeenCalled();
  expect(f.list).not.toHaveBeenCalled();
  expect(f.cleanup).not.toHaveBeenCalled();
});
