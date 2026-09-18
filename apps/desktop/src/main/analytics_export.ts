/**
 * 分析卡片（群聊 / 私聊 / 成员）→ 长图 PNG，**在隐藏窗口里渲染并截取**。
 *
 * 为什么不是在用户窗口里抓：拍「视口之外」时，Chromium 会把页面的布局视口临时改成
 * 截图矩形的尺寸再渲染那一块 —— 这一帧同样会被合成到真实窗口上，于是用户看到整个
 * 界面闪一下（连 `captureBeyondViewport: false` 也一样，根因是 `clip` 而不是那个选项）。
 * 把渲染挪进一个**从不显示**的窗口后这件事就彻底不存在了：没有视口外区域、没有 clip、
 * 没有临时改视口，窗口天生「内容多大就多大」。
 *
 * 流程（全程在隐藏窗口里）：
 *   1. 可见窗口把数据随载荷递过来（`analytics-shot:render`）；
 *   2. 开隐藏窗口加载导出专用入口（`export.html`），它认领载荷、用同一批 React 组件把
 *      卡片渲染出来（840px 宽、不限高）；
 *   3. 等卡片挂载 + 高度连续几轮不变（字体、头像、词云、力图都会撑高它）；
 *   4. 把窗口内容区调到卡片尺寸 → `capturePage(整张卡片)` 一次成帧；
 *      系统把窗口压小了（平铺 WM / 屏幕限制）就按窗口高度**分段滚动拍**再拼起来 ——
 *      隐藏窗口里滚动没有任何可见影响，所以这套兜底是安全的；
 *   5. 在用户窗口上弹保存对话框、落盘，然后销毁隐藏窗口。
 *
 * 主进程不缓存任何东西，也不碰账号会话：载荷里只有卡片要显示的数据。
 */

import { BrowserWindow, dialog, ipcMain, nativeImage } from 'electron';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { is } from '@electron-toolkit/utils';
import type { AnalyticsExportPayload, AnalyticsExportResult } from '../shared/analytics_export';

// 主进程产物是 ESM，`__dirname` 这个全局并不存在（同 index.ts / transcribe/engine.ts）。
const moduleDir = dirname(fileURLToPath(import.meta.url));

/**
 * 从构建产物的路径里取一个文件。
 *
 * electron-vite 可能把这个模块拆成 `out/main/chunks/` 下的独立 chunk，那时 `moduleDir`
 * 就不是 `out/main` 了，相对路径得往上再找一层 —— 两个候选都试一遍（同 transcribe/engine.ts
 * 对 worker 的处理）。
 */
function outFile(relative: string): string {
  const candidates = [join(moduleDir, relative), join(moduleDir, '..', relative)];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]!;
}

/** 等导出入口加载出来。 */
const LOAD_TIMEOUT_MS = 15_000;
/** 等卡片渲染出来的硬超时。 */
const READY_TIMEOUT_MS = 25_000;
/** 轮询间隔。 */
const POLL_MS = 80;
/** 每次抓帧前的稳定等待。 */
const SETTLE_MS = 70;
/** 卡片高度连续多少轮不变才算落位。 */
const STABLE_ROUNDS = 3;
/** 内容区单边上限（超了就走分段）。 */
const MAX_CONTENT_SIDE = 16_000;
/** 导出宽度：屏幕上是弹窗宽度，导出时按长图口径铺开。 */
const EXPORT_WIDTH = 840;

/** 待认领的载荷：可见窗口递过来，导出窗口启动时领走。 */
let pendingPayload: AnalyticsExportPayload | null = null;
/** 同一时刻只跑一次导出：用户连点也不至于开一堆窗口。 */
let inFlight = false;

