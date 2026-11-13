import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RecognitionSettingsSection } from '../src/renderer/src/components/settings/RecognitionSettingsSection';
import { EnhancementPacksSection } from '../src/renderer/src/components/settings/EnhancementPacksSection';
import { SettingsNavigateContext } from '../src/renderer/src/components/settings/controls';
import { TabActivity } from '../src/renderer/src/components/RetainedTabs';
import { useAppUpdate } from '../src/renderer/src/hooks/useAppUpdate';
import { useDialog } from '../src/renderer/src/components/Dialog';

type Progress = { kind?: string };
const fixture = vi.hoisted(() => ({
  listeners: new Map<string, { path: string; onData: (value: Progress) => void }>(),
  enabled: new Map<string, boolean>(),
  refetch: vi.fn(),
  invalidate: vi.fn(),
  mutate: vi.fn(async (_input: unknown) => true),
  confirm: vi.fn(async () => true),
  ready: false,
  busy: false,
}));
vi.mock('../src/renderer/src/lib/dialogUtils', () => ({
  useAppDialog: () => ({ confirm: fixture.confirm }),
}));
vi.mock('../src/renderer/src/trpc/client', () => {
  const proxy = (path: string[] = []): unknown =>
    new Proxy(() => proxy(path), {
      get: (_target, key) => {
        if (key === 'useUtils') return () => proxy();
        if (key === 'useQuery')
          return (_input: unknown, options: { enabled?: boolean }) => {
            const name = path.at(-1)!;
            fixture.enabled.set(name, options?.enabled !== false);
            const packs = (['text', 'voice', 'intent', 'dress'] as const).map((id, index) => ({
              id,
              name: ['本地文字识别', '本地语音转写', '本地意图与画像', '装扮离线索引'][index],
              description: '合成能力资源',
              ready: fixture.ready,
              downloaded: fixture.ready,
              busy: fixture.busy,
              pausable: id !== 'dress',
              installed: fixture.ready,
              blocker: null,
              downloadBytes: fixture.ready ? 0 : 1048576,
              sizeOnDisk: fixture.ready ? 1048576 : 0,
              sharedBytes: 0,
              deleteBytes: fixture.ready ? 1048576 : 0,
              operation: fixture.busy
                ? { phase: 'downloading', total: 1048576, received: 524288 }
                : null,
            }));
            return {
              data:
                name === 'enhancementPacks'
                  ? { packs, all: { downloadBytes: 4194304, sizeOnDisk: 0 } }
                  : name === 'enhancementPlan'
                    ? { downloadBytes: 4194304, sizeOnDisk: 0 }
                    : name === 'getVersionInfo'
                      ? { app: '1.0.0', isDev: false }
                      : name === 'getSettings'
                        ? {
                            ocr: { prefilterEnabled: true, onlineConcurrency: 5 },
                            voiceTranscribe: { onlineConcurrency: 5 },
                          }
                        : { current: '1.0.0', hasUpdate: true, latest: '2.0.0' },
              isLoading: false,
              isFetching: false,
              refetch: fixture.refetch,
            };
          };
        if (key === 'useMutation') return () => ({ mutateAsync: fixture.mutate, isLoading: false });
        if (key === 'invalidate') return () => fixture.invalidate(path.join('.'));
        if (key === 'subscribe')
          return (_input: unknown, options: { onData: (value: Progress) => void }) => {
            const id = path.join('.') + ':' + fixture.listeners.size;
            fixture.listeners.set(id, { path: path.join('.'), onData: options.onData });
            return { unsubscribe: () => fixture.listeners.delete(id) };
          };
        return proxy([...path, String(key)]);
      },
    });
  return { trpc: proxy(), client: proxy() };
});
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.listeners.clear();
  fixture.enabled.clear();
  fixture.refetch.mockClear();
  fixture.invalidate.mockClear();
  fixture.mutate.mockClear();
  fixture.confirm.mockReset().mockResolvedValue(true);
  fixture.ready = false;
  fixture.busy = false;
});
afterEach(() => {
  useDialog.setState({ current: null });
  vi.unstubAllGlobals();
});
function mount(content: Parameters<ReturnType<typeof createRoot>['render']>[0]) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = (active = true) => act(() => root.render(h(TabActivity, { active }, content)));
  render();
  return {
    host,
    render,
    dispose: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}
