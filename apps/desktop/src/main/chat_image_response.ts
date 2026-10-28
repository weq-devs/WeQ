import { readFile, stat } from 'node:fs/promises';
import sharp from 'sharp';
import { createImagePreviewer } from './image_preview';
import { fileResponse } from './file_response';

const preview = createImagePreviewer({ preserveAnimation: true });
const MAX_ANIMATED_BYTES = 8 * 1024 * 1024;
const MAX_ANIMATED_FRAME_PIXELS = 4 * 1024 * 1024;
const PREVIEW_UNAVAILABLE = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160" viewBox="0 0 320 160"><rect width="320" height="160" rx="12" fill="#e5e7eb"/><text x="160" y="75" text-anchor="middle" font-size="18" fill="#374151">图片无法安全预览</text><text x="160" y="104" text-anchor="middle" font-size="13" fill="#4b5563">点击查看原图</text></svg>`;

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
  } catch (error) {
    check?.();
    // 仅限小体积、合理帧数与分辨率的动画原样播放；失败或超限不能把原图
    // 作为缩略图塞回聊天列表，否则渲染端可能重新解码超大内容。
    if (error instanceof Error && error.message === 'animated preview') {
      let safeAnimation = false;
      try {
        const info = await stat(path);
        if (info.size <= MAX_ANIMATED_BYTES) {
          const metadata = await sharp(path, {
            limitInputPixels: MAX_ANIMATED_FRAME_PIXELS,
          }).metadata();
          const framePixels = (metadata.width ?? 0) * (metadata.pageHeight ?? metadata.height ?? 0);
          safeAnimation =
            framePixels > 0 &&
            framePixels <= MAX_ANIMATED_FRAME_PIXELS &&
            (metadata.pages ?? 1) <= 100;
        }
      } catch {
        // 不可信图片的元数据无法校验时走占位，灯箱仍可独立查看原图。
      }
      if (safeAnimation) {
        check?.();
        return fileResponse(path, request);
      }
    }
    return new Response(PREVIEW_UNAVAILABLE, {
      headers: { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-cache' },
    });
  }
}
