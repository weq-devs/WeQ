/**
 * HTML → PNG 截图 —— Electron-only。
 *
 * 年度报告的四份产物现在共用同一份自包含 HTML（见 renderer 的 exportHtml）：
 * HTML / PDF 直接落盘，长图与 QQ 空间分享图则在这里把每个 `.slide` 截成 PNG。
 * 走真实浏览器排版，不再手搓 satori 的 SVG 元素树 —— 渐变、变换、字体与屏幕版
 * 完全一致，也不会出现「大图缩进小框」那类裁剪问题。
 *
 * 复用 link_shot / annual_report_pdf 的隔离窗口范式：不可见、沙箱、无 preload、
 * `setWindowOpenHandler` 一律 deny。本模块只能被桌面侧引用（经
 * `apps/desktop/src/main/host.ts` 注入），不能出现在共享 router 的静态依赖里。
 */

import { BrowserWindow, nativeImage } from 'electron';

/** 加载 + 字体就绪的硬超时：无论成功与否都不把窗口留在后台。 */
const LOAD_TIMEOUT_MS = 15_000;
/** 滚动到某一页之后等一拍再截，避开重绘竞态。 */
const SETTLE_MS = 60;
/** 长图整体很宽很扁，超采样倍数收一档，避免几百 MB 的位图缓冲。 */
const LONG_SCALE = 1.5;
/** 分享图一次最多九张，超采样到 2× 足够清晰。 */
const SHARE_SCALE = 2;
/** BrowserWindow 内容区的尺寸上限（各 OS 不同，这里取一个保守值）。 */
const MAX_CONTENT_SIDE = 16_000;

/**
 * 截图前注入的覆盖样式。
 *
 * 导出 HTML 自带一层 `@media screen` 的「屏上浏览」样式：纸面居中留白 + 入场
 * 动画（`.slide` 初始 `opacity: 0`，要靠 IntersectionObserver 翻到才显形）。
 * 截图窗口就在 screen 媒体下，不把这些收平的话截出来要么偏移、要么空白。
 */
const CAPTURE_CSS = `
  @media screen {
    body { display: block !important; gap: 0 !important; padding: 0 !important; align-items: stretch !important; }
    .slide { opacity: 1 !important; transform: none !important; box-shadow: none !important; margin: 0 !important; }
  }
`;

type SlideSize = { width: number; height: number };

export type HtmlShotOptions = {
  /** 只截这些下标（0-based，按文档顺序）；省略 = 全部。 */
  indexes?: number[];
  /** 追加进每一张被截页面内部的 HTML（分享壳：头像行 + 署名声）。 */
  overlayHtml?: string;
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 在隔离隐藏窗口里加载 HTML，注入覆盖样式，等字体与图片落位。调用方负责 destroy。
 *
 * 窗口尺寸先给一个够放下单页的默认值，量到真实页宽高后再由调用方按超采样倍数
 * 调 `setContentSize`。`backgroundThrottling: false` —— 隐藏窗口默认会被降频，
 * 截图会拿到没画完的一帧。
 */
async function openWindow(html: string): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 900,
    height: 1300,
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: true,
      backgroundThrottling: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  try {
    const loaded = win
      .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
      .catch(() => {});
    await Promise.race([loaded, delay(LOAD_TIMEOUT_MS)]);
    if (win.isDestroyed()) throw new Error('截图窗口已被销毁');
    await win.webContents
      .executeJavaScript(`(function () {
        var style = document.createElement('style');
        style.textContent = ${JSON.stringify(CAPTURE_CSS)};
        document.head.appendChild(style);
        return true;
      })()`)
      .catch(() => true);
    // 字体与图片就位再量尺寸 / 截图，否则首帧缺字、头像空白。
    await win.webContents
      .executeJavaScript(
        `Promise.race([
           Promise.all([
             document.fonts.ready,
             Promise.all(Array.from(document.images).map(function (img) {
               return img.complete
                 ? true
                 : new Promise(function (r) {
                     img.addEventListener('load', r, { once: true });
                     img.addEventListener('error', r, { once: true });
                   });
             })),
           ]),
           new Promise(function (r) { setTimeout(r, 5000); }),
         ]).then(function () { return true; })`,
      )
      .catch(() => true);
    return win;
  } catch (error) {
    if (!win.isDestroyed()) win.destroy();
    throw error;
  }
}

/** 文档里第 0 张 `.slide` 的 CSS 像素尺寸；没有 `.slide` 直接抛。 */
async function measureSlide(win: BrowserWindow): Promise<SlideSize> {
  const size = (await win.webContents.executeJavaScript(`(function () {
    var slide = document.querySelector('.slide');
    if (!slide) return null;
    var rect = slide.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  })()`)) as SlideSize | null;
  if (!size || !(size.width > 0) || !(size.height > 0)) {
    throw new Error('导出 HTML 里没有可截图的 .slide 页面');
  }
  return size;
}

async function countSlides(win: BrowserWindow): Promise<number> {
  return (await win.webContents.executeJavaScript(
    "document.querySelectorAll('.slide').length",
  )) as number;
}

