/**
 * 图片灯箱的滚轮缩放回归测试。
 *
 * 背景：灯箱底部加操作条时，缩放 / 平移的挂载点从 `<img>` 挪到了外层
 * `.weq-lightbox-frame`（这样盖在图片上的 OCR 覆盖层能跟着一起缩放）。
 * `useZoomPan` 把 wheel 监听挂在挂载点上，所以必须保证「鼠标在图上滚轮」仍然能缩放。
 *
 * 这里真挂一次组件 + 真发一个 wheel 事件，断言 frame 上的 transform 真的变了——
 * 纯看代码看不出「ref 有没有接上、监听有没有挂上」这类问题。
 */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Window as HappyWindow } from 'happy-dom';
vi.mock('../src/renderer/src/hooks/useExportSavePolicy', () => ({
  useExportSavePolicy: () => ({
    binding: null,
    settings: { isLoading: false },
    isCurrent: () => true,
  }),
}));

// 灯箱会拉 tRPC（OCR 能力门禁）——单测不建 ipc 链接，直接给个死数据桩。
vi.mock('@renderer/trpc/client', () => ({
  trpc: {
    account: {
      getGroupAlbumAccessState: { useQuery: () => ({ data: undefined }) },
      ocrCacheLookup: { useQuery: () => ({ data: undefined }) },
      ocrChatImage: { useMutation: () => ({ mutateAsync: async () => ({ blocks: [] }) }) },
    },
  },
}));

import { MediaPreviewHost, openMediaPreview } from '@renderer/components/mediaPreviewStore';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(): void {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(createElement(MediaPreviewHost));
  });
}

/** 灯箱里那个承载缩放变换的元素（图片与 OCR 层一起挂在它上面）。 */
function frame(): HTMLElement {
  const el = document.querySelector('.weq-lightbox-frame');
  if (!el) throw new Error('没找到 .weq-lightbox-frame —— 灯箱没渲染出来？');
  return el as HTMLElement;
}

function wheel(target: Element, deltaY: number): void {
  act(() => {
    target.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY,
        clientX: 10,
        clientY: 10,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

function openGallery() {
  mount();
  act(() =>
    openMediaPreview({
      items: [1, 2, 3].map((index) => ({
        key: `touch-${index}`,
        kind: 'image' as const,
        src: `data:image/png;base64,fixture${index}`,
        title: `图片 ${index}`,
        ocr: null,
      })),
    }),
  );
  // DOM 单测没有平台活动指针；真实捕获另由浏览器触摸输入验证。
  frame().setPointerCapture = vi.fn();
}

function pointer(target: EventTarget, type: string, id: number, x: number, y = 200) {
  act(() => {
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: id,
        pointerType: 'touch',
        isPrimary: id === 1,
        clientX: x,
        clientY: y,
      }),
    );
  });
}

function swipe(from: number, to: number, y = 200, endY = y) {
  pointer(frame(), 'pointerdown', 1, from, y);
  pointer(window, 'pointermove', 1, to, endY);
  pointer(window, 'pointerup', 1, to, endY);
}

