import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StartupProgressReporter } from '../src/renderer/src/components/StartupProgressReporter';
import {
  STARTUP_STAGES,
  startupPercent,
  advanceStartup,
  useStartupProgress,
} from '../src/renderer/src/state/startupProgress';
import { useViewState } from '../src/renderer/src/state/view';

let frames: Map<number, FrameRequestCallback>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  frames = new Map();
  let next = 0;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.set(++next, callback);
    return next;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    frames.delete(id);
  });
  useStartupProgress.setState({
    active: true,
    stage: 'resources',
    percent: STARTUP_STAGES.resources.percent,
  });
  useViewState.setState({ view: 'main', homeStage: 'home' });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function frame() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
  });
}

it('所有启动步骤都有固定区间，真实任务按阶段内比例推进且不提前到 100%', () => {
  for (const [name, stage] of Object.entries(STARTUP_STAGES)) {
    expect(startupPercent(name as keyof typeof STARTUP_STAGES)).toBe(stage.percent);
    expect(startupPercent(name as keyof typeof STARTUP_STAGES, 1)).toBe(stage.end);
  }
  expect(startupPercent('identity', 0.5)).toBe(68);
  expect(startupPercent('identity', Infinity)).toBe(STARTUP_STAGES.identity.percent);
  expect(startupPercent('painting', 1)).toBeLessThan(STARTUP_STAGES.ready.percent);
  advanceStartup('identity', 1);
  expect(useStartupProgress.getState().percent).toBe(STARTUP_STAGES.workspace.percent);
  advanceStartup('restore');
  advanceStartup('identity', 0.3);
  expect(useStartupProgress.getState().percent).toBe(STARTUP_STAGES.workspace.percent);
});

it('无自动进入或失败回到账号页时，同样等真实页面绘制才结束进度', async () => {
  useViewState.setState({ view: 'bootstrap', homeStage: 'home' });
  const host = document.createElement('div');
  host.id = 'root';
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(h(StartupProgressReporter)));
    await frame();
    await frame();
    expect(useStartupProgress.getState().percent).toBeLessThan(100);
    const surface = document.createElement('main');
    surface.dataset.weqStartupSurface = '';
    host.append(surface);
    await frame();
    await frame();
    expect(useStartupProgress.getState().percent).toBe(100);
    await frame();
    await frame();
    expect(useStartupProgress.getState().active).toBe(false);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('整页懒加载仍停在工作区区间，实际界面绘制后才到 100%，业务占位不阻塞完成', async () => {
  const host = document.createElement('div');
  host.id = 'root';
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        h(
          'div',
          null,
          h('section', { 'data-weq-startup-page': true }, '模块加载中'),
          h(StartupProgressReporter),
        ),
      ),
    );
    await frame();
    await frame();
    expect(useStartupProgress.getState().percent).toBe(STARTUP_STAGES.workspace.percent);
    const pending = host.querySelector('section')!;
    await act(async () => {
      pending.removeAttribute('data-weq-startup-page');
      pending.className = 'app-shell-root';
      pending.setAttribute('data-weq-startup-pending', '');
      pending.textContent = '会话列表后台读取中';
      await Promise.resolve();
    });
    expect(useStartupProgress.getState().percent).toBe(STARTUP_STAGES.painting.percent);
    await frame();
    expect(useStartupProgress.getState().percent).toBeLessThan(100);
    await frame();
    expect(useStartupProgress.getState().percent).toBe(100);
    expect(useStartupProgress.getState().active).toBe(true);
    await frame();
    await frame();
    expect(useStartupProgress.getState().active).toBe(false);
    expect(host.querySelector('[role="progressbar"]')).toBeNull();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
