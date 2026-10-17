/** Read-only projection of previously cached SDK messages; no SDK connection or requests. */
import { decodeElement } from '@weq/codec';
import { toRenderElements, type RenderElement } from './msg_view';
const obj = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const numeric = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/** Explicit SDK field projection; every element also keeps its original JSON. */
export function nativeHistoryElements(value: unknown): RenderElement[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const source = obj(item),
      type = numeric(source.elementType);
    const key = (
      {
        1: 'textElement',
        2: 'picElement',
        3: 'fileElement',
        4: 'pttElement',
        5: 'videoElement',
        6: 'faceElement',
        10: 'arkElement',
        14: 'markdownElement',
      } as Record<number, string>
    )[type];
    const child = key ? obj(source[key]) : {};
    const supported =
      Boolean(key && Object.keys(child).length) &&
      (type !== 1 || typeof child.content === 'string') &&
      (type !== 6 || Number.isInteger(child.faceIndex)) &&
      (type !== 10 || typeof child.bytesData === 'string') &&
      (type !== 14 || typeof child.content === 'string');
    const wire: Record<string, unknown> = { ...child, elementType: type };
    if (type === 1) {
      wire.textContent = text(child.content);
      if (/^u_[A-Za-z0-9_-]+$/.test(text(child.atUid))) wire.atTargetUid = child.atUid;
    } else if (type === 2) {
      wire.imgWidth = numeric(child.picWidth);
      wire.imgHeight = numeric(child.picHeight);
      wire.originalUrl = text(child.originImageUrl);
      wire.filePath = text(child.filePath);
    } else if (type === 4) {
      wire.pttDuration = numeric(child.duration);
      wire.pttTranscript = text(child.text);
      wire.waveform = Array.isArray(child.waveAmplitudes) ? child.waveAmplitudes : [];
    } else if (type === 5) wire.videoDuration = numeric(child.duration);
    else if (type === 6) {
      wire.faceId = numeric(child.faceIndex);
      wire.faceText = text(child.faceText);
    } else if (type === 10) wire.arkData = text(child.bytesData);
    else if (type === 14) wire.markdownContent = text(child.content);
    if ([2, 3, 4, 5].includes(type)) {
      wire.fileName = text(child.fileName);
      wire.fileSize = numeric(child.fileSize);
      wire.fileToken = text(child.fileUuid) || text(child.fileUUID);
      wire.filePath = text(child.filePath);
      wire.isOriginal = true;
      wire.uploadTime = 0;
      wire.uploadTimestamp = 0;
      wire.fileTTL = 0;
      wire.summary = [];
    }
    let render: RenderElement;
    if (!supported) render = { type: 'unknown', data: { elementType: type } } as RenderElement;
    else
      render = toRenderElements([decodeElement(wire as Parameters<typeof decodeElement>[0])])[0]!;
    return { ...render, data: { ...render.data, nativeElement: item } } as RenderElement;
  });
}
