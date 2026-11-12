import { openMediaPreview, MediaPreviewHost } from './mediaPreviewStore';

export function openVideoLightbox(
  src: string,
  poster?: string,
  name?: string,
  ownerDocument: Document = document,
) {
  if (!src) return;
  openMediaPreview(
    {
      items: [{ key: src, kind: 'video', src, poster, title: name }],
      ownerDocument,
      onClose: () => {},
    },
    'video',
  );
}
export function VideoLightbox() {
  return <MediaPreviewHost kind="video" />;
}
