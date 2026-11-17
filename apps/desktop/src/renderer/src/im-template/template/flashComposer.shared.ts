/**
 * 输入框「闪传」—— 把一组本地文件当**一条 QQ 闪传（fileset）消息**发出去。
 *
 * 与「发送文件」不是一回事：文件是普通消息的元素，闪传是一条 fileset 卡片（收端点开
 * 在闪传浏览弹窗里看文件清单，14 天有效、主文件后台传完）。所以这里也不走输入框的
 * 元素 token 通路 —— 与 Ark 面板同款：面板收齐文件 + 封面，交给应用层去发。
 *
 * 交互：
 *   1. 点工具栏那枚「闪传」→ 整块输入框变成落点：点一下开系统文件管理器，
 *      文件 / 文件夹也可以直接拖进来（文件夹递归展开），可多选；
 *   2. 选好点「确认」→ 弹一张灯箱卡片：封面预览 + 文件清单，封面可以自己换（≤ 1MB，
 *      PNG / JPEG 原图直通，不重绘不压缩）；
 *   3. 点「发送」→ 应用层走 fileset 协议（封面先就绪、主文件后台传）。
 *
 * 面板本身像语音条一样**内联进输入框**（占掉正文编辑区那一行，见
 * styles/flash-composer.css 的 `@media (min-width: 761px)` 段），不再是从输入框
 * 上沿弹出来的卡片；小屏装不下时仍是浮层。灯箱 `createPortal` 到 `document.body`：
 * `.composer` 上有 `backdrop-filter`，会把 `position: fixed` 的包含块拽成输入框那一格，
 * 挂在里面的话灯箱就永远贴在底部。
 *
 * 封面有两种来源：**默认封面**由渲染层用 canvas 拼（主进程没有 canvas）—— 拿
 * `resources/fileicon` 里的类型图标拼一张 480×270 的 PNG，`weq-asset://` 的图标先
 * fetch 成 blob 再画（blob 是同源，canvas 不会被污染），拿不到就退回「色块 + 扩展名」；
 * **用户自定义封面**原样直通 —— 只校验大小（≤ 1MB）与格式（PNG / JPEG），不做任何
 * 绘制 / 压缩 / 转码，字节原封不动交给主进程落盘上传。
 *
 * 面板自己不碰 trpc / 协议；样式见 styles/flash-composer.css，颜色全走主题 token。
 */

import { fileExtIcon } from '../../lib/groupFile';
import { fileIconUrl } from '../../lib/resourceUrl';
import { formatBytes } from '../../lib/format';

/** 待发送的一个文件（渲染层只知道路径 / 名字 / 大小；字节在主进程读）。 */
export interface FlashDraftFile {
  /** 本机绝对路径（`window.weq.pathForFile`）。 */
  path: string;
  name: string;
  size: number;
}

// ── 卡片 JSON（与真机 richui 同构，解析见 QqFlashTransfer.parseFlashTransfer）──────

/**
 * 拼一段「闪传」markdownContent —— 乐观渲染时用它现画一张卡片，形状与真机一致：
 * `[闪传](mqqapi://markdown/node?nodeType=richui&json=<url-encoded JSON>)`，
 * JSON 里 `attributes.attributes` 是 viewId → 属性的列表。
 */
export function buildFlashCardMarkdown(params: {
  title: string;
  desc: string;
  /** 封面（本地 data URL 或 CDN 地址）。 */
  coverUrl?: string;
  /** 已知的 fileset id；乐观渲染时还不知道就给空串（点开时会提示缺少 id）。 */
  filesetId?: string;
}): string {
  const nodes: Record<string, unknown>[] = [{ viewId: 'title', text: params.title }];
  if (params.coverUrl) nodes.push({ viewId: 'image', src: params.coverUrl });
  nodes.push({ viewId: 'desc', text: params.desc });
  nodes.push({ viewId: 'tailText', text: 'QQ闪传' });
  if (params.filesetId) {
    nodes.push({ viewId: 'file', schema: `mqqrouter://flash?fileset_id=${params.filesetId}` });
  }
  const payload = { attributes: { attributes: nodes } };
  return `[闪传](mqqapi://markdown/node?nodeType=richui&json=${encodeURIComponent(
    JSON.stringify(payload),
  )})`;
}

/** 闪传卡片的人类可读描述行（`1.23 MB · 3 项 · 14 天后过期`）。 */
export function flashDescOf(files: { size: number }[], count = files.length): string {
  return `${formatBytes(files.reduce((sum, file) => sum + (file.size || 0), 0))} · ${count} 项 · 14 天后过期`;
}

/**
 * 乐观渲染的一条闪传消息元素（`{type:'markdown', data}`，与真实消息的 `qqElements`
 * 同形 —— 走与真消息**同一条渲染通路**，所以卡片长得一模一样）。
 */
export function buildFlashOptimisticElement(params: {
  title: string;
  desc: string;
  coverUrl?: string;
  fileBytes: number;
  filesetId?: string;
}): unknown {
  return {
    type: 'markdown',
    data: {
      markdownContent: buildFlashCardMarkdown({
        title: params.title,
        desc: params.desc,
        ...(params.coverUrl ? { coverUrl: params.coverUrl } : {}),
        ...(params.filesetId ? { filesetId: params.filesetId } : {}),
      }),
      markdownTextSummary: '[QQ闪传]',
      flashTransferInfo: {
        fileSetId: params.filesetId ?? '',
        fileBytes: params.fileBytes,
        createTime: Math.floor(Date.now() / 1000),
      },
    },
  };
}

// ── 封面合成（canvas）──────────────────────────────────────────────────────────

const COVER_W = 480;
const COVER_H = 270;

