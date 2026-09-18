/**
 * 把分析卡片（群聊 / 私聊 / 成员）存成一张长图 PNG。
 *
 * 思路：**不重排 HTML，直接抓屏幕上那张卡片**。
 *
 * 年度报告那种「渲染一份自包含 HTML 再截图」的做法在这里不划算 —— 分析卡片是活
 * DOM：SVG 甜甜圈、canvas 量过的词云、外链头像、主题 CSS 变量。重排一份等于把整
 * 套视觉再实现一遍，还必然慢慢和屏幕版跑偏。
 *
 * 于是改成：卡片本来就摊在屏幕上 → 逐屏滚动 + `capturePage(rect)` 抓帧 → 在
 * canvas 里竖向拼起来。所见即所得，主题、隐私遮罩、头像全都天然一致。
 *
 * 三个必须处理好的细节：
 *   1. **滚动容器**：卡片 header 不滚、body 滚。header 单独抓一帧，body 按
 *      clientHeight 逐屏抓，最后按 scrollTop 落位拼接；
 *   2. **抓帧时机**：改完滚动位置必须等两帧 + 一点余量，否则抓到的是上一屏
 *      （隐藏窗口那套「连续两帧一致」在这里不必要 —— 窗口是可见的，合成器正常出帧）；
 *   3. **导出态布局**：`weq-shot-mode` 把卡片放宽（热力图那 53 周横向滚动条在窄卡
 *      片里会被截掉半年），并关掉过渡动画，出图更整齐。
 */

/** 抓帧后等这么久（毫秒）：跨两帧 + 合成器余量。 */
const SETTLE_MS = 90;
/** 导出态下等布局重排（词云按新宽度重新量词）的时间。 */
const RELAYOUT_MS = 260;

export interface AnalyticsShotResult {
  saved: boolean;
  canceled?: boolean;
  path?: string;
  error?: string;
}

interface CaptureBridge {
  capture(rect: { x: number; y: number; width: number; height: number }): Promise<{
    ok: boolean;
    dataUrl?: string;
    width?: number;
    height?: number;
    error?: string;
  }>;
  save(
    dataUrl: string,
    defaultName: string,
  ): Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 跨两帧再等一点 —— 滚动 / 重排之后让合成器把新的一帧画出来。 */
async function settle(ms = SETTLE_MS): Promise<void> {
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
  await delay(ms);
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('抓到的画面无法解码'));
    img.src = dataUrl;
  });
}

/**
 * 导出用的滚动宿主：卡片里真正滚动的那个 div（`.ga-body` / `.ba-body`）。
 * 找不到就退回卡片本身（短卡片不滚动，一屏就够）。
 */
function scrollHostOf(dialog: HTMLElement): HTMLElement {
  const host = dialog.querySelector<HTMLElement>('.group-album-body');
  if (host && host.scrollHeight > host.clientHeight + 1) return host;
  return dialog;
}

/**
 * 把一个可滚动卡片抓到一张 canvas 上（尺寸 = 卡片 CSS 尺寸 × 屏幕缩放）。
 * 失败一律抛 Error，交给调用方提示。
 */
