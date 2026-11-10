import { act, createElement as h } from 'react';
import { createPortal } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Avatar } from '../src/renderer/src/im-template/template/primitives';
import { ShimmerImage } from '../src/renderer/src/components/ShimmerImage';

vi.mock('../src/renderer/src/hooks/useAvatarUrl', () => ({ useAvatarUrl: (src: string) => src }));

type Observer = {
  targets: Set<Element>;
  notify(target: Element, near: boolean): void;
  unobserve: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
};
const observers: Observer[] = [];
let root: Root;
let host: HTMLDivElement;
let hidden = false;
let descriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  hidden = false;
  descriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (hidden ? 'hidden' : 'visible'),
  });
  observers.length = 0;
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      targets = new Set<Element>();
      unobserve = vi.fn((target: Element) => this.targets.delete(target));
      disconnect = vi.fn(() => this.targets.clear());
      constructor(private callback: IntersectionObserverCallback) {
        observers.push(this);
      }
      observe(target: Element) {
        this.targets.add(target);
      }
      notify(target: Element, near: boolean) {
        this.callback(
          [{ target, isIntersecting: near } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        );
      }
    },
  );
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  if (descriptor) Object.defineProperty(document, 'visibilityState', descriptor);
  else Reflect.deleteProperty(document, 'visibilityState');
  vi.unstubAllGlobals();
});

function placeholders() {
  return [...host.querySelectorAll<HTMLElement>('.avatar-shimmer, .weq-shimmer-block')];
}

it('头像和图片占位共享观察器，只播放接近视口的闪光，不改变图片节点和源', () => {
  act(() =>
    root.render([
      ...Array.from({ length: 80 }, (_, i) =>
        h(Avatar, { key: `avatar-${i}`, name: `合成好友${i}`, avatarUrl: `/avatar-${i}.png` }),
      ),
      ...Array.from({ length: 10 }, (_, i) =>
        h(ShimmerImage, { key: `image-${i}`, src: `/image-${i}.png` }),
      ),
    ]),
  );
  const pending = placeholders();
  expect(pending).toHaveLength(90);
  expect(observers).toHaveLength(1);
  const observer = observers[0]!;
  expect(observer.targets.size).toBe(90);
  expect(pending.every((node) => node.style.animationName === 'none')).toBe(true);
  const images = [...host.querySelectorAll('img')];
  const sources = images.map((image) => image.getAttribute('src'));

  observer.notify(pending[0]!, true);
  observer.notify(pending[80]!, true);
  expect(pending.filter((node) => node.style.animationName !== 'none')).toHaveLength(2);
  hidden = true;
  document.dispatchEvent(new Event('visibilitychange'));
  expect(pending.every((node) => node.style.animationName === 'none')).toBe(true);
  hidden = false;
  document.dispatchEvent(new Event('visibilitychange'));
  expect(pending.filter((node) => node.style.animationName !== 'none')).toHaveLength(2);
  observer.notify(pending[0]!, false);
  expect(pending[0]!.style.animationName).toBe('none');
  expect([...host.querySelectorAll('img')]).toEqual(images);
  expect(images.map((image) => image.getAttribute('src'))).toEqual(sources);

  act(() => images[0]!.dispatchEvent(new Event('load')));
  expect(observer.unobserve).toHaveBeenCalledWith(pending[0]);
  expect(placeholders()).toHaveLength(89);
  expect(observer.targets.size).toBe(89);
  // 已释放元素的迟到观察结果不能重新开播。
  observer.notify(pending[0]!, true);
  act(() => root.render(null));
  expect(observer.disconnect).toHaveBeenCalledTimes(1);
  expect(observer.targets.size).toBe(0);
  act(() => root.render(h(Avatar, { name: '新头像', avatarUrl: '/next.png' })));
  expect(observers).toHaveLength(2);
});

it('缺少 IntersectionObserver 时仍显示占位，文档隐藏仍停止闪光', () => {
  vi.stubGlobal('IntersectionObserver', undefined);
  act(() => root.render(h(ShimmerImage, { src: '/fixture.png' })));
  const pending = placeholders()[0]!;
  expect(pending.style.animationName).not.toBe('none');
  hidden = true;
  document.dispatchEvent(new Event('visibilitychange'));
  expect(pending.style.animationName).toBe('none');
  expect(host.querySelector('img')?.getAttribute('src')).toBe('/fixture.png');
  hidden = false;
  document.dispatchEvent(new Event('visibilitychange'));
  expect(pending.style.animationName).not.toBe('none');
});

it('独立文档只跟随自己的可见性，不被主文档隐藏状态干扰', () => {
  const other = document.implementation.createHTMLDocument('合成独立窗');
  Object.defineProperty(other, 'visibilityState', { configurable: true, value: 'visible' });
  act(() => root.render(createPortal(h(ShimmerImage, { src: '/fixture.png' }), other.body)));
  const pending = other.querySelector<HTMLElement>('.weq-shimmer-block')!;
  expect(pending.style.animationName).not.toBe('none');
  hidden = true;
  document.dispatchEvent(new Event('visibilitychange'));
  expect(pending.style.animationName).not.toBe('none');
  Object.defineProperty(other, 'visibilityState', { value: 'hidden' });
  other.dispatchEvent(new Event('visibilitychange'));
  expect(pending.style.animationName).toBe('none');
});
