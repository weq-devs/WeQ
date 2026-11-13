import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Simulation } from 'd3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphCanvas } from '../src/renderer/src/components/relationGraph/GraphCanvas';
import {
  createGraphSimulation,
  fitGraphView,
} from '../src/renderer/src/components/relationGraph/graphLayout';
import type { BuiltGraph, GNode } from '../src/renderer/src/components/relationGraph/types';

vi.mock('../src/renderer/src/components/relationGraph/graphLayout', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../src/renderer/src/components/relationGraph/graphLayout')
    >();
  return {
    ...actual,
    createGraphSimulation: vi.fn((...args: Parameters<typeof actual.createGraphSimulation>) =>
      actual.createGraphSimulation(...args).stop(),
    ),
    fitGraphView: vi.fn(actual.fitGraphView),
  };
});

vi.mock('../src/renderer/src/components/relationGraph/graphSimulationClient', () => ({
  createGraphSimulationClient: (
    graph: BuiltGraph,
    previous: GNode[],
    onFrame: (ended: boolean) => void,
  ) => {
    const sim = createGraphSimulation(graph, previous);
    sim.on('tick', () => onFrame(false));
    sim.on('end', () => onFrame(true));
    return {
      nodes: () => sim.nodes(),
      stop: () => sim.stop(),
      pin(id: string, x: number, y: number) {
        const node = graph.nodes.find((item) => item.id === id)!;
        node.fx = x;
        node.fy = y;
      },
      release(id: string) {
        const node = graph.nodes.find((item) => item.id === id)!;
        node.fx = null;
        node.fy = null;
      },
    };
  },
}));

let host: HTMLDivElement;
let root: Root;
let resize: () => void;
let animationFrame: FrameRequestCallback | undefined;
let graph: BuiltGraph;
const onSelect = vi.fn();
const fit = vi.mocked(fitGraphView);
const simulation = () =>
  vi.mocked(createGraphSimulation).mock.results.at(-1)!.value as Simulation<GNode, undefined>;
const render = () => act(() => root.render(h(GraphCanvas, { graph, selectedId: null, onSelect })));
const tick = (alpha: number) =>
  act(() => {
    const sim = simulation().alpha(alpha);
    sim.on('tick')!.call(sim);
    const frame = animationFrame;
    animationFrame = undefined;
    frame?.(0);
  });
function pointer(type: string, x = 20, movement = 0) {
  const event = new PointerEvent(type, { bubbles: true, clientX: x, clientY: 20 });
  Object.defineProperties(event, {
    movementX: { value: movement },
    movementY: { value: 0 },
  });
  act(() => host.querySelector('.weq-graph-canvas-wrap')!.dispatchEvent(event));
}
const enable = () => act(() => host.querySelector<HTMLButtonElement>('.weq-graph-fit')!.click());

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    animationFrame = callback;
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {
    animationFrame = undefined;
  });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 800,
    bottom: 600,
    width: 800,
    height: 600,
    toJSON() {},
  });
  graph = {
    nodes: ['a', 'b'].map((id) => ({
      id,
      kind: 'person',
      label: id,
      avatarUrl: null,
      community: 0,
      weight: 1,
      radius: 14,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      fx: null,
      fy: null,
    })),
    edges: [],
    communityCount: 1,
  };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  render();
  expect(fit).toHaveBeenCalled();
  fit.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('群交集持续自适应', () => {
  it('同一动画帧内多次布局回传只绘制和取景一次', () => {
    act(() => {
      const sim = simulation();
      for (let i = 0; i < 5; i++) sim.on('tick')!.call(sim);
    });
    expect(fit).not.toHaveBeenCalled();
    act(() => {
      const frame = animationFrame;
      animationFrame = undefined;
      frame?.(0);
    });
    expect(fit).toHaveBeenCalledOnce();
  });
  it('初始开启，在布局的每一帧及结束时跟随，不只在冷却后校准一次', () => {
    for (const alpha of [0.9, 0.5, 0.17, 0.1]) tick(alpha);
    expect(fit).toHaveBeenCalledTimes(4);
    act(() => {
      simulation().on('end')!.call(simulation());
      const frame = animationFrame;
      animationFrame = undefined;
      frame?.(0);
    });
    expect(fit).toHaveBeenCalledTimes(5);
  });

  it('单击空白或头像不退出跟随，仍正常选中', () => {
    pointer('pointerdown');
    pointer('pointermove', 21, 1);
    pointer('pointerup', 21);
    expect(onSelect).toHaveBeenCalledTimes(1);
    tick(0.9);
    expect(fit).toHaveBeenCalledTimes(1);
    const node = graph.nodes[0];
    const view = fit.mock.results.at(-1)!.value;
    const x = node.x * view.scale + view.x;
    const y = node.y * view.scale + view.y;
    for (const type of ['pointerdown', 'pointerup']) {
      act(() =>
        host
          .querySelector('.weq-graph-canvas-wrap')!
          .dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y })),
      );
    }
    expect(onSelect.mock.calls.at(-1)![0]).toBe(node);
    tick(0.5);
    expect(fit).toHaveBeenCalledTimes(2);
  });

  it.each(['画布', '节点'])(
    '拖动%s后退出，重算和结束不擅自恢复，点击按钮才重新持续跟随',
    (target) => {
      if (target === '节点') {
        // 将节点放到当前视角的指针下，真实走命中检测。
        enable();
        const view = fit.mock.results.at(-1)!.value;
        graph.nodes[0].x = (20 - view.x) / view.scale;
        graph.nodes[0].y = (20 - view.y) / view.scale;
      }
      fit.mockClear();
      pointer('pointerdown');
      pointer('pointermove', 30, 10);
      if (target === '节点') expect(graph.nodes[0].fx).not.toBeNull();
      pointer('pointerup', 30);
      tick(0.1);
      expect(fit).not.toHaveBeenCalled();
      graph = { ...graph, nodes: graph.nodes.slice(0, 1) };
      render();
      tick(0.01);
      act(() => {
        simulation().on('end')!.call(simulation());
        const frame = animationFrame;
        animationFrame = undefined;
        frame?.(0);
      });
      expect(fit).not.toHaveBeenCalled();
      enable();
      expect(fit).toHaveBeenCalledTimes(1);
      tick(0.9);
      tick(0.5);
      expect(fit).toHaveBeenCalledTimes(3);
    },
  );

  it('缩放后停止跟随，恢复自适应后继续响应布局和尺寸变化', () => {
    act(() =>
      host
        .querySelector('.weq-graph-canvas-wrap')!
        .dispatchEvent(
          new WheelEvent('wheel', { bubbles: true, deltaY: -120, clientX: 20, clientY: 20 }),
        ),
    );
    tick(0.1);
    expect(fit).not.toHaveBeenCalled();
    enable();
    tick(0.9);
    tick(0.5);
    vi.stubGlobal('devicePixelRatio', 2);
    act(() => resize());
    expect(fit).toHaveBeenCalledTimes(4);
  });
});