interface CardRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 文件名里的时间戳：20260918-1432。 */
function stamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(
    d.getMinutes(),
  )}`;
}

/** 文件名主体：去掉路径分隔符与控制字符，避免保存对话框报错。 */
function safeTitle(title: string): string {
  return (title || '分析').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);
}

/** 轻量校验：只挡住明显不是我们递过来的东西。 */
function sanitizePayload(value: unknown): AnalyticsExportPayload | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (raw.kind !== 'group' && raw.kind !== 'buddy' && raw.kind !== 'member') return null;
  if (typeof raw.title !== 'string' || typeof raw.label !== 'string') return null;
  return value as AnalyticsExportPayload;
}

/** 导出入口的地址：dev 走 vite 服务器，打包后走渲染产物目录。 */
async function loadExportEntry(win: BrowserWindow): Promise<void> {
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (is.dev && devUrl) {
    await win.loadURL(`${devUrl}/export.html`);
    return;
  }
  await win.loadFile(outFile('../renderer/export.html'));
}

/**
 * 开一个**从不显示**的导出窗口。
 *
 * 除了 `show: false`，还有三件事是必须的：`backgroundThrottling: false`（隐藏窗口默认
 * 会被降频，卡片可能根本不出帧）、`transparent: true` + 页面透明背景（卡片是圆角的，
 * 长图要保留透明角）、平铺 WM 下给一个非 `normal` 的窗口类型（与主窗口同样的规避，
 * 见 index.ts 的 WEQ_WINDOW_TYPE）。
 */
function createExportWindow(): BrowserWindow {
  const windowType =
    process.env.WEQ_WINDOW_TYPE ?? (process.platform === 'linux' ? 'toolbar' : undefined);
  const win = new BrowserWindow({
    width: EXPORT_WIDTH,
    height: 1200,
    show: false,
    frame: false,
    transparent: true,
    skipTaskbar: true,
    ...(windowType && windowType !== 'normal' ? { type: windowType } : {}),
    webPreferences: {
      preload: outFile('../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  return win;
}

/**
 * 导出窗口挂了没 / 卡片现在多大（由 export 入口挂在 `window.__weqExport` 上）。
 *
 * 除了它自己报的 ready，还要求**骨架屏已经消失** —— 载荷丢了的时候卡片会退回自己查询，
 * 这时候量到的尺寸是骨架屏的尺寸，拍下来就是一张占位图。
 */
async function probeCard(win: BrowserWindow): Promise<{ ready: boolean; rect: CardRect | null }> {
  const found = (await win.webContents
    .executeJavaScript(
      `(function () {
         var api = window.__weqExport;
         if (!api) return null;
         return {
           ready: api.ready === true && !document.querySelector('.ga-skeleton'),
           rect: typeof api.measure === 'function' ? api.measure() : null,
         };
       })()`,
    )
    .catch(() => null)) as { ready: boolean; rect: CardRect | null } | null;
  return found ?? { ready: false, rect: null };
}

/** 等卡片渲染出来（导出窗口说 ready，并且量得到一张有尺寸的卡片）。 */
async function waitForCard(win: BrowserWindow): Promise<CardRect> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (win.isDestroyed()) throw new Error('导出窗口已关闭');
    const { ready, rect } = await probeCard(win);
    if (ready && rect && rect.width > 0 && rect.height > 0) return rect;
    await delay(POLL_MS);
  }
  throw new Error('分析卡片渲染超时');
}

/** 等卡片高度连续几轮不变（图片、词云、力图都会撑高它），返回稳定后的矩形。 */
async function waitForStableCard(win: BrowserWindow, seed: CardRect): Promise<CardRect> {
  let last = Math.round(seed.height);
  let stable = 0;
  for (let i = 0; i < 50 && stable < STABLE_ROUNDS; i += 1) {
    await delay(POLL_MS);
    const { rect } = await probeCard(win);
    const height = rect ? Math.round(rect.height) : 0;
    stable = height > 0 && height === last ? stable + 1 : 0;
    last = height;
  }
  const { rect } = await probeCard(win);
  return rect ?? seed;
}

/** 让页面滚到指定位置并确认落位（隐藏窗口里滚动没有任何可见影响）。 */
async function scrollTo(win: BrowserWindow, y: number): Promise<void> {
  await win.webContents
    .executeJavaScript(
      `(function () {
         var target = ${Math.round(y)};
         window.scrollTo(0, target);
         var drift = target - window.scrollY;
         if (Math.abs(drift) > 0.5) window.scrollBy(0, drift);
         return window.scrollY;
       })()`,
    )
    .catch(() => 0);
  await delay(SETTLE_MS);
}

/**
 * 把等宽的若干段位图竖向拼成一张（BGRA 原始像素往返无损）。
 *
 * 行跨距按**每张位图的真实像素尺寸**算：高 DPI 下 `capturePage` 的位图像素数不等于
 * DIP 尺寸，按 DIP 硬拼会把画面撕成斜条纹（沿用 html_shot.ts 的同一条经验）。
 */
function composeVertical(pages: Array<{ bitmap: Buffer; dipHeight: number }>): Buffer {
  const first = pages[0];
  if (!first) throw new Error('没有可拼接的截图');
  const rowBytes = first.bitmap.length / Math.round(first.dipHeight);
  if (!Number.isFinite(rowBytes) || rowBytes <= 0 || rowBytes % 4 !== 0) {
    throw new Error('截图位图尺寸异常，无法拼成长图');
  }
  const pageRows: Buffer[] = [];
  for (const page of pages) {
    const rows = Math.round(page.bitmap.length / rowBytes);
    pageRows.push(page.bitmap.subarray(0, rows * rowBytes));
  }
  return Buffer.concat(pageRows);
}

/**
 * 抓整张卡片：窗口够高就一次成帧，否则按窗口高度分段滚动拍再拼。返回可落盘的 PNG。
 */
async function captureCard(win: BrowserWindow, card: CardRect): Promise<Buffer> {
  const [contentWidth = 0, contentHeight = 0] = win.getContentSize();
  const cardWidth = Math.round(card.width);
  const cardHeight = Math.round(card.height);

  win.webContents.invalidate();
  await delay(SETTLE_MS);

  if (contentWidth >= cardWidth && contentHeight >= cardHeight) {
    const image = await win.webContents.capturePage({
      x: Math.round(card.x),
      y: Math.round(card.y),
      width: cardWidth,
      height: cardHeight,
    });
    if (image.isEmpty()) throw new Error('截图为空');
    return image.toPNG();
  }

  // 兜底：窗口被系统压小了。分段滚动拍 —— 隐藏窗口里滚动没有可见影响。
  const bandHeight = Math.max(1, Math.min(contentHeight, cardHeight));
  const pages: Array<{ bitmap: Buffer; dipHeight: number }> = [];
  for (let y = 0; y < cardHeight; y += bandHeight) {
    const height = Math.min(bandHeight, cardHeight - y);
    await scrollTo(win, y);
    win.webContents.invalidate();
    await delay(SETTLE_MS);
    const image = await win.webContents.capturePage({
      x: Math.round(card.x),
      y: 0,
      width: cardWidth,
      height,
    });
    if (image.isEmpty()) throw new Error('截图为空');
    pages.push({ bitmap: image.toBitmap(), dipHeight: height });
  }

  const first = pages[0];
  if (!first) throw new Error('没有可拼接的截图');
  const rows = pages[0]!.bitmap.length / 4 / Math.round(pages[0]!.dipHeight);
  if (!Number.isFinite(rows) || rows <= 0) throw new Error('截图位图尺寸异常');
  if (pages.length === 1) {
    return nativeImage
      .createFromBitmap(first.bitmap, { width: Math.round(rows), height: cardHeight })
      .toPNG();
  }
  const height = pages.reduce((sum, page) => sum + Math.round(page.dipHeight), 0);
  return nativeImage
    .createFromBitmap(composeVertical(pages), { width: Math.round(rows), height })
    .toPNG();
}

/** 在发起导出的那个窗口上弹保存框并落盘。 */
async function saveCard(
  owner: BrowserWindow | null,
  png: Buffer,
  payload: AnalyticsExportPayload,
): Promise<AnalyticsExportResult> {
  const options: Electron.SaveDialogOptions = {
    defaultPath: `${payload.label}_${safeTitle(payload.title)}_${stamp()}.png`,
    filters: [{ name: 'PNG 图片', extensions: ['png'] }],
  };
  const result =
    owner && !owner.isDestroyed()
      ? await dialog.showSaveDialog(owner, options)
      : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return { saved: false, canceled: true };
  await fs.promises.writeFile(result.filePath, png);
  return { saved: true, path: result.filePath };
}

/** 跑一次完整导出：开隐藏窗口 → 渲染 → 抓图 → 保存 → 收窗口。 */
async function runExport(
  payload: AnalyticsExportPayload,
  owner: BrowserWindow | null,
): Promise<AnalyticsExportResult> {
  if (inFlight) return { saved: false, error: '上一张还在导出中' };
  inFlight = true;
  pendingPayload = payload;
  let win: BrowserWindow | null = null;
  try {
    win = createExportWindow();
    await Promise.race([loadExportEntry(win).catch(() => {}), delay(LOAD_TIMEOUT_MS)]);
    if (win.isDestroyed()) throw new Error('导出窗口已关闭');

    const card = await waitForStableCard(win, await waitForCard(win));

    // 让窗口正好放下整张卡片（宽度也按卡片给，免得出现横向滚动条）。
    win.setContentSize(
      Math.min(Math.round(card.width), MAX_CONTENT_SIDE),
      Math.min(Math.round(card.height), MAX_CONTENT_SIDE),
    );
    win.webContents.invalidate();
    await delay(SETTLE_MS);
    const settled = await waitForStableCard(win, card);

    return await saveCard(owner, await captureCard(win, settled), payload);
  } catch (error) {
    return { saved: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    pendingPayload = null;
    inFlight = false;
    if (win && !win.isDestroyed()) win.destroy();
  }
}

export function registerAnalyticsExportIpc(): void {
  /** 可见窗口：把卡片数据递过来，拿到含保存对话框的结果。 */
  ipcMain.handle('analytics-shot:render', async (event, payload: unknown) => {
    const clean = sanitizePayload(payload);
    if (!clean) return { saved: false as const, error: '导出参数无效' };
    return runExport(clean, BrowserWindow.fromWebContents(event.sender));
  });

  /** 导出窗口：认领待渲染的载荷。 */
  ipcMain.handle('analytics-shot:claim', () => pendingPayload);
}
