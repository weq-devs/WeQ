import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceTranscribeSection } from '../src/renderer/src/components/settings/VoiceTranscribeSection';
import { OcrModelsSection } from '../src/renderer/src/components/settings/OcrModelsSection';
import { TabActivity } from '../src/renderer/src/components/RetainedTabs';
import { useAppUpdate } from '../src/renderer/src/hooks/useAppUpdate';
import { useDialog } from '../src/renderer/src/components/Dialog';

type Progress = {
  id?: string;
  percent?: number;
  downloadedBytes?: number;
  totalBytes?: number;
  speed?: number;
  done?: boolean;
  error?: string;
  kind?: string;
};
const fixture = vi.hoisted(() => ({
  listeners: new Map<string, { path: string; onData: (value: Progress) => void }>(),
  enabled: new Map<string, boolean>(),
  refetch: vi.fn(),
  mutate: vi.fn(async () => true),
  downloaded: false,
  downloading: true,
}));
vi.mock('../src/renderer/src/trpc/client', () => {
  const proxy = (path: string[] = []): unknown =>
    new Proxy(() => proxy(path), {
      get: (_target, key) => {
        if (key === 'useQuery')
          return (_input: unknown, options: { enabled?: boolean }) => {
            const name = path.at(-1)!;
            fixture.enabled.set(name, options?.enabled !== false);
            const model = {
              name: '合成离线模型',
              desc: '合成数据',
              sizeLabel: '1 MB',
              sizeOnDisk: 0,
              recommended: false,
              downloaded: fixture.downloaded,
              downloading: fixture.downloading,
            };
            return {
              data:
                name === 'localModelResources'
                  ? {
                      selected: { voice: '', ocr: '', filter: '', intent: 'auto' },
                      voice: [{ ...model, id: 'voice-fixture' }],
                      ocr: [{ ...model, id: 'ocr-fixture', kind: 'ocr' }],
                      engineBlocker: null,
                    }
                  : name === 'getVersionInfo'
                    ? { app: '1.0.0', isDev: false }
                    : { current: '1.0.0', hasUpdate: true, latest: '2.0.0' },
              isLoading: false,
              isFetching: false,
              refetch: fixture.refetch,
            };
          };
        if (key === 'useMutation') return () => ({ mutateAsync: fixture.mutate, isLoading: false });
        if (key === 'subscribe')
          return (_input: unknown, options: { onData: (value: Progress) => void }) => {
            const id = `${path.join('.')}:${fixture.listeners.size}`;
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
  fixture.mutate.mockClear();
  fixture.downloaded = false;
  fixture.downloading = true;
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
describe('隐藏设置页的进度资源', () => {
  it.each([
    ['voice', VoiceTranscribeSection],
    ['ocr', OcrModelsSection],
  ] as const)(
    '%s 模型在失活时退订，回来按真实下载状态恢复，不保留旧进度或伪造百分比',
    (_kind, Component) => {
      const f = mount(h(Component));
      try {
        expect(f.host.textContent).toContain('下载中');
        expect(f.host.textContent).not.toContain('0%');
        const listener = [...fixture.listeners.values()][0]!;
        const id = _kind === 'voice' ? 'voice-fixture' : 'ocr-fixture';
        act(() =>
          listener.onData({ id, percent: 50, downloadedBytes: 5, totalBytes: 10, speed: 1 }),
        );
        expect(f.host.textContent).toContain('50%');
        f.render(false);
        expect(fixture.listeners.size).toBe(0);
        act(() => listener.onData({ id, error: '已失活的旧错误' }));
        expect(useDialog.getState().current).toBeNull();
        expect(fixture.refetch).not.toHaveBeenCalled();
        fixture.downloaded = true;
        fixture.downloading = false;
        f.render(true);
        expect(f.host.textContent).toContain('已下载');
        expect(f.host.textContent).not.toContain('50%');
        expect(fixture.listeners.size).toBe(1);
      } finally {
        f.dispose();
      }
      expect(fixture.listeners.size).toBe(0);
    },
  );
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
      expect([...fixture.enabled.values()]).toEqual([false, false]);
      f.render(true);
      await act(async () => update.download());
      expect(update.phase).toBe('downloading');
      f.render(false);
      expect(fixture.listeners.size).toBe(2);
      expect([...fixture.enabled.values()]).toEqual([false, false]);
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
