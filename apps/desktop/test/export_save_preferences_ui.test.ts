import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GlobalSettingsSection } from '../src/renderer/src/components/settings/GlobalSettingsSection';
import type { ExportSavePolicy } from '@weq/service';

const state = vi.hoisted(() => ({
  settings: {
    exportSaveMode: 'before' as ExportSavePolicy['mode'],
    defaultExportDir: null as string | null,
  },
  pick: vi.fn(async (): Promise<string | null> => null),
  setMode: vi.fn(async (_input: { mode: ExportSavePolicy['mode'] }) => {}),
}));
vi.mock('../src/renderer/src/components/Dialog', () => ({ useDialog: () => vi.fn() }));
vi.mock('../src/renderer/src/trpc/client', () => {
  function proxy(path = ''): unknown {
    return new Proxy(() => {}, {
      get(_target, key) {
        if (key === 'useQuery')
          return () => ({
            data:
              path === 'bootstrap.getSettings'
                ? state.settings
                : path === 'bootstrap.storageCleanupResult'
                  ? null
                  : [],
            isLoading: false,
            refetch: async () => {},
          });
        if (key === 'useMutation')
          return () => ({
            isLoading: false,
            mutateAsync:
              path === 'bootstrap.pickDefaultExportDir'
                ? state.pick
                : path === 'bootstrap.setExportSaveMode'
                  ? state.setMode
                  : async () => {},
          });
        return proxy(path ? `${path}.${String(key)}` : String(key));
      },
    });
  }
  return { trpc: proxy() };
});
const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.settings = { exportSaveMode: 'before', defaultExportDir: null };
  state.pick.mockReset().mockResolvedValue(null);
  state.setMode.mockClear();
});
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  vi.unstubAllGlobals();
});
function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = () => act(() => root.render(h(GlobalSettingsSection, { section: 'storage' })));
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  render();
  return { host, render };
}
describe('存储管理仅负责清理', () => {
  it.each(['before', 'preset'] as const)('已有 %s 保存偏好不显示配置，也不改写设置', (mode) => {
    state.settings.exportSaveMode = mode;
    state.settings.defaultExportDir = '/chosen/default';
    const f = mount();
    expect(f.host.textContent).toContain('空间清理');
    for (const label of ['默认保存目录', '默认保存方式', '缓存目录', '选择目录', '重置默认'])
      expect(f.host.textContent).not.toContain(label);
    expect(f.host.querySelector('[aria-label="默认导出保存方式"]')).toBeNull();
    expect(state.pick).not.toHaveBeenCalled();
    expect(state.setMode).not.toHaveBeenCalled();
    expect(state.settings.exportSaveMode).toBe(mode);
    expect(state.settings.defaultExportDir).toBe('/chosen/default');
  });
});
