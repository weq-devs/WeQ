import { openMediaPreview, MediaPreviewHost } from './mediaPreviewStore';
import type { LightboxOcrContext } from './mediaPreviewTypes';
export type { LightboxOcrContext } from './mediaPreviewTypes';

/** 兼容原单图入口，展示与状态由统一预览器维护。 */
export function openLightbox(
  src: string,
  alt = '',
  ocr: LightboxOcrContext | null = null,
  ownerDocument: Document = document,
  onClosed?: () => void,
  fallbackSources: string[] = [],
) {
  if (!src) return;
  openMediaPreview({
    items: [
      {
        key: src,
        kind: 'image',
        src,
        title: alt,
        ocr,
        fallbackSources,
        saveSource: src.startsWith('blob:') ? null : { kind: 'url', url: src, name: alt },
      },
    ],
    ownerDocument,
    onClose: () => onClosed?.(),
  });
}
export function ImageLightbox() {
  return <MediaPreviewHost kind="image" />;
}
