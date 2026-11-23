import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  mobileMorePageLoaders,
  preloadWorkspace,
} from '../src/renderer/src/components/lazyWorkspaces.shared';
import {
  QzoneWorkspace,
  SettingsDialog,
  CollectionDialog,
} from '../src/renderer/src/components/lazyWorkspaces';
import { preloadMobilePages } from '../src/renderer/src/lib/mobilePageLoading';

const fixture = vi.hoisted(() => ({
  loads: [] as string[],
  pending: Promise.resolve(),
  render: vi.fn(() => null),
}));
vi.mock('../src/renderer/src/views/QzoneView', async () => {
  fixture.loads.push('qzone');
  await fixture.pending;
  return { QzoneWorkspace: fixture.render };
});
vi.mock('../src/renderer/src/views/ExportView', () => {
  fixture.loads.push('export');
  return { ExportTool: fixture.render };
});
vi.mock('../src/renderer/src/components/GuildDirectDialog', () => {
  fixture.loads.push('guild-direct');
  return { GuildDirectDialog: fixture.render };
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  vi.stubGlobal('requestIdleCallback', undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('更多只预热空间、设置和收藏，不遍历重工具表', () => {
  expect(mobileMorePageLoaders).toEqual([
    QzoneWorkspace.preload,
    SettingsDialog.preload,
    CollectionDialog.preload,
  ]);
});

it('用户实际导航意图绕过慢后台模块，预热不挂载页面或启动组件查询', async () => {
  let release!: () => void;
  fixture.pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stop = preloadMobilePages(mobileMorePageLoaders);
  try {
    await vi.advanceTimersByTimeAsync(80);
    expect(fixture.loads).toEqual(['qzone']);
    preloadWorkspace('export');
    await vi.waitFor(() => expect(fixture.loads).toEqual(['qzone', 'export']));
    preloadWorkspace('guild-direct');
    await vi.waitFor(() => expect(fixture.loads).toEqual(['qzone', 'export', 'guild-direct']));
    expect(fixture.render).not.toHaveBeenCalled();
  } finally {
    release();
    stop();
    await vi.runAllTimersAsync();
  }
});
