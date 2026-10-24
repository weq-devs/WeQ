export const MAX_DECORATION_FRAME_BYTES = 64 * 1024 * 1024;

/** 浏览器与媒体协议共用 PNG 头预检，先挡住异常尺寸，再允许任何解码入口取图。 */
export function decorationFrameBytes(head: Uint8Array): number {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82];
  if (head.length < 24 || signature.some((value, i) => head[i] !== value))
    throw new Error('装扮帧不是有效 PNG');
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const width = view.getUint32(16),
    height = view.getUint32(20);
  if (!width || !height || width > 8192 || height > 8192) throw new Error('装扮帧尺寸异常');
  const bytes = width * height * 4;
  if (bytes > MAX_DECORATION_FRAME_BYTES) throw new Error('装扮帧超过解码预算');
  return bytes;
}
