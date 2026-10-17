/**
 * 统一浮层机制的回归测试：层级分配（`lib/overlayStack`）+ 浮层外壳
 * （`components/OverlayLayer`）。
 *
 * 背景：弹窗曾各自在 CSS 里写死 z-index，于是出现「遮罩遮不住」——WeQ 弹窗的 74 / 80 / 90
 * 被模板自己的 95 / 96 和 opt-in 的 ≥1200 压住。现在统一改成向 overlayStack 领层：
 * 按打开顺序单调递增，**最后打开的一定在最上面**，不再依赖作者预判组合。
 *
 * 这两组不变量一旦破坏就是回归，而纯看代码看不出来（`useRef` 有没有记住、关闭有没有
 * 真的释放、重开有没有拿到新号、portal 有没有真的挂到 body）——所以这里真挂组件、真开关、
 * 真发事件，断言发出来的层号与真实 DOM。
 */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { OverlayLayer } from '@renderer/components/OverlayLayer';
import { useOverlayLayer } from '@renderer/lib/overlayStack';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

/** 探针：把 hook 发的层写进 DOM，方便断言「发了几号 / 有没有发」。 */
function Probe({ active }: { active: boolean }) {
  const layer = useOverlayLayer(active);
  return createElement('span', { 'data-layer': layer === undefined ? 'none' : String(layer) });
}

const roots: Root[] = [];
const hosts: HTMLDivElement[] = [];

/** 挂一个探针，返回读层号 / 改激活状态 / 卸载三个句柄。 */
function mountProbe(active: boolean) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const render = (next: boolean) => {
    act(() => {
      root.render(createElement(Probe, { active: next }));
    });
  };
  render(active);
  hosts.push(host);
  roots.push(root);

  return {
    /** 当前发到的层号；没占层时 undefined。 */
    layer(): number | undefined {
      const raw = host.querySelector('span')?.getAttribute('data-layer');
      return raw == null || raw === 'none' ? undefined : Number(raw);
    },
    set: render,
    unmount(): void {
      act(() => root.unmount());
    },
  };
}

/** overlayStack 的 BASE —— 必须高于所有写死的静态 z-index（最高 .weq-ra-layer 的 1200）。 */
const STATIC_CSS_CEILING = 1200;
/** ToastHost 的层，必须永远在最上面；发层不能越过它。 */
const TOAST_HOST_LAYER = 4000;

describe('浮层层级分配', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    for (const root of roots) act(() => root.unmount());
    for (const host of hosts) host.remove();
    roots.length = 0;
    hosts.length = 0;
  });

  it('未激活时不占层（调用方可回落到自己的 CSS 值）', () => {
    const probe = mountProbe(false);
    expect(probe.layer()).toBeUndefined();
  });

  it('激活时拿到高于所有静态 CSS 层级、且低于 Toast 的层', () => {
    const probe = mountProbe(true);
    const layer = probe.layer();
    expect(layer).toBeDefined();
    expect(layer!).toBeGreaterThan(STATIC_CSS_CEILING);
    expect(layer!).toBeLessThan(TOAST_HOST_LAYER);
  });

  it('同时打开的两层不会同号，后开的在上', () => {
    const first = mountProbe(true);
    const second = mountProbe(true);
    expect(second.layer()!).toBeGreaterThan(first.layer()!);
  });

  it('激活状态不变时重渲染不会重新领号（否则会被自己后来的渲染反复顶上去）', () => {
    const probe = mountProbe(true);
    const issued = probe.layer();
    probe.set(true);
    expect(probe.layer()).toBe(issued);
  });

  it('关闭后释放、再打开拿到更高的号（后开的在上面）', () => {
    const probe = mountProbe(true);
    const first = probe.layer();
    probe.set(false);
    expect(probe.layer()).toBeUndefined();

    probe.set(true);
    expect(probe.layer()!).toBeGreaterThan(first!);
  });
});

/** 挂一层 OverlayLayer，宿主容器故意给个 id，方便断言「内容没留在原地」。 */
function mountOverlay(onClose: () => void): HTMLDivElement {
  const host = document.createElement('div');
  host.id = 'overlay-host';
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      createElement(
        OverlayLayer,
        { className: 'probe-scrim', onClose },
        createElement('div', { className: 'probe-card' }, '卡片'),
      ),
    );
  });
  roots.push(root);
  hosts.push(host);
  return host;
}

/** 外壳根节点（`document.body` 下那个，不是挂载容器里那个）。 */
function overlay(): HTMLElement {
  const el = document.querySelector('body > .weq-overlay-layer');
  if (!el) throw new Error('没找到 body 下的 .weq-overlay-layer —— 外壳没 portal 出去？');
  return el as HTMLElement;
}

function press(target: Element, type: 'mousedown'): void {
  act(() => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
  });
}

describe('浮层外壳 OverlayLayer', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    for (const root of roots) act(() => root.unmount());
    for (const host of hosts) host.remove();
    roots.length = 0;
    hosts.length = 0;
  });

  it('portal 到 body：内容不停留在挂载容器里', () => {
    const host = mountOverlay(() => {});
    expect(host.querySelector('.weq-overlay-layer')).toBeNull();
    expect(overlay()).toBeTruthy();
    expect(overlay().querySelector('.probe-card')?.textContent).toBe('卡片');
  });

  it('层级来自 overlayStack（高于所有写死的静态 z-index），并保留调用方的类名', () => {
    mountOverlay(() => {});
    const el = overlay();
    expect(el.classList.contains('weq-overlay-layer')).toBe(true);
    expect(el.classList.contains('probe-scrim')).toBe(true);
    expect(Number(el.style.zIndex)).toBeGreaterThan(STATIC_CSS_CEILING);
  });

  it('点遮罩空白处关闭，点内容不关闭', () => {
    let closed = 0;
    mountOverlay(() => {
      closed += 1;
    });
    press(overlay().querySelector('.probe-card')!, 'mousedown');
    expect(closed).toBe(0);
    press(overlay(), 'mousedown');
    expect(closed).toBe(1);
  });

  it('按 Esc 关闭', () => {
    let closed = 0;
    mountOverlay(() => {
      closed += 1;
    });
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(closed).toBe(1);
  });

  it('嵌套时点内层遮罩只关内层，不连带关掉外层', () => {
    let outerClosed = 0;
    let innerClosed = 0;
    const host = document.createElement('div');
    host.id = 'nested-overlay-host';
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        createElement(
          OverlayLayer,
          {
            className: 'outer-scrim',
            onClose: () => {
              outerClosed += 1;
            },
          },
          createElement(
            OverlayLayer,
            {
              className: 'inner-scrim',
              onClose: () => {
                innerClosed += 1;
              },
            },
            '内层',
          ),
        ),
      );
    });
    roots.push(root);
    hosts.push(host);

    // 两层都在 body 下；不去赌它们的先后顺序，直接按类名取。
    expect(document.querySelectorAll('body > .weq-overlay-layer')).toHaveLength(2);
    const inner = document.querySelector('body > .weq-overlay-layer.inner-scrim') as HTMLElement;
    expect(inner).toBeTruthy();

    press(inner, 'mousedown');
    expect(innerClosed).toBe(1);
    expect(outerClosed).toBe(0);
  });

  it('open 为假时整层不渲染，也不占层', () => {
    const host = document.createElement('div');
    host.id = 'overlay-host-closed';
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(createElement(OverlayLayer, { open: false, onClose: () => {} }, '不该出现'));
    });
    roots.push(root);
    hosts.push(host);
    expect(document.querySelector('body > .weq-overlay-layer')).toBeNull();
  });
});