describe('图片灯箱触摸手势', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    openGallery();
  });

  it('双指按距离放大并跟随中点，松开一指后继续平移，不触发点击或切图', () => {
    vi.spyOn(frame(), 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 400));
    pointer(frame(), 'pointerdown', 1, 150);
    pointer(frame(), 'pointerdown', 2, 250);
    pointer(window, 'pointermove', 1, 100, 220);
    pointer(window, 'pointermove', 2, 300, 220);
    expect(frame().style.transform).toBe('translate3d(0px, 20px, 0) scale(2)');
    expect(frame().style.transition).toBe('none');
    pointer(window, 'pointerup', 1, 100, 220);
    pointer(window, 'pointermove', 2, 330, 240);
    expect(frame().style.transform).toBe('translate3d(30px, 40px, 0) scale(2)');
    pointer(window, 'pointerup', 2, 330, 240);
    expect(frame().style.transform).toContain('scale(2)');
    expect(document.querySelector('.weq-preview-count')?.textContent).toBe('1 / 3');
  });

  it('双指缩小最低保持 100%，松手居中，随后横滑正常切图', () => {
    pointer(frame(), 'pointerdown', 1, 100);
    pointer(frame(), 'pointerdown', 2, 300);
    pointer(window, 'pointermove', 1, 150);
    pointer(window, 'pointermove', 2, 250);
    expect(frame().style.transform).toContain('scale(1)');
    pointer(window, 'pointerup', 1, 150);
    pointer(window, 'pointerup', 2, 250);
    expect(frame().style.transform).toBe('translate3d(0px, 0px, 0) scale(1)');
    swipe(250, 100);
    expect(document.querySelector('.weq-preview-count')?.textContent).toBe('2 / 3');
    expect(frame().style.transform).toContain('scale(1)');
  });

  it('100% 时左滑下一张、右滑上一张，到头不循环或关闭预览', () => {
    swipe(100, 250);
    expect(document.querySelector('.weq-preview-count')?.textContent).toBe('1 / 3');
    swipe(250, 100);
    expect(document.querySelector('.weq-preview-count')?.textContent).toBe('2 / 3');
    swipe(250, 100);
    swipe(250, 100);
    expect(document.querySelector('.weq-preview-count')?.textContent).toBe('3 / 3');
    swipe(100, 250);
    expect(document.querySelector('.weq-preview-count')?.textContent).toBe('2 / 3');
  });

  it('短滑和竖滑不切图、不点击放大，放大后的横滑只平移', () => {
    swipe(200, 215);
    swipe(200, 260, 100, 300);
    expect(document.querySelector('.weq-preview-count')?.textContent).toBe('1 / 3');
    expect(frame().style.transform).toContain('scale(1)');
    pointer(frame(), 'pointerdown', 1, 200);
    pointer(window, 'pointerup', 1, 200);
    expect(frame().style.transform).toContain('scale(2)');
    swipe(250, 100);
    expect(document.querySelector('.weq-preview-count')?.textContent).toBe('1 / 3');
    expect(frame().style.transform).toContain('scale(2)');
  });

  it.each(['pointercancel', 'lostpointercapture', 'blur'])(
    '%s 中断不切图，下一次手势正常',
    (type) => {
      pointer(frame(), 'pointerdown', 1, 250);
      pointer(window, 'pointermove', 1, 100);
      if (type === 'blur') act(() => window.dispatchEvent(new Event(type)));
      else pointer(window, type, 1, 100);
      pointer(window, 'pointerup', 1, 100);
      expect(document.querySelector('.weq-preview-count')?.textContent).toBe('1 / 3');
      swipe(250, 100);
      expect(document.querySelector('.weq-preview-count')?.textContent).toBe('2 / 3');
    },
  );

  it('切换图片清理仍按下的双指，旧事件不能改变新图片', () => {
    pointer(frame(), 'pointerdown', 1, 150);
    pointer(frame(), 'pointerdown', 2, 250);
    pointer(window, 'pointermove', 2, 350);
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="下一项媒体"]')!.click());
    pointer(window, 'pointermove', 2, 450);
    pointer(window, 'pointerup', 1, 150);
    pointer(window, 'pointerup', 2, 450);
    expect(document.querySelector('.weq-preview-count')?.textContent).toBe('2 / 3');
    expect(frame().style.transform).toBe('translate3d(0px, 0px, 0) scale(1)');
  });

  it('双指放大最多 800%，连续缩小到 100%，余指横移不误切图', () => {
    pointer(frame(), 'pointerdown', 1, 195);
    pointer(frame(), 'pointerdown', 2, 205);
    pointer(window, 'pointermove', 2, 395);
    expect(frame().style.transform).toContain('scale(8)');
    pointer(window, 'pointermove', 2, 197);
    expect(frame().style.transform).toContain('scale(1)');
    pointer(window, 'pointerup', 2, 197);
    pointer(window, 'pointermove', 1, 50);
    pointer(window, 'pointerup', 1, 50);
    expect(document.querySelector('.weq-preview-count')?.textContent).toBe('1 / 3');
    expect(frame().style.transform).toBe('translate3d(0px, 0px, 0) scale(1)');
  });

  it('预览空白的点击保留原翻页动作，横滑不重复触发点击', () => {
    const viewport = document.querySelector<HTMLElement>('.weq-preview-viewport')!;
    viewport.setPointerCapture = vi.fn();
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 400));
    pointer(viewport, 'pointerdown', 1, 350);
    pointer(window, 'pointerup', 1, 350);
    expect(document.querySelector('.weq-preview-count')?.textContent).toBe('2 / 3');
    pointer(viewport, 'pointerdown', 1, 100);
    pointer(window, 'pointermove', 1, 250);
    pointer(window, 'pointerup', 1, 250);
    expect(document.querySelector('.weq-preview-count')?.textContent).toBe('1 / 3');
  });
});

