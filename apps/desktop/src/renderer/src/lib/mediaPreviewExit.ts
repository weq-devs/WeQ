/**
 * 冻结已经显示的媒体帧。快照只有画面，不携带媒体源、播放控件或手势。
 */
export function prepareMediaPreviewExit(source: HTMLElement, snapshot: HTMLElement) {
  snapshot.removeAttribute('data-weq-media-preview');
  const mediaSelector = '.weq-preview-viewport img, video';
  const copies = snapshot.querySelectorAll(mediaSelector);
  const originals = source.querySelectorAll<HTMLImageElement | HTMLVideoElement>(mediaSelector);
  for (const [index, media] of originals.entries()) {
    const copy = copies[index];
    if (!copy) continue;
    const width = media.offsetWidth;
    const height = media.offsetHeight;
    const pixels =
      'videoWidth' in media
        ? { width: media.videoWidth, height: media.videoHeight, ready: media.readyState >= 2 }
        : { width: media.naturalWidth, height: media.naturalHeight, ready: media.complete };
    if (!width || !height) {
      copy.remove();
      continue;
    }

    const frame = media.ownerDocument.createElement('canvas');
    frame.className = media.className;
    frame.style.cssText = media.style.cssText;
    frame.style.width = `${width}px`;
    frame.style.height = `${height}px`;
    frame.style.opacity = media.ownerDocument.defaultView?.getComputedStyle(media).opacity ?? '';
    const scale = Math.min(
      1,
      Math.max(width, height) / Math.max(1, pixels.width, pixels.height),
      1920 / Math.max(1, pixels.width, pixels.height),
    );
    frame.width = Math.max(1, Math.round(pixels.width * scale));
    frame.height = Math.max(1, Math.round(pixels.height * scale));
    if (pixels.ready && pixels.width && pixels.height) {
      try {
        frame.getContext('2d')?.drawImage(media, 0, 0, frame.width, frame.height);
      } catch {
        // 解码中或平台不允许复制的帧仍可淡出预览外壳。
      }
    }
    copy.replaceWith(frame);
  }
  for (const audio of snapshot.querySelectorAll('audio')) audio.remove();
}