/**
 * 按超采样倍数截取指定页面。
 *
 * `zoomFactor` 让 Chromium 以更高分辨率重绘（矢量 / 文字依旧锐利），窗口内容区
 * 同步放大到「页宽 × 倍数」，这样可见区域恰好是一整页；逐页 scrollIntoView 后
 * 整窗截图，每张尺寸一致。
 */
async function captureSlides(
  win: BrowserWindow,
  base: SlideSize,
  scale: number,
  indexes: number[],
  overlayHtml?: string,
): Promise<Buffer[]> {
  const width = Math.min(Math.round(base.width * scale), MAX_CONTENT_SIDE);
  const height = Math.min(Math.round(base.height * scale), MAX_CONTENT_SIDE);
  win.webContents.setZoomFactor(scale);
  win.setContentSize(width, height);
  await delay(SETTLE_MS);

  const out: Buffer[] = [];
  for (const index of indexes) {
    const prepared = (await win.webContents.executeJavaScript(`(function () {
      var el = document.querySelectorAll('.slide')[${index}];
      if (!el) return false;
      if (!el.querySelector('.weq-shot-share')) {
        var host = document.createElement('div');
        host.innerHTML = ${JSON.stringify(overlayHtml ?? '')};
        while (host.firstChild) el.appendChild(host.firstChild);
      }
      el.scrollIntoView({ block: 'start', inline: 'start' });
      return true;
    })()`)) as boolean;
    if (!prepared) throw new Error(`分享的页面下标越界：${index}`);
    await delay(SETTLE_MS);
    const image = await win.webContents.capturePage({ x: 0, y: 0, width, height });
    if (image.isEmpty()) throw new Error(`第 ${index + 1} 页截图失败`);
    out.push(image.toPNG());
  }
  return out;
}

/** 把文档里的全部 `.slide` 逐页截成 PNG（按文档顺序）。 */
export async function renderHtmlToSlidesPng(
  html: string,
  opts: HtmlShotOptions = {},
): Promise<Buffer[]> {
  const win = await openWindow(html);
  try {
    const total = await countSlides(win);
    if (total <= 0) throw new Error('导出 HTML 里没有可截图的 .slide 页面');
    const indexes =
      opts.indexes && opts.indexes.length > 0
        ? opts.indexes
        : Array.from({ length: total }, (_, i) => i);
    const base = await measureSlide(win);
    return await captureSlides(win, base, SHARE_SCALE, indexes, opts.overlayHtml);
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

/**
 * 把文档里的全部 `.slide` 竖向无缝拼成一张长图 PNG。
 *
 * 不直接整页截图：十几页 A4 叠起来远超窗口尺寸上限。逐页截完在原生位图缓冲里
 * 逐行拼接 —— `toBitmap()` / `createFromBitmap()` 都是 BGRA 原始像素，往返无损。
 */
export async function renderHtmlToLongPng(html: string): Promise<Buffer> {
  const win = await openWindow(html);
  try {
    const total = await countSlides(win);
    if (total <= 0) throw new Error('导出 HTML 里没有可截图的 .slide 页面');
    const base = await measureSlide(win);
    const scale = LONG_SCALE;
    const width = Math.min(Math.round(base.width * scale), MAX_CONTENT_SIDE);
    const height = Math.min(Math.round(base.height * scale), MAX_CONTENT_SIDE);
    win.webContents.setZoomFactor(scale);
    win.setContentSize(width, height);
    await delay(SETTLE_MS);

    const rows: Buffer[] = [];
    for (let index = 0; index < total; index += 1) {
      const prepared = (await win.webContents.executeJavaScript(`(function () {
        var el = document.querySelectorAll('.slide')[${index}];
        if (!el) return false;
        el.scrollIntoView({ block: 'start', inline: 'start' });
        return true;
      })()`)) as boolean;
      if (!prepared) throw new Error(`第 ${index + 1} 页截图失败`);
      await delay(SETTLE_MS);
      const image = await win.webContents.capturePage({ x: 0, y: 0, width, height });
      if (image.isEmpty()) throw new Error(`第 ${index + 1} 页截图失败`);
      rows.push(image.toBitmap());
    }
    const strip = composeStrip(rows, height);
    return nativeImage
      .createFromBitmap(strip.buffer, { width: strip.width, height: strip.height })
      .toPNG();
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

/**
 * 把等宽的 BGRA 位图逐行拷进一张竖长缓冲。
 *
 * 宽度不直接用 `getSize()`：不同 DPR 下 `toBitmap()` 的像素数未必等于 DIP 尺寸，
 * 从位图实际长度反推行字节数最稳（高度是已知的每页像素高）。
 */
function composeStrip(
  rows: Buffer[],
  height: number,
): { buffer: Buffer; width: number; height: number } {
  if (rows.length === 0) throw new Error('没有可拼接的页面');
  const width = Math.round(rows[0]!.length / height / 4);
  const rowBytes = width * 4;
  const buffer = Buffer.allocUnsafe(rowBytes * height * rows.length);
  rows.forEach((bitmap, index) => {
    const base = index * height * rowBytes;
    for (let row = 0; row < height; row += 1) {
      bitmap.copy(buffer, base + row * rowBytes, row * rowBytes, (row + 1) * rowBytes);
    }
  });
  return { buffer, width, height: height * rows.length };
}