async function captureCard(bridge: CaptureBridge, root: HTMLElement): Promise<HTMLCanvasElement> {
  const host = scrollHostOf(root);
  const hostScrolls = host !== root;
  // header = 卡片里不参与滚动的那部分（滚动宿主之前的兄弟节点）。
  const header = hostScrolls ? (host.previousElementSibling as HTMLElement | null) : null;

  const prevScrollTop = host.scrollTop;
  const hidden: Array<{ el: HTMLElement; prev: string }> = [];
  const shotMode = !root.classList.contains('weq-shot-mode');
  if (shotMode) root.classList.add('weq-shot-mode');
  // 关掉过渡 / 动画，免得抓帧抓到半截动画。
  for (const el of root.querySelectorAll<HTMLElement>('[data-shot-hide]')) {
    hidden.push({ el, prev: el.style.visibility });
    el.style.visibility = 'hidden';
  }

  try {
    host.scrollTop = 0;
    await settle(shotMode ? RELAYOUT_MS : SETTLE_MS);

    const headRect = header?.getBoundingClientRect() ?? null;
    const hostRect = host.getBoundingClientRect();
    if (hostRect.width <= 0 || hostRect.height <= 0) throw new Error('卡片还没渲染出来');

    const shots: Array<{ img: HTMLImageElement; y: number; height: number }> = [];
    let scale = 1;
    let offsetY = 0;

    const grab = async (rect: DOMRect, y: number, height: number) => {
      const res = await bridge.capture({
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: Math.max(1, Math.round(height)),
      });
      if (!res.ok || !res.dataUrl) throw new Error(res.error ?? '抓帧失败');
      const img = await loadImage(res.dataUrl);
      if (scale === 1 && res.width) scale = res.width / hostRect.width;
      shots.push({ img, y, height });
    };

    if (headRect && headRect.height > 0) {
      offsetY = headRect.height;
      await grab(headRect, 0, headRect.height);
    }

    const viewH = host.clientHeight;
    const totalH = host.scrollHeight;
    for (let y = 0; y < totalH; y += viewH) {
      const position = Math.min(y, Math.max(totalH - viewH, 0));
      host.scrollTop = position;
      await settle();
      const rect = host.getBoundingClientRect();
      const drawH = Math.min(viewH, totalH - y);
      // 只画这一屏里属于 [y, y+drawH) 的那一段。
      const res = await bridge.capture({
        x: rect.left,
        y: rect.top + (y - position),
        width: rect.width,
        height: Math.max(1, Math.round(drawH)),
      });
      if (!res.ok || !res.dataUrl) throw new Error(res.error ?? '抓帧失败');
      const img = await loadImage(res.dataUrl);
      if (res.width) scale = res.width / rect.width;
      shots.push({ img, y: offsetY + y, height: drawH });
    }

    const width = Math.round(hostRect.width * scale);
    const height = Math.round((offsetY + totalH) * scale);
    if (width <= 0 || height <= 0) throw new Error('卡片尺寸异常');
    if (height > 30000) throw new Error('卡片太长，超出单张图片上限');

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建绘图上下文');
    ctx.imageSmoothingQuality = 'high';
    const radius = Number.parseFloat(getComputedStyle(root).borderTopLeftRadius) || 0;
    if (radius > 0) {
      ctx.beginPath();
      ctx.roundRect(0, 0, width, height, radius * scale);
      ctx.clip();
    }
    for (const shot of shots) {
      const dy = Math.round(shot.y * scale);
      // 源图可能比目标段更高（最后一屏抓的是整屏），按需裁掉多余部分。
      const sh = Math.min(shot.img.height, Math.round(shot.height * scale));
      ctx.drawImage(shot.img, 0, 0, shot.img.width, sh, 0, dy, width, sh);
    }
    return canvas;
  } finally {
    host.scrollTop = prevScrollTop;
    if (shotMode) root.classList.remove('weq-shot-mode');
    for (const { el, prev } of hidden) el.style.visibility = prev;
  }
}

/** 文件名里的时间戳：20260918-1432。 */
function stamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(
    d.getMinutes(),
  )}`;
}

/**
 * 导出入口：抓图 → 弹保存对话框落盘。
 * `root` 传卡片根节点（`.ga-dialog` / `.ba-dialog`），标题用于默认文件名。
 */
export async function exportAnalyticsCard(opts: {
  root: HTMLElement | null;
  title: string;
  /** 默认文件名前缀，如「群聊分析」。 */
  label: string;
}): Promise<AnalyticsShotResult> {
  const bridge = (window as { weq?: { analyticsShot?: CaptureBridge } }).weq?.analyticsShot;
  if (!bridge) return { saved: false, error: '当前环境不支持保存图片' };
  if (!opts.root) return { saved: false, error: '找不到要导出的卡片' };
  try {
    const canvas = await captureCard(bridge, opts.root);
    const safe = (opts.title || '分析').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);
    const res = await bridge.save(
      canvas.toDataURL('image/png'),
      `${opts.label}_${safe}_${stamp()}.png`,
    );
    if (!res.ok) return { saved: false, error: res.error ?? '保存失败' };
    if (res.canceled) return { saved: false, canceled: true };
    return { saved: true, path: res.path };
  } catch (error) {
    return { saved: false, error: error instanceof Error ? error.message : String(error) };
  }
}