describe('图片灯箱滚轮缩放', () => {
  it('合成窗口打开的图片留在子窗口，缩放与 Escape 也使用子窗口事件', () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const child = new HappyWindow();
    mount();
    try {
      act(() =>
        openMediaPreview({
          items: [
            {
              key: 'weq-media://synthetic-child-image',
              kind: 'image',
              src: 'weq-media://synthetic-child-image',
              title: '合成图片',
              ocr: null,
            },
          ],
          ownerDocument: child.document as unknown as Document,
        }),
      );
      expect(document.querySelector('.weq-lightbox-frame')).toBeNull();
      const media = child.document.querySelector<HTMLElement>('.weq-lightbox-frame')!;
      expect(media).not.toBeNull();
      act(() =>
        media.dispatchEvent(
          new child.MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 10, clientY: 10 }),
        ),
      );
      act(() => child.dispatchEvent(new child.MouseEvent('mouseup', { clientX: 10, clientY: 10 })));
      expect(media.style.transform).toContain('scale(2)');
      act(() =>
        child.document.dispatchEvent(
          new child.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        ),
      );
      expect(child.document.querySelector('.weq-lightbox-frame')).toBeNull();
    } finally {
      act(() => root?.unmount());
      host?.remove();
      child.close();
    }
  });
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  });

  it('在图片上滚轮 → frame 上的 transform 放大', () => {
    mount();
    act(() =>
      openMediaPreview({
        items: [
          { key: 'weq-media://pic?t=1', kind: 'image', src: 'weq-media://pic?t=1', title: '图' },
        ],
      }),
    );

    const before = frame().style.transform;
    expect(before).toContain('scale(1)');

    wheel(document.querySelector('.weq-lightbox-image')!, -120);
    expect(frame().style.transform).toMatch(/scale\(1\.15\d*\)/);

    // 往回滚回到 1×
    wheel(document.querySelector('.weq-lightbox-image')!, 1200);
    expect(frame().style.transform).toContain('scale(1)');
  });

  it('图片还没加载出来（尺寸为 0）时滚轮也照样缩放', () => {
    mount();
    act(() =>
      openMediaPreview({
        items: [
          { key: 'weq-media://pic?t=2', kind: 'image', src: 'weq-media://pic?t=2', title: '图' },
        ],
      }),
    );
    wheel(frame(), -120);
    expect(frame().style.transform).toMatch(/scale\(1\.15/);
  });

  it('滚轮落在图外的暗底上也能缩放（整块灯箱可滚）', () => {
    mount();
    act(() =>
      openMediaPreview({
        items: [
          { key: 'weq-media://pic?t=3', kind: 'image', src: 'weq-media://pic?t=3', title: '图' },
        ],
      }),
    );

    wheel(document.querySelector('.weq-lightbox-layer')!, -120);
    expect(frame().style.transform).toMatch(/scale\(1\.15/);
  });

  it('同一个滚轮事件不会被算两次（图上滚一格 = 一档）', () => {
    mount();
    act(() =>
      openMediaPreview({
        items: [
          { key: 'weq-media://pic?t=4', kind: 'image', src: 'weq-media://pic?t=4', title: '图' },
        ],
      }),
    );

    wheel(document.querySelector('.weq-lightbox-image')!, -120);
    // 1.15^2 ≈ 1.32；只应缩放一档（1.15）
    expect(frame().style.transform).toMatch(/scale\(1\.15\d*\)/);
  });
});
