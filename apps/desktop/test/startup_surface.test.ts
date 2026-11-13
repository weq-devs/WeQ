import { readFileSync } from 'node:fs';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WarmupSplash } from '../src/renderer/src/components/WarmupSplash';
import { runDesktopStartupWarmup } from '../src/renderer/src/lib/accountWarmup';
import {
  useStartupProgress,
  advanceStartup,
  STARTUP_STAGES,
} from '../src/renderer/src/state/startupProgress';

beforeEach(() => useStartupProgress.setState({ active: true, stage: 'resources', percent: 5 }));

afterEach(() => vi.unstubAllGlobals());

it('初始 HTML 自带真实 Logo 和进度轨道，不依赖 React 模块成功加载', () => {
  const html = readFileSync('src/renderer/index.html', 'utf8');
  const parsed = document.createElement('template');
  parsed.innerHTML = html;
  const root = parsed.content.querySelector('#root');
  expect(root?.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('WeQ');
  expect(readFileSync('src/renderer/src/styles/startup-progress.css', 'utf8')).toContain(
    '@resources/brand/logo.png',
  );
  expect(root?.querySelector('[role="progressbar"]')).not.toBeNull();
  expect(root?.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe(
    String(STARTUP_STAGES.resources.percent),
  );
  expect(root?.textContent).toContain('正在加载启动界面');
});

it('未知耗时也显示阶段百分比，预热结束不把局部完成冒充整体 100%', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    act(() => root.render(h(WarmupSplash, { hint: '正在打开账号' })));
    expect(host.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('5');
    act(() => advanceStartup('identity', 1));
    act(() => root.render(h(WarmupSplash, { progress: { done: 1, total: 1, pending: null } })));
    expect(host.textContent).toContain('正在准备会话界面');
    expect(host.textContent).toContain('80%');
    expect(host.textContent).not.toContain('100%');
    expect(host.querySelector('[role="progressbar"]')).not.toBeNull();
  } finally {
    act(() => root.unmount());
  }
});

it('冷启动只等账号身份，不启动全量目录预热', async () => {
  const fetch = vi.fn(async () => ({}));
  const utils = { account: { getSelfProfile: { fetch } } };
  const progress = vi.fn();
  await runDesktopStartupWarmup(utils as Parameters<typeof runDesktopStartupWarmup>[0], progress);
  expect(fetch).toHaveBeenCalledOnce();
  expect(progress).toHaveBeenLastCalledWith({ done: 1, total: 1, pending: null });
});
