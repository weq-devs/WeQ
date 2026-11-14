import { open, readFile, stat } from 'node:fs/promises';
import { sniffImageExt } from '@weq/service';
import { imageMetadata, imageProcessor } from './image_processor';
import { createImagePreviewer } from './image_preview';
import { fileResponse, mimeOf } from './file_response';

const preview = createImagePreviewer({ preserveAnimation: true });
const reducedPreview = createImagePreviewer();
const MAX_ANIMATED_BYTES = 8 * 1024 * 1024;
const MAX_ANIMATED_FRAME_PIXELS = 4 * 1024 * 1024;
const MAX_FALLBACK_BYTES = 32 * 1024 * 1024;
const MAX_FALLBACK_ANIMATED_BYTES = 8 * 1024 * 1024;
const PREVIEW_UNAVAILABLE = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160" viewBox="0 0 320 160"><rect width="320" height="160" rx="12" fill="#e5e7eb"/><text x="160" y="75" text-anchor="middle" font-size="18" fill="#374151">图片无法安全预览</text><text x="160" y="104" text-anchor="middle" font-size="13" fill="#4b5563">点击查看原图</text></svg>`;

/**
 * 原生解码整体不可用时的最后兜底：直接把磁盘上已有的文件（QQ 缩略图或原图）
 * 交给渲染端。sharp 正常时不要让大图走这里 —— 这里只按体积和文件头把关，
 * 不重新编码；32 MiB 与解码器的输入上限一致，GIF/WebP 再按动画上限收紧。
 *
 * 返回 null 表示这个文件连直接展示都不安全（非图片、空文件、超限），调用方
 * 仍应回退到占位图。
 */
async function imageFallbackResponse(path: string, request?: Request): Promise<Response | null> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size === 0 || info.size > MAX_FALLBACK_BYTES) return null;
    const handle = await open(path, 'r');
    let extension: string | null;
    try {
      const head = Buffer.alloc(16);
      const { bytesRead } = await handle.read(head, 0, head.length, 0);
      extension = sniffImageExt(head.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
    if (!extension) return null;
    if ((extension === '.gif' || extension === '.webp') && info.size > MAX_FALLBACK_ANIMATED_BYTES)
      return null;
    const response = await fileResponse(path, request);
    if (!response.ok) return null;
    const headers = new Headers(response.headers);
    headers.set('Content-Type', mimeOf(`image${extension}`));
    headers.set('Cache-Control', 'no-cache');
    return new Response(response.body, { status: response.status, headers });
  } catch {
    return null;
  }
}

/** 气泡缩图复用受限解码器；动画保留播放，原图仍由灯箱独立请求。 */
export async function chatImageResponse(
  path: string,
  request?: Request,
  check?: () => void,
  reduced = false,
): Promise<Response> {
  try {
    const output = await (reduced ? reducedPreview : preview)(async () => {
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
    // sharp 在这个环境里整体起不来（典型是 Linux/Electron 的 glib 符号冲突）：
    // 继续每张图都返回占位图等于聊天里完全看不到图片，改为按体积/文件头直接
    // 展示本机已有文件；单张坏图或超限仍走下面的占位图。
    if (imageProcessor.isUnavailable()) {
      const fallback = await imageFallbackResponse(path, request);
      if (fallback) return fallback;
    }
    // 仅限小体积、合理帧数与分辨率的动画原样播放；失败或超限不能把原图
    // 作为缩略图塞回聊天列表，否则渲染端可能重新解码超大内容。
    if (!reduced && error instanceof Error && error.message === 'animated preview') {
      let safeAnimation = false;
      try {
        const info = await stat(path);
        if (info.size <= MAX_ANIMATED_BYTES) {
          const metadata = await imageMetadata(path, MAX_ANIMATED_FRAME_PIXELS);
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