describe('增强设置与非活动页面资源', () => {
  it('识别与转写仅保留两类并发及筛图偏好，不提供本地资源链接或下载管理', () => {
    const navigate = vi.fn();
    const f = mount(
      h(SettingsNavigateContext.Provider, { value: navigate }, h(RecognitionSettingsSection)),
    );
    try {
      expect(f.host.querySelectorAll('input[type="number"]')).toHaveLength(2);
      expect(f.host.querySelector('[aria-label="OCR 前先筛图"]')).not.toBeNull();
      expect(f.host.textContent).not.toContain('下载模型');
      expect(
        [...f.host.querySelectorAll('button')].some((node) => node.textContent === '增强包'),
      ).toBe(false);
      expect(navigate).not.toHaveBeenCalled();
    } finally {
      f.dispose();
    }
  });
  it('管理页复用四张设置卡片，只有下载全部和各卡片的独立操作', async () => {
    const f = mount(h(EnhancementPacksSection));
    try {
      expect(f.host.querySelector('input[type="checkbox"]')).toBeNull();
      expect(f.host.querySelector('[role="checkbox"]')).toBeNull();
      expect(f.host.querySelectorAll('.weq-set-card')).toHaveLength(4);
      const all = [...f.host.querySelectorAll('button')].find((node) =>
        node.textContent?.startsWith('下载全部'),
      )!;
      await act(async () => all.click());
      expect(fixture.mutate).toHaveBeenCalledWith({ ids: ['text', 'voice', 'intent', 'dress'] });
      const chosen = f.host.querySelector<HTMLButtonElement>('[aria-label="下载本地文字识别"]')!;
      await act(async () => chosen.click());
      expect(fixture.mutate).toHaveBeenLastCalledWith({ ids: ['text'] });
      expect(f.host.querySelector('progress')).toBeNull();
    } finally {
      f.dispose();
    }
  });
  it('非活动管理页停止轮询，回来从宿主状态恢复进度；不订阅遗留下载流', () => {
    fixture.busy = true;
    const f = mount(h(EnhancementPacksSection));
    try {
      expect(f.host.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe(
        '50',
      );
      expect(fixture.listeners.size).toBe(0);
      f.render(false);
      expect(fixture.enabled.get('enhancementPacks')).toBe(false);
      fixture.busy = false;
      fixture.ready = true;
      f.render(true);
      expect(f.host.querySelector('[role="progressbar"]')).toBeNull();
      expect(f.host.textContent).toContain('删除 1.00 MiB');
      expect(f.host.querySelectorAll('button[aria-label^="删除"]')).toHaveLength(4);
    } finally {
      f.dispose();
    }
  });
  it('删除增强包先确认，取消不删除，确认后仅移除选定能力', async () => {
    fixture.ready = true;
    const f = mount(h(EnhancementPacksSection));
    try {
      const remove = f.host.querySelector<HTMLButtonElement>('[aria-label="删除本地文字识别"]')!;
      fixture.confirm.mockResolvedValueOnce(false);
      await act(async () => remove.click());
      expect(fixture.mutate).not.toHaveBeenCalled();
      expect(fixture.confirm).toHaveBeenCalledWith(
        '删除本地文字识别？',
        expect.stringContaining('1.00 MiB'),
        { okLabel: '删除', cancelLabel: '取消', tone: 'warning' },
      );
      await act(async () => remove.click());
      expect(fixture.mutate).toHaveBeenCalledWith({ id: 'text' });
    } finally {
      f.dispose();
    }
  });
  it('普通更新观察随页面暂停，但已启动下载持续接收终态，结束后释放订阅', async () => {
    let update!: ReturnType<typeof useAppUpdate>;
    function Reader() {
      update = useAppUpdate();
      return h('span', null, update.phase);
    }
    const f = mount(h(Reader));
    try {
      expect(update.phase).toBe('available');
      expect(fixture.listeners.size).toBe(2);
      f.render(false);
      expect(fixture.listeners.size).toBe(0);
      expect(Object.fromEntries(fixture.enabled)).toEqual({
        getVersionInfo: false,
        getState: false,
        getInterval: false,
        getPrerelease: false,
      });
      f.render(true);
      await act(async () => update.download());
      expect(update.phase).toBe('downloading');
      f.render(false);
      expect(fixture.listeners.size).toBe(2);
      expect([...fixture.enabled.values()]).toEqual([false, false, false, false]);
      const event = [...fixture.listeners.values()].find((listener) =>
        listener.path.endsWith('onEvent'),
      )!;
      act(() => event.onData({ kind: 'downloaded' }));
      expect(update.phase).toBe('downloaded');
      expect(fixture.listeners.size).toBe(0);
      f.render(true);
      expect(update.phase).toBe('downloaded');
    } finally {
      f.dispose();
    }
  });
});
