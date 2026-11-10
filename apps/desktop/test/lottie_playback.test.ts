import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AnimationConfigWithData, AnimationItem } from 'lottie-web';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FaceEmoji } from '../src/renderer/src/components/FaceEmoji';
import { ScreenWidget } from '../src/renderer/src/components/ChatBackdrop';
import { TabActivity } from '../src/renderer/src/components/RetainedTabs';

const player = vi.hoisted(() => ({ loadAnimation: vi.fn() }));
vi.mock('lottie-web/build/player/lottie_light', () => ({ default: player }));

type TestAnimation = {
  play: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  complete(): void;
  frame: SVGSVGElement;
  playing: boolean;
};
const animations: TestAnimation[] = [];
const observers: Array<{ target?: Element; notify(near: boolean): void; disconnect: () => void }> =
  [];
let root: Root;
let node: HTMLDivElement;
let documentHidden = false;
let visibilityDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  documentHidden = false;
  visibilityDescriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (documentHidden ? 'hidden' : 'visible'),
  });
  animations.length = 0;
  observers.length = 0;
  player.loadAnimation.mockReset().mockImplementation((config: AnimationConfigWithData) => {
    const listeners = new Map<string, Set<() => void>>();
    const frame = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    config.container.appendChild(frame);
    const animation: TestAnimation = {
      playing: config.autoplay !== false,
      frame,
      play: vi.fn(() => {
        animation.playing = true;
      }),
      pause: vi.fn(() => {
        animation.playing = false;
      }),
      destroy: vi.fn(() => {
        animation.playing = false;
        frame.remove();
        listeners.clear();
      }),
      complete() {
        animation.pause();
        for (const listener of [...(listeners.get('complete') ?? [])]) listener();
      },
    };
    animations.push(animation);
    return {
      ...animation,
      addEventListener(event: string, callback: () => void) {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(callback);
      },
      removeEventListener(event: string, callback: () => void) {
        listeners.get(event)?.delete(callback);
      },
    } as unknown as AnimationItem;
  });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      target?: Element;
      disconnect = vi.fn();
      constructor(private callback: IntersectionObserverCallback) {
        observers.push(this);
      }
      observe(target: Element) {
        this.target = target;
        this.notify(true);
      }
      notify(near: boolean) {
        this.callback(
          [{ target: this.target, isIntersecting: near } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        );
      }
    },
  );
  node = document.createElement('div');
  document.body.appendChild(node);
  root = createRoot(node);
});

