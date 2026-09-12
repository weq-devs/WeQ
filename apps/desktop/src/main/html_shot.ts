/**
 * HTML → PNG 截图 —— Electron-only。
 *
 * 年度报告的四份产物现在共用同一份自包含 HTML（见 renderer 的 exportHtml）：
 * HTML / PDF 直接落盘，长图与 QQ 空间分享图则在这里把每个 `.slide` 截成 PNG。
 * 走真实浏览器排版，不再手搓 satori 的 SVG 元素树 —— 渐变、变换、字体与屏幕版
 * 完全一致，也不会出现「大图缩进小框」那类裁剪问题。
 *
 * 截图窗口是**隐藏**的，隐藏窗口的合成帧会被合并 / 延迟，所以这里不能「滚动完
 * 睡一觉就截」：那样拿到的经常还是上一页的旧帧（长图 / 分享图里同一页出现两次、
 * 页面互相错位都是这个原因）。现在的流程是：
 *
 *   1. 先按缩放把窗口调到「一页正好铺满视口」，量实际内容区；
 *     窗口被系统压小（请求 1587×2245 只拿到 1366×740 是常态）就降缩放，
 *     宁可分辨率低一点，也不能只截半页；
 *   2. 每次截图前：滚到目标页 → 跨两帧 → 量残差补一次滚动 → `invalidate()`
 *      强制重绘 → 反复截图直到**连续两帧像素完全一致**。
 *
 * 拼接长图时按每张位图的真实尺寸算行跨距，不再假设「像素高 == DIP 高」——
 * 高 DPI 屏幕上这两个数不相等，按假设硬拼会把画面撕成斜条纹。
 *
 * 复用 link_shot / annual_report_pdf 的隔离窗口范式：不可见、沙箱、无 preload、
 * `setWindowOpenHandler` 一律 deny。本模块只能被桌面侧引用（经
 * `apps/desktop/src/main/host.ts` 注入），不能出现在共享 router 的静态依赖里。
 */

import { BrowserWindow, nativeImage, type NativeImage } from 'electron';
import { loadIsolatedHtml } from './html_load';

/** 加载 + 字体就绪的硬超时：无论成功与否都不把窗口留在后台。 */
const LOAD_TIMEOUT_MS = 15_000;
/** 每轮等待：滚动/重排之后给合成器留一口气。 */
const SETTLE_MS = 60;
/** 「连续两帧一致」的最大轮数：约 8 × 60ms ≈ 480ms，仍不一致就按最后一帧交付。 */
const SETTLE_MAX_ROUNDS = 8;
/** 等 rAF 的硬超时：页面完全不出帧时不能让导出挂死在 promise 上。 */
const RAF_TIMEOUT_MS = 200;
/** 长图整体很宽很扁，超采样倍数收一档，避免几百 MB 的位图缓冲。 */
const LONG_SCALE = 1.5;
/** 分享图一次最多九张，超采样到 2× 足够清晰。 */
const SHARE_SCALE = 2;
/** 缩放兜底下限：只防除零 / 退化，正常绝不会降到这么低。 */
const MIN_CAPTURE_SCALE = 0.1;
/** BrowserWindow 内容区的尺寸上限（各 OS 不同，这里取一个保守值）。 */
const MAX_CONTENT_SIDE = 16_000;

/**
 * 截图前注入的覆盖样式。
 *
 * 导出 HTML 自带一层 `@media screen` 的「屏上浏览」样式：纸面居中留白 + 入场
 * 动画（`.slide` 初始 `opacity: 0`，要靠 IntersectionObserver 翻到才显形）。
 * 截图窗口就在 screen 媒体下，不把这些收平的话截出来要么偏移、要么空白。
 * 顺带关掉平滑滚动 —— 一旦滚动被平滑动画接管，截图就会在滚动途中抓到半页或
 * 上一页，这正是分享图「错位、重复」的来源之一。
 */
const CAPTURE_CSS = `
  @media screen {
    body { display: block !important; gap: 0 !important; padding: 0 !important; align-items: stretch !important; }
    .slide { opacity: 1 !important; transform: none !important; box-shadow: none !important; margin: 0 !important; }
  }
  html { scroll-behavior: auto !important; overflow-anchor: none !important; }
`;

type SlideSize = { width: number; height: number };
type CaptureRect = { x: number; y: number; width: number; height: number };
/** 一页截图的成品：位图 + 它的真实像素尺寸（长图拼接按这个算行跨距）。 */
type CapturedPage = { image: NativeImage; bitmap: Buffer; width: number; height: number };

