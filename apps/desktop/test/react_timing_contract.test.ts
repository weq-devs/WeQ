import { afterEach, expect, it, vi } from 'vitest';
import { REACT_COMPONENT_MEASURE_PREFIX } from '../src/renderer/src/lib/developmentTiming';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('实际安装的 React 开发构建生成可识别的组件性能条目', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('console', Object.assign(Object.create(console), { timeStamp: () => {} }));
  const measure = vi.spyOn(performance, 'measure');
  const { act, createElement: h, Profiler } = await import('react');
  const { createRoot } = await import('react-dom/client');
  function ActualTimingContract({ value }: { value: string }) {
    return h('span', null, value);
  }
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const render = (value: string) =>
    act(async () =>
      root.render(
        h(
          Profiler,
          { id: 'timing-contract', onRender: () => {} },
          h(ActualTimingContract, { value }),
        ),
      ),
    );
  try {
    await render('before');
    await render('after');
    const component = measure.mock.calls.find(([name]) => name.endsWith('ActualTimingContract'));
    expect(component).toBeDefined();
    expect(component![0].startsWith(REACT_COMPONENT_MEASURE_PREFIX)).toBe(true);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    for (const [name] of measure.mock.calls) performance.clearMeasures(name);
  }
});
