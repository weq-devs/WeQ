import { createPortal } from 'react-dom';
import type { PreviewOcrContext } from './mediaPreviewTypes';
import { usePreviewOcr } from './usePreviewOcr.shared';

/** OCR 只挂载到图片与工具栏插槽，不重挂载媒体外壳或播放器。 */
export function PreviewOcr({
  src,
  originalSrc,
  context,
  frame,
  actions,
  size,
  ready,
}: {
  src: string;
  originalSrc?: string;
  context: PreviewOcrContext;
  frame: HTMLElement;
  actions: HTMLElement;
  size: { width: number; height: number };
  ready: boolean;
}) {
  const ocr = usePreviewOcr(src, context, originalSrc);
  return (
    <>
      {createPortal(
        <>
          {ocr.overlay(size.width, size.height)}
          {ocr.busy}
        </>,
        frame,
      )}
      {createPortal(ocr.controls(ready), actions)}
      {ocr.panel}
    </>
  );
}
