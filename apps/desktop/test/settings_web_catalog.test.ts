// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});
it.each(['web', 'electron'])(
  '%s 仅收录可展示的菜单截图偏好，普通隐私设置仍可搜索',
  async (target) => {
    vi.stubEnv('VITE_WEQ_TARGET', target);
    vi.resetModules();
    const { searchAppEntries } = await import(
      '../src/renderer/src/components/search/appSearchCatalog'
    );
    const captures = searchAppEntries('截图隐私').filter(
      (entry) =>
        entry.target.kind === 'setting' && entry.target.settingId === 'privacy-menu-capture',
    );
    expect(captures).toHaveLength(target === 'web' ? 0 : 1);
    expect(
      searchAppEntries('隐私模式').some(
        (entry) => entry.target.kind === 'setting' && entry.target.settingId === 'privacy-mode',
      ),
    ).toBe(true);
  },
);
