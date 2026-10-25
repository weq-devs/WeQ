import { readFile, stat } from 'node:fs/promises';
import { createImagePreviewer } from './image_preview';
import { fileResponse } from './file_response';

const preview = createImagePreviewer({ preserveAnimation: true });

/** 气泡缩图复用受限解码器；动画保留播放，原图仍由灯箱独立请求。 */
export async function chatImageResponse(
  path: string,
  request?: Request,
  check?: () => void,
): Promise<Response> {
  try {
    const output = await preview(async () => {
      check?.();
      const info = await stat(path);
      if (info.size > 32 * 1024 * 1024) throw new Error('preview input size');
      return readFile(path);
    });
    check?.();
    return new Response(new Uint8Array(output), {
      headers: {
        'Content-Type': 'image/webp',
        'Content-Length': String(output.byteLength),
        'Cache-Control': 'no-cache',
      },
    });
  } catch {
    check?.();
    // 动画、坏图或超限输入沿用原图回退，不静默替换成静态首帧。
    return fileResponse(path, request);
  }
}
