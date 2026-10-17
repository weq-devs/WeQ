/**
 * 图片解码 —— 把字节 / dataURL 解成管线要的裸 RGB。
 *
 * 用 Electron 的 `nativeImage`（Chromium 的解码器）而不是再引一个 JS 解码库：
 * 主进程本来就在用聊天图片的字节流（`media_protocol.ts`），格式上跟着 Chromium 走
 * 就够（jpg / png / webp / bmp / gif 首帧都认），少一个依赖、少一份打包负担。
 *
 * ⚠️ 只能在**主进程**调用（`nativeImage` 是 Electron 的 API）；跑推理的 worker 是
 * 纯 Node 子进程，拿不到它 —— 所以解码在主进程做完，再把裸 RGB 喂给 worker。
 *
 * ⚠️ 这里的 electron **不能写成静态 import**：web 端（`apps/web`）也会加载本模块 ——
 * MCP 工具 → `ocr/local.ts` → 这里，而 electron 在纯 Node 下 import 会直接
 * "does not provide an export named 'nativeImage'" 把 web 服务打挂
 * （`apps/web/scripts/check-electron-free.ts` 就是为此立的门禁）。所以走运行时的
 * `require('electron')`，只有真的解码时才碰它 —— web 从不调用这条路径。
 */

import { createRequire } from 'node:module';
import type { RgbImage } from './pipeline';

/** Electron `nativeImage` 的最小结构（这里只用得上这仨方法）。 */
interface NativeImageLike {
  isEmpty(): boolean;
  toBitmap(): Buffer;
  getSize(): { width: number; height: number };
}

interface ElectronLike {
  nativeImage: {
    createFromBuffer(bytes: Buffer): NativeImageLike;
    createFromDataURL(url: string): NativeImageLike;
  };
}

let cachedElectron: ElectronLike | null = null;

/** 运行时取 electron（懒加载 + 只取一次；见文件头那段说明）。 */
function electron(): ElectronLike {
  cachedElectron ??= createRequire(import.meta.url)('electron') as ElectronLike;
  return cachedElectron;
}

/** 解码一份图片字节（jpg / png / …）；解不开返回 null。 */
export function decodeImageBytes(bytes: Buffer): RgbImage | null {
  return toRgb(electron().nativeImage.createFromBuffer(bytes));
}

/** 解码一个 `data:` URL（剪贴板截图之类）。 */
export function decodeImageDataUrl(url: string): RgbImage | null {
  return toRgb(electron().nativeImage.createFromDataURL(url));
}

function toRgb(image: NativeImageLike): RgbImage | null {
  if (image.isEmpty()) return null;
  const bitmap = image.toBitmap();
  const size = image.getSize();
  const height = size.height;
  let width = size.width;
  // 带 scale factor 的图（@2x）：getSize() 给的是逻辑尺寸，位图是物理尺寸 ——
  // 用位图长度反推真实宽度，免得坐标整体差一倍。
  if (height > 0 && bitmap.length % (4 * height) === 0) width = bitmap.length / (4 * height);
  if (width <= 0 || height <= 0 || bitmap.length < width * height * 4) return null;

  const data = new Uint8Array(width * height * 3);
  for (let i = 0, j = 0; i < width * height; i += 1) {
    const b = bitmap[i * 4]!;
    const g = bitmap[i * 4 + 1]!;
    const r = bitmap[i * 4 + 2]!;
    const a = bitmap[i * 4 + 3]!;
    if (a === 255) {
      data[j] = r;
      data[j + 1] = g;
      data[j + 2] = b;
    } else {
      // nativeImage 给的是**预乘 alpha** 的 BGRA：直接当 RGB 用会让透明 PNG 变黑，
      // 这里先还原再压到白底（比黑底更接近用户看到的「白底截图」）。
      data[j] = Math.min(255, (r * 255) / a + (255 - a));
      data[j + 1] = Math.min(255, (g * 255) / a + (255 - a));
      data[j + 2] = Math.min(255, (b * 255) / a + (255 - a));
    }
    j += 3;
  }
  return { width, height, data };
}
