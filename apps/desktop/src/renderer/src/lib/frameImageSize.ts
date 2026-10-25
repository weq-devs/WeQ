import { decorationFrameBytes } from '../../../shared/decoration_image';

/** 只读取 PNG 的签名和 IHDR；服务端忽略 Range 时也不缓冲整份图片。 */
export async function readFrameBytes(url: string, signal: AbortSignal): Promise<number> {
  const response = await fetch(url, { headers: { Range: 'bytes=0-23' }, signal });
  if (!response.ok || !response.body) throw new Error('装扮帧尺寸预检失败');
  const reader = response.body.getReader();
  const head = new Uint8Array(24);
  let offset = 0;
  try {
    while (offset < head.length) {
      const { value, done } = await reader.read();
      if (done) break;
      const part = value.subarray(0, head.length - offset);
      head.set(part, offset);
      offset += part.length;
    }
  } finally {
    await reader.cancel();
  }
  return decorationFrameBytes(head.subarray(0, offset));
}