afterEach(async () => {
  await act(async () => root.unmount());
  node.remove();
  if (visibilityDescriptor)
    Object.defineProperty(document, 'visibilityState', visibilityDescriptor);
  else Reflect.deleteProperty(document, 'visibilityState');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const face = (active = true, faceId = 358, innerId?: string) =>
  h(TabActivity, { active }, h(FaceEmoji, { element: { faceId, innerId }, animated: true }));

async function visibility(hidden: boolean) {
  documentHidden = hidden;
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
}

it('离屏、隐藏标签及隐藏文档只暂停表情，回来复用同一帧和请求', async () => {
  await act(async () => root.render(face()));
  expect(animations).toHaveLength(1);
  expect(observers).toHaveLength(1);
  const animation = animations[0]!;
  expect(animation.playing).toBe(true);
  expect(node.contains(animation.frame)).toBe(true);

  await act(async () => observers[0]!.notify(false));
  expect(animation.playing).toBe(false);
  expect(node.contains(animation.frame)).toBe(true);
  await act(async () => observers[0]!.notify(true));
  expect(animation.playing).toBe(true);
  await visibility(true);
  expect(animation.playing).toBe(false);
  await visibility(false);
  expect(animation.playing).toBe(true);
  await act(async () => root.render(face(false)));
  expect(animation.playing).toBe(false);
  await act(async () => root.render(face()));
  expect(animation.playing).toBe(true);
  expect(animation.destroy).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(player.loadAnimation).toHaveBeenCalledTimes(1);
  expect(player.loadAnimation.mock.calls[0]![0].autoplay).toBe(false);
});

it('交互表情保持前奏次数与最终结果，完成后不因重新可见而重播', async () => {
  await act(async () => root.render(face(true, 359, '2')));
  expect(animations).toHaveLength(1);
  await act(async () => animations[0]!.complete());
  expect(animations).toHaveLength(2);
  expect(animations[0]!.destroy).toHaveBeenCalledTimes(1);
  await act(async () => observers[0]!.notify(false));
  expect(animations[1]!.playing).toBe(false);
  await act(async () => observers[0]!.notify(true));
  expect(animations[1]!.playing).toBe(true);
  await act(async () => animations[1]!.complete());
  expect(animations).toHaveLength(3);
  const result = animations[2]!;
  await act(async () => result.complete());
  const plays = result.play.mock.calls.length;
  await act(async () => observers[0]!.notify(false));
  await act(async () => observers[0]!.notify(true));
  await visibility(true);
  await visibility(false);
  expect(result.play).toHaveBeenCalledTimes(plays);
  expect(result.playing).toBe(false);
  expect(node.contains(result.frame)).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(3);
});

it('资源到达时已离屏仍准备首帧，只在重新可见后开播，不重新取资源', async () => {
  let resolve!: (response: { ok: boolean; json(): Promise<object> }) => void;
  vi.mocked(fetch).mockImplementationOnce(
    () => new Promise((done) => (resolve = done)) as Promise<Response>,
  );
  await act(async () => root.render(face()));
  await act(async () => observers[0]!.notify(false));
  await act(async () => resolve({ ok: true, json: async () => ({}) }));
  const animation = animations[0]!;
  expect(animation.playing).toBe(false);
  expect(node.contains(animation.frame)).toBe(true);
  await act(async () => observers[0]!.notify(true));
  expect(animation.playing).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(player.loadAnimation).toHaveBeenCalledTimes(1);
});

it('缺失动画仍回退图片，换表情重新创建观察和播放器', async () => {
  vi.mocked(fetch).mockRejectedValueOnce(new Error('合成资源不存在'));
  await act(async () => root.render(face()));
  expect(node.querySelector('.face-emoji-lottie')).toBeNull();
  expect(node.querySelector('img')?.getAttribute('src')).toContain('358.png');
  expect(observers[0]!.disconnect).toHaveBeenCalledTimes(1);
  await act(async () => root.render(face(true, 360)));
  expect(animations).toHaveLength(1);
  expect(observers).toHaveLength(2);
  expect(observers[0]!.disconnect).toHaveBeenCalledTimes(1);
  expect(node.contains(animations[0]!.frame)).toBe(true);
  expect(animations[0]!.playing).toBe(true);
});

it('没有 IntersectionObserver 仍可播放，文档隐藏仍暂停，卸载销毁', async () => {
  vi.stubGlobal('IntersectionObserver', undefined);
  await act(async () => root.render(face()));
  const animation = animations[0]!;
  expect(animation.playing).toBe(true);
  await visibility(true);
  expect(animation.playing).toBe(false);
  await act(async () => root.render(null));
  expect(animation.destroy).toHaveBeenCalledTimes(1);
  await visibility(false);
  expect(animation.playing).toBe(false);
});

it('换表情和卸载中止旧 JSON 请求，迟到结果不创建播放器', async () => {
  let resolve!: (response: { ok: boolean; json(): Promise<object> }) => void;
  vi.mocked(fetch).mockImplementationOnce(
    () => new Promise((done) => (resolve = done)) as Promise<Response>,
  );
  await act(async () => root.render(face()));
  const signal = vi.mocked(fetch).mock.calls[0]![1]?.signal;
  expect(signal).toBeInstanceOf(AbortSignal);
  await act(async () => root.render(face(true, 360)));
  expect(signal?.aborted).toBe(true);
  expect(animations).toHaveLength(1);
  await act(async () => resolve({ ok: true, json: async () => ({}) }));
  expect(animations).toHaveLength(1);
  const nextSignal = vi.mocked(fetch).mock.calls[1]![1]?.signal;
  await act(async () => root.render(null));
  expect(nextSignal?.aborted).toBe(true);
  expect(animations[0]!.destroy).toHaveBeenCalledTimes(1);
});

it('浮屏挂件同样只暂停而不销毁重建，卸载中止资源并释放观察器', async () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) {
        Object.defineProperties(target, {
          clientWidth: { value: 720 },
          clientHeight: { value: 1280 },
        });
        this.callback([], this as unknown as ResizeObserver);
      }
      disconnect() {}
    },
  );
  await act(async () => root.render(h(ScreenWidget, { widgetId: '1' })));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 70)));
  expect(animations).toHaveLength(1);
  const animation = animations[0]!;
  await act(async () => observers[0]!.notify(false));
  expect(animation.playing).toBe(false);
  expect(node.contains(animation.frame)).toBe(true);
  await act(async () => observers[0]!.notify(true));
  expect(animation.playing).toBe(true);
  expect(player.loadAnimation).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledTimes(1);
  const signal = vi.mocked(fetch).mock.calls[0]![1]?.signal;
  await act(async () => root.render(null));
  expect(signal?.aborted).toBe(true);
  expect(animation.destroy).toHaveBeenCalledTimes(1);
  expect(observers[0]!.disconnect).toHaveBeenCalledTimes(1);
});