export type HtmlShotOptions = {
  /** 只截这些下标（0-based，按文档顺序）；省略 = 全部。 */
  indexes?: number[];
  /** 追加进每一张被截页面内部的 HTML（分享壳：头像行 + 署名声）。 */
  overlayHtml?: string;
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 等到「下一帧画完之后」再返回。窗口不出帧时超时放行，不阻塞导出。 */
async function nextFrame(win: BrowserWindow): Promise<void> {
  const painted = win.webContents
    .executeJavaScript(`new Promise(function (resolve) {
      requestAnimationFrame(function () {
        requestAnimationFrame(function () { resolve(true); });
      });
    })`)
    .catch(() => true);
  await Promise.race([painted, delay(RAF_TIMEOUT_MS)]);
}

/**
 * 在隔离隐藏窗口里加载 HTML，注入覆盖样式，等字体与图片落位。调用方负责 destroy。
 *
 * 窗口尺寸先给一个够放下单页的默认值，量到真实页宽高后再由 {@link prepareCapture}
 * 按超采样倍数调 `setContentSize`。`backgroundThrottling: false` —— 隐藏窗口默认
 * 会被降频，截图会拿到没画完的一帧。
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
    const loaded = loadIsolatedHtml(win, html).catch(() => {});
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
    await nextFrame(win);
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
 * 把窗口调成「一页正好铺满视口」的截图环境，返回实际可用的缩放与截图矩形。
 *
 * 窗口 / 内容区尺寸可能被系统或窗口管理器压到屏幕以内，所以拿到实际内容区之后再
 * 定缩放：`缩放 ≤ 内容区高 / 页高` 才能保证一页完整入镜。截图矩形严格取「一页」
 * 的 DIP 尺寸（而不是整个视口），这样即使视口比一页略高，也不会把下一页的纸边
 * 截进来。
 */
async function prepareCapture(
  win: BrowserWindow,
  base: SlideSize,
  scale: number,
): Promise<CaptureRect> {
  win.webContents.setZoomFactor(scale);
  win.setContentSize(
    Math.min(Math.round(base.width * scale), MAX_CONTENT_SIDE),
    Math.min(Math.round(base.height * scale), MAX_CONTENT_SIDE),
  );
  win.webContents.invalidate();
  await nextFrame(win);
  await delay(SETTLE_MS);

  let content = contentSize(win);
  // 一页都放不下就降缩放：宁可分辨率低一点，也不能截半页 / 把下一页截进来。
  // 乘 0.995 留一点余量，免得 DIP 取整后差零点几像素。
  const fit = Math.min(
    content.width / (base.width * scale),
    content.height / (base.height * scale),
    1,
  );
  if (fit < 1) {
    // 完整的一页 > 分辨率：窗口再小也让整页入镜，只是图小一点。
    const lowered = Math.max(scale * fit * 0.995, MIN_CAPTURE_SCALE);
    if (lowered < scale) {
      scale = lowered;
      win.webContents.setZoomFactor(scale);
      win.webContents.invalidate();
      await nextFrame(win);
      await delay(SETTLE_MS);
      content = contentSize(win);
    }
  }

  return {
    x: 0,
    y: 0,
    width: Math.min(Math.round(base.width * scale), content.width),
    height: Math.min(Math.round(base.height * scale), content.height),
  };
}

/** 当前窗口内容区尺寸（DIP）。`getContentSize()` 的返回是数组，缺位按 0 兜底。 */
function contentSize(win: BrowserWindow): SlideSize {
  const [width = 0, height = 0] = win.getContentSize();
  return { width, height };
}

/** 把第 `index` 张 `.slide` 顶边对齐到视口顶边，并确认滚动真的落位。 */
async function scrollSlideToTop(win: BrowserWindow, index: number): Promise<void> {
  const found = (await win.webContents.executeJavaScript(`(function () {
    var el = document.querySelectorAll('.slide')[${index}];
    if (!el) return false;
    el.scrollIntoView({ block: 'start', inline: 'start', behavior: 'auto' });
    return true;
  })()`)) as boolean;
  if (!found) throw new Error(`截图页码越界：第 ${index + 1} 页`);
  await nextFrame(win);
  // 297mm 换算成 CSS px 是小数，滚动位置取整后顶边会差零点几像素；量残差补一次。
  await win.webContents
    .executeJavaScript(`(function () {
      var el = document.querySelectorAll('.slide')[${index}];
      if (!el) return true;
      var drift = el.getBoundingClientRect().top;
      if (Math.abs(drift) > 0.5) window.scrollBy(0, drift);
      return true;
    })()`)
    .catch(() => true);
}

/**
 * 抖一下滚动并原样弹回：隐藏窗口被系统判定为「遮挡」时合成器会停帧，一次真实
 * 的滚动能让它重新出帧。位置先存后还，不留下几像素的偏移。
 */
async function nudgeRepaint(win: BrowserWindow): Promise<void> {
  await win.webContents
    .executeJavaScript(`(function () {
      var y = window.scrollY;
      window.scrollBy(0, 2);
      window.scrollBy(0, -2);
      window.scrollTo(0, y);
      return true;
    })()`)
    .catch(() => true);
  win.webContents.invalidate();
}

/**
 * 截一帧「定格」的图：先跨两帧、强制重绘，再反复截图直到连续两次像素完全一致。
 *
 * 隐藏窗口的合成帧会被合并 / 延迟，固定 sleep 之后直接 `capturePage` 很容易拿到
 * 上一页的旧帧 —— 同一页出现两次、两页内容互相串位都是这么来的。连续两帧一致
 * 才算滚动、布局、字体与图片重绘全部落定。
 *
 * `avoid` 是上一页截下来的位图：相邻两页绝不可能像素完全相同，所以等于它的一
 * 帧必定是旧帧，哪怕它自己连续两帧都一样也不收 —— 那种情况说明窗口彻底停帧了，
 * 先抖一下把它唤醒。一定轮数内仍不稳定就交付最后一帧，不让整次导出失败。
 */
async function captureSettledFrame(
  win: BrowserWindow,
  rect: CaptureRect,
  avoid?: Buffer,
): Promise<NativeImage> {
  win.webContents.invalidate();
  await nextFrame(win);
  await delay(SETTLE_MS);

  let frame = await win.webContents.capturePage(rect);
  let bitmap = frame.toBitmap();
  for (let round = 0; round < SETTLE_MAX_ROUNDS; round += 1) {
    const stale = avoid != null && bitmap.equals(avoid);
    if (stale) await nudgeRepaint(win);
    else win.webContents.invalidate();
    await delay(SETTLE_MS);
    const next = await win.webContents.capturePage(rect);
    const nextBitmap = next.toBitmap();
    if (!stale && nextBitmap.equals(bitmap)) return next;
    frame = next;
    bitmap = nextBitmap;
  }
  return frame;
}

/** 截第 `index` 页（先叠分享壳、再对齐、最后取一帧定格的图）。 */
async function captureSlide(
  win: BrowserWindow,
  rect: CaptureRect,
  index: number,
  overlayHtml?: string,
  avoidBitmap?: Buffer,
): Promise<CapturedPage> {
  if (overlayHtml) {
    await win.webContents
      .executeJavaScript(`(function () {
        var el = document.querySelectorAll('.slide')[${index}];
        if (!el || el.querySelector('.weq-shot-share')) return true;
        var host = document.createElement('div');
        host.innerHTML = ${JSON.stringify(overlayHtml)};
        while (host.firstChild) el.appendChild(host.firstChild);
        return true;
      })()`)
      .catch(() => true);
  }
  await scrollSlideToTop(win, index);
  const image = await captureSettledFrame(win, rect, avoidBitmap);
  if (image.isEmpty()) throw new Error(`第 ${index + 1} 页截图失败`);
  const size = image.getSize();
  return { image, bitmap: image.toBitmap(), width: size.width, height: size.height };
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
    const rect = await prepareCapture(win, base, SHARE_SCALE);
    const out: Buffer[] = [];
    // 上一张的位图：下一页若截出和它一模一样的一帧，就是窗口没重画的旧帧。
    let previous: Buffer | undefined;
    for (const index of indexes) {
      const page = await captureSlide(win, rect, index, opts.overlayHtml, previous);
      previous = page.bitmap;
      out.push(page.image.toPNG());
    }
    return out;
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
    const rect = await prepareCapture(win, base, LONG_SCALE);
    const pages: CapturedPage[] = [];
    // 上一页的位图：下一页若截出和它一模一样的一帧，就是窗口没重画的旧帧。
    let previous: Buffer | undefined;
    for (let index = 0; index < total; index += 1) {
      const page = await captureSlide(win, rect, index, undefined, previous);
      previous = page.bitmap;
      pages.push(page);
    }
    const strip = composeStrip(pages);
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
 * 行跨距按**每张位图的真实像素尺寸**算：不同 DPR 下 `toBitmap()` 的像素数不等于
 * DIP 尺寸，用「请求高」当像素高会把画面撕成斜条纹（同一行错一位地往下滚）。
 * 顺带校验各页尺寸一致 —— 不一致说明窗口被压过，宁可明确报错也不拼出一张烂图。
 */
function composeStrip(pages: CapturedPage[]): { buffer: Buffer; width: number; height: number } {
  if (pages.length === 0) throw new Error('没有可拼接的页面');
  const { width, height } = pages[0]!;
  const rowBytes = width * 4;
  for (const page of pages) {
    if (page.width !== width || page.height !== height) {
      throw new Error('各页截图尺寸不一致，无法拼成长图');
    }
    if (page.bitmap.length < rowBytes * height) {
      throw new Error('截图位图尺寸异常，无法拼成长图');
    }
  }
  const buffer = Buffer.allocUnsafe(rowBytes * height * pages.length);
  pages.forEach((page, index) => {
    const base = index * height * rowBytes;
    for (let row = 0; row < height; row += 1) {
      page.bitmap.copy(buffer, base + row * rowBytes, row * rowBytes, (row + 1) * rowBytes);
    }
  });
  return { buffer, width, height: height * pages.length };
}