function themeColors(): {
  bg: string;
  fg: string;
  muted: string;
  accent: string;
  line: string;
} {
  if (typeof document === 'undefined') {
    return { bg: '#ffffff', fg: '#111111', muted: '#858585', accent: '#0099ff', line: '#dedede' };
  }
  const style = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string): string =>
    style.getPropertyValue(name).trim() || fallback;
  return {
    bg: read('--popover', '#ffffff'),
    fg: read('--weq-fg-primary', '#111111'),
    muted: read('--weq-fg-muted', '#858585'),
    accent: read('--weq-accent-effective', '#0099ff'),
    line: read('--im-color-line', '#dedede'),
  };
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = src;
  });
}

/**
 * 拿 `resources/fileicon` 里的一枚图标。
 *
 * 先 fetch 成 blob 再画：直接把 `weq-asset://` 塞进 `<img>` 再画进 canvas 会污染画布
 * （另一个源），`toDataURL()` 会直接抛 SecurityError；blob 是同源的，没有这个问题。
 * fetch 不通（自定义协议没开 CORS）就返回 null，由调用方退回色块画法。
 */
async function loadIconImage(fileName: string): Promise<HTMLImageElement | null> {
  try {
    const response = await fetch(fileIconUrl(fileExtIcon(fileName)));
    if (!response.ok) return null;
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const image = await loadImage(url);
    URL.revokeObjectURL(url);
    return image;
  } catch {
    return null;
  }
}

/** 扩展名（大写，最多 4 个字符）；没有扩展名给 `FILE`。 */
function extLabel(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  const ext = dot >= 0 ? fileName.slice(dot + 1) : '';
  return (ext || 'FILE').slice(0, 4).toUpperCase();
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** 单个文件格的色块画法（没有图标资源时的兜底）。 */
function drawExtTile(
  ctx: CanvasRenderingContext2D,
  file: FlashDraftFile,
  x: number,
  y: number,
  size: number,
  colors: ReturnType<typeof themeColors>,
): void {
  ctx.fillStyle = `${colors.accent}1f`;
  roundRect(ctx, x, y, size, size, 14);
  ctx.fill();
  ctx.strokeStyle = `${colors.accent}33`;
  ctx.lineWidth = 1;
  roundRect(ctx, x + 0.5, y + 0.5, size - 1, size - 1, 14);
  ctx.stroke();
  ctx.fillStyle = colors.accent;
  ctx.font = `700 ${Math.round(size * 0.26)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(extLabel(file.name), x + size / 2, y + size / 2);
}

/**
 * 拼一张**默认**闪传封面（用户自定义封面走直通，不经过这里）。
 *
 * 最多 4 枚文件类型图标（`resources/fileicon`）2×2 摆开；fetch 图标失败 / canvas 被
 * 污染时退回「色块 + 扩展名」。
 * 返回 `data:image/png;base64,…`；连兜底都失败就给 null（调用方不带封面）。
 */
export async function composeFlashCover(files: FlashDraftFile[]): Promise<string | null> {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = COVER_W;
  canvas.height = COVER_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const colors = themeColors();

  // 底：主色很淡的一层斜向渐变 + 一层强调色光晕，深浅模式下都立得住。
  ctx.fillStyle = colors.bg;
  ctx.fillRect(0, 0, COVER_W, COVER_H);
  const glow = ctx.createRadialGradient(
    COVER_W * 0.82,
    COVER_H * 0.18,
    10,
    COVER_W * 0.82,
    COVER_H * 0.18,
    COVER_W * 0.75,
  );
  glow.addColorStop(0, `${colors.accent}2e`);
  glow.addColorStop(1, `${colors.accent}00`);
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, COVER_W, COVER_H);

  const shown = files.slice(0, 4);
  const icons = await Promise.all(shown.map((file) => loadIconImage(file.name)));
  const tile = files.length === 1 ? 160 : 116;
  const gap = files.length === 1 ? 0 : 22;
  const columns = shown.length > 1 ? 2 : 1;
  const rows = shown.length > 2 ? 2 : 1;
  const totalW = columns * tile + (columns - 1) * gap;
  const totalH = rows * tile + (rows - 1) * gap;
  const startX = (COVER_W - totalW) / 2;
  const startY = (COVER_H - totalH) / 2;

  for (let index = 0; index < shown.length; index++) {
    const file = shown[index]!;
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = startX + column * (tile + gap);
    const y = startY + row * (tile + gap);
    const icon = icons[index];
    if (icon) {
      // 图标格：淡淡的底板 + 居中图标（图标本身是彩色文件类型图）。
      ctx.fillStyle = `${colors.fg}0a`;
      roundRect(ctx, x, y, tile, tile, 16);
      ctx.fill();
      const inner = tile * 0.68;
      ctx.drawImage(icon, x + (tile - inner) / 2, y + (tile - inner) / 2, inner, inner);
    } else {
      drawExtTile(ctx, file, x, y, tile, colors);
    }
  }

  // 超过 4 个文件：右下角补一个 +N。
  if (files.length > shown.length) {
    const extra = `+${files.length - shown.length}`;
    ctx.fillStyle = colors.accent;
    ctx.font = '700 22px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText(extra, COVER_W - 18, COVER_H - 16);
  }

  try {
    return canvas.toDataURL('image/png');
  } catch {
    // 画布被污染（图标那一步没走 blob）：把图标换成色块再画一遍。
    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, COVER_W, COVER_H);
    for (let index = 0; index < shown.length; index++) {
      const column = index % columns;
      const row = Math.floor(index / columns);
      drawExtTile(
        ctx,
        shown[index]!,
        startX + column * (tile + gap),
        startY + row * (tile + gap),
        tile,
        colors,
      );
    }
    try {
      return canvas.toDataURL('image/png');
    } catch {
      return null;
    }
  }
}
