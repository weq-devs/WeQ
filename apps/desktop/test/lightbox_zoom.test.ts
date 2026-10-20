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
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

import { ImageLightbox, openLightbox } from '@renderer/components/ImageLightbox';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount(): void {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(createElement(ImageLightbox));
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

describe('图片灯箱滚轮缩放', () => {
  it('合成窗口打开的图片留在子窗口，缩放与 Escape 也使用子窗口事件', () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const child = new HappyWindow();
    mount();
    try {
      act(() =>
        openLightbox(
          'weq-media://synthetic-child-image',
          '合成图片',
          null,
          child.document as unknown as Document,
        ),
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
    act(() => openLightbox('weq-media://pic?t=1', '图'));

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
    act(() => openLightbox('weq-media://pic?t=2', '图'));
    wheel(frame(), -120);
    expect(frame().style.transform).toMatch(/scale\(1\.15/);
  });

  it('滚轮落在图外的暗底上也能缩放（整块灯箱可滚）', () => {
    mount();
    act(() => openLightbox('weq-media://pic?t=3', '图'));

    wheel(document.querySelector('.weq-lightbox-layer')!, -120);
    expect(frame().style.transform).toMatch(/scale\(1\.15/);
  });

  it('同一个滚轮事件不会被算两次（图上滚一格 = 一档）', () => {
    mount();
    act(() => openLightbox('weq-media://pic?t=4', '图'));

    wheel(document.querySelector('.weq-lightbox-image')!, -120);
    // 1.15^2 ≈ 1.32；只应缩放一档（1.15）
    expect(frame().style.transform).toMatch(/scale\(1\.15\d*\)/);
  });
});
