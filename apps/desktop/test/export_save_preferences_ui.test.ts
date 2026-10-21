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
            data: path === 'bootstrap.getSettings' ? state.settings : [],
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
  const render = () => act(() => root.render(h(GlobalSettingsSection, { section: 'saving' })));
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  render();
  const select = () => host.querySelector<HTMLSelectElement>('[aria-label="默认导出保存方式"]')!;
  return { host, render, select };
}
async function change(select: HTMLSelectElement, mode: string) {
  await act(async () => {
    select.value = mode;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
describe('默认保存偏好', () => {
  it('常用模式只有询问与默认文件夹，旧完成后选择只在当前旧偏好时展示', () => {
    const f = mount();
    expect([...f.select().options].map((option) => option.value)).toEqual(['before', 'preset']);
    state.settings.exportSaveMode = 'after';
    f.render();
    expect(f.select().value).toBe('after');
    expect([...f.select().options].map((option) => option.value)).toEqual([
      'before',
      'preset',
      'after',
    ]);
  });
  it('没有默认文件夹时先选择，取消不启用自动保存', async () => {
    const f = mount();
    await change(f.select(), 'preset');
    expect(state.pick).toHaveBeenCalledOnce();
    expect(state.setMode).not.toHaveBeenCalled();
    expect(state.settings.exportSaveMode).toBe('before');
  });
  it('已有默认文件夹不重新弹框，切换模式不修改文件夹', async () => {
    state.settings.defaultExportDir = '/chosen/default';
    const f = mount();
    await change(f.select(), 'preset');
    expect(state.pick).not.toHaveBeenCalled();
    expect(state.setMode).toHaveBeenCalledWith({ mode: 'preset' });
    expect(state.settings.defaultExportDir).toBe('/chosen/default');
  });
});
