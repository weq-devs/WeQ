import { readFileSync } from 'node:fs';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkspaceStartupLoading } from '../src/renderer/src/components/WorkspaceStartupLoading';

afterEach(() => vi.unstubAllGlobals());

it('整页等待从首帧显示居中的启动动画，并保留启动未完成标记', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    act(() => root.render(h(WorkspaceStartupLoading)));
    const surface = host.querySelector('[data-weq-startup-pending]');
    expect(surface?.getAttribute('role')).toBe('status');
    expect(surface?.classList.contains('h-screen')).toBe(true);
    expect(surface?.querySelector('img')?.getAttribute('alt')).toBe('WeQ');
    expect(surface?.querySelector('.weq-warmup-spinner.animate-spin')).not.toBeNull();
    expect(surface?.textContent).toContain('正在加载会话界面');
  } finally {
    act(() => root.unmount());
  }
});

it('代码模块、账号配置和 Web 缓存的整页等待共用动画，不回落为左上角纯文字', () => {
  const app = readFileSync('src/renderer/src/App.tsx', 'utf8');
  const main = readFileSync('src/renderer/src/views/MainView.tsx', 'utf8');
  expect(app).toContain('fallback={<WorkspaceStartupLoading />}');
  expect(main).toContain('if (config.isLoading) return <WorkspaceStartupLoading />;');
  expect(main).toContain('fallback={<WorkspaceStartupLoading />}');
});
