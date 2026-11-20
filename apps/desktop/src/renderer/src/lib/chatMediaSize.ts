type MediaKind = 'pic' | 'video' | 'mface';
type MediaData = Record<string, unknown>;
export type MediaSize = { width: number; height: number };

export function intrinsicMediaSize(width: number, height: number): MediaSize | undefined {
  if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0)
    return { width, height };
}

export function messageMediaSize(kind: MediaKind, data: MediaData, decoded?: MediaSize): MediaSize {
  if (kind === 'mface') {
    const preview = intrinsicMediaSize(Number(data.previewWidth), Number(data.previewHeight));
    if (!preview) return { width: 120, height: 120 };
    const width = Math.min(preview.width, 120);
    return { width, height: Math.max(1, Math.round((width * preview.height) / preview.width)) };
  }
  const image = kind === 'pic';
  const emoji = image && Number(data.subType) === 1;
  const flash =
    image &&
    !data.localPreviewUrl &&
    (Boolean(data.isFlash) || String(data.fileToken ?? '').startsWith('/'));
  const intrinsic =
    intrinsicMediaSize(
      Number(image ? data.imgWidth : data.videoWidth),
      Number(image ? data.imgHeight : data.videoHeight),
    ) ?? decoded;
  if (!intrinsic) {
    if (flash) return { width: 140, height: 190 };
    return image ? { width: 120, height: 96 } : { width: 200, height: 120 };
  }
  const scale = Math.min(
    (emoji ? 120 : 200) / intrinsic.width,
    (emoji ? 120 : 400) / intrinsic.height,
    1,
  );
  return {
    width: Math.max(1, Math.round(intrinsic.width * scale)),
    height: Math.max(
      1,
      Math.min(Math.round(intrinsic.height * scale), image && !flash && !emoji ? 360 : 400),
    ),
  };
}
