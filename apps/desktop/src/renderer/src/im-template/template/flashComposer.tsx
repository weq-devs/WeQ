// @ts-nocheck
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
 *   2. 选好点「确认」→ 弹一张灯箱卡片：封面预览 + 文件清单，封面可以自己换（≤ 1MB）；
 *   3. 点「发送」→ 应用层走 fileset 协议（封面先就绪、主文件后台传）。
 *
 * 面板本身像语音条一样**内联进输入框**（占掉正文编辑区那一行，见
 * styles/flash-composer.css 的 `@media (min-width: 761px)` 段），不再是从输入框
 * 上沿弹出来的卡片；小屏装不下时仍是浮层。灯箱 `createPortal` 到 `document.body`：
 * `.composer` 上有 `backdrop-filter`，会把 `position: fixed` 的包含块拽成输入框那一格，
 * 挂在里面的话灯箱就永远贴在底部。
 *
 * 封面是**渲染层用 canvas 拼的 PNG**（主进程没有 canvas）：默认拿 `resources/fileicon`
 * 里的类型图标拼一张 480×270 的封面；`weq-asset://` 的图标先 fetch 成 blob 再画
 * （blob 是同源，canvas 不会被污染），拿不到就退回「色块 + 扩展名」的画法。
 *
 * 面板自己不碰 trpc / 协议；样式见 styles/flash-composer.css，颜色全走主题 token。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { RefObject } from 'react';
import { ImagePlus, Loader2, RotateCcw, SendHorizontal, Sparkles, X, Zap } from 'lucide-react';
import { useOverlayLayer } from '../../lib/overlayStack';
import { cn } from './classNames';
import { dataTransferHasFiles } from './composerMedia';
import { fileExtIcon } from '../../lib/groupFile';
import { fileIconUrl } from '../../lib/resourceUrl';

/** 待发送的一个文件（渲染层只知道路径 / 名字 / 大小；字节在主进程读）。 */
export interface FlashDraftFile {
  /** 本机绝对路径（`window.weq.pathForFile`）。 */
  path: string;
  name: string;
  size: number;
}

/** 交给应用层的闪传载荷。 */
export interface FlashSendPayload {
  files: FlashDraftFile[];
  /** fileset 标题（卡片名）；空串 = 让服务层按文件名 / 数量拼。 */
  name: string;
  /** 封面 PNG（`data:image/png;base64,…`）；空串 = 不带封面。 */
  coverDataUrl: string;
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

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${index === 0 ? value.toFixed(0) : value.toFixed(2)} ${units[index]}`;
}

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

/** 把一张图片按 cover 方式铺满画布。 */
function drawCoverFit(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement | HTMLCanvasElement,
  width: number,
  height: number,
): void {
  const sw = image.width;
  const sh = image.height;
  if (!sw || !sh) return;
  const scale = Math.max(width / sw, height / sh);
  const dw = sw * scale;
  const dh = sh * scale;
  ctx.drawImage(image, (width - dw) / 2, (height - dh) / 2, dw, dh);
}

/**
 * 拼一张闪传封面。
 *
 * 优先：用户自己选的图（`override`）→ 直接铺满。
 * 其次：最多 4 枚文件类型图标（`resources/fileicon`）2×2 摆开。
 * 最后：色块 + 扩展名（fetch 图标失败 / canvas 被污染时的兜底）。
 * 返回 `data:image/png;base64,…`；连兜底都失败就给 null（调用方不带封面）。
 */
export async function composeFlashCover(
  files: FlashDraftFile[],
  override?: string | null,
): Promise<string | null> {
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

  // 用户自己换的封面：铺满、不加装饰。
  if (override) {
    const image = await loadImage(override);
    if (image) {
      drawCoverFit(ctx, image, COVER_W, COVER_H);
      try {
        return canvas.toDataURL('image/png');
      } catch {
        return null;
      }
    }
  }

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
    const file = shown[index];
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
        shown[index],
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

// ── 文件收集（拖拽 / 选择）─────────────────────────────────────────────────────

/**
 * 把一个 File 变成草稿文件。
 *
 * 路径走 `window.weq.pathForFile`（Electron `webUtils`）：闪传要主进程按**路径**读文件
 * （大文件不落内存），剪贴板之类没有落盘来源的东西拿不到路径 —— 那种直接跳过。
 */
function toDraft(file: File): FlashDraftFile | null {
  const path = window.weq?.pathForFile?.(file) ?? '';
  if (!path) return null;
  return { path, name: file.name || path.split(/[\\/]/).pop() || path, size: file.size ?? 0 };
}

/** 递归展开拖进来的目录（`webkitGetAsEntry`）。 */
async function collectEntries(items: DataTransferItemList | null): Promise<File[]> {
  if (!items) return [];
  const roots: FileSystemEntry[] = [];
  for (let index = 0; index < items.length; index++) {
    const entry = items[index]?.webkitGetAsEntry?.();
    if (entry) roots.push(entry);
  }
  const directoryEntries = roots.filter(
    (entry): entry is FileSystemDirectoryEntry => entry.isDirectory,
  );
  // 没有目录就没有异步展开，直接同步拿 files（同步上下文里才能读 items）。
  if (directoryEntries.length === 0) {
    const files: File[] = [];
    for (let index = 0; index < items.length; index++) {
      const file = items[index]?.getAsFile?.();
      if (file) files.push(file);
    }
    return files;
  }

  const out: File[] = [];
  const readAll = async (reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> => {
    const batch: FileSystemEntry[] = [];
    // readEntries 一次最多回 100 条，要读到空为止。
    for (;;) {
      const chunk = await new Promise<FileSystemEntry[]>((resolve) => {
        reader.readEntries(resolve, () => resolve([]));
      });
      if (chunk.length === 0) return batch;
      batch.push(...chunk);
    }
  };
  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File | null>((resolve) => {
        (entry as FileSystemFileEntry).file(resolve, () => resolve(null));
      });
      if (file) out.push(file);
      return;
    }
    if (entry.isDirectory) {
      const children = await readAll((entry as FileSystemDirectoryEntry).createReader());
      for (const child of children) await walk(child);
    }
  };
  for (const entry of roots) await walk(entry);
  return out;
}

// ── 组件 ────────────────────────────────────────────────────────────────────

export function FlashComposer({
  panelRef,
  canSend,
  sendHint,
  onSend,
  onClose,
}: {
  panelRef?: RefObject<HTMLDivElement | null>;
  canSend: boolean;
  sendHint: string;
  /** 交回应用层发送（走 fileset 协议）；**抛出即失败**，面板保留已选文件。 */
  onSend: (payload: FlashSendPayload) => Promise<void>;
  onClose: () => void;
}) {
  const [files, setFiles] = useState<FlashDraftFile[]>([]);
  const [name, setName] = useState('');
  const [cover, setCover] = useState<string | null>(null);
  const [coverTouched, setCoverTouched] = useState(false);
  const [coverBusy, setCoverBusy] = useState(false);
  const [lightbox, setLightbox] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lightboxLayer = useOverlayLayer(lightbox);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const filesInputRef = useRef<HTMLInputElement | null>(null);
  const coverInputRef = useRef<HTMLInputElement | null>(null);

  const desc = useMemo(() => flashDescOf(files), [files]);
  const title =
    name.trim() ||
    (files.length === 1 ? files[0]?.name : `${files[0]?.name ?? ''}等${files.length}个文件`);

  /** 文件列表变了就重拼默认封面（用户手动换过就不动它）。 */
  useEffect(() => {
    if (coverTouched) return;
    if (files.length === 0) {
      setCover(null);
      return;
    }
    let cancelled = false;
    setCoverBusy(true);
    void composeFlashCover(files).then((dataUrl) => {
      if (cancelled) return;
      setCover(dataUrl);
      setCoverBusy(false);
    });
    return () => {
      cancelled = true;
    };
  }, [files, coverTouched]);

  /**
   * 灯箱挂在 `document.body` 上（不在本组件 DOM 子树里），所以 Esc 得自己听：
   * 开着就只把灯箱收起来，退回文件框，草稿一点不丢。chatPane 那一层看到
   * `.flash-lightbox` 会主动让路（见那边的 closeFlashOnEscape）。
   */
  useEffect(() => {
    if (!lightbox) return;
    function onEscape(event: KeyboardEvent): void {
      if (event.key === 'Escape') setLightbox(false);
    }
    document.addEventListener('keydown', onEscape);
    return () => document.removeEventListener('keydown', onEscape);
  }, [lightbox]);

  /** 追加一批文件（拖拽 / 选择共用）；按路径去重。 */
  const addFiles = useCallback((incoming: FlashDraftFile[]) => {
    if (incoming.length === 0) return;
    setFiles((current) => {
      const seen = new Set(current.map((file) => file.path));
      const next = [...current];
      for (const file of incoming) {
        if (seen.has(file.path)) continue;
        seen.add(file.path);
        next.push(file);
      }
      return next;
    });
    setError(null);
  }, []);

  const addFromFiles = useCallback(
    (picked: File[] | FileList | null) => {
      if (!picked) return;
      const draft: FlashDraftFile[] = [];
      let skipped = 0;
      for (const file of Array.from(picked)) {
        const item = toDraft(file);
        if (item) draft.push(item);
        else skipped += 1;
      }
      addFiles(draft);
      if (skipped > 0) {
        setError(`${skipped} 个文件拿不到本机路径（剪切板 / 虚拟位置不支持闪传），已跳过。`);
      }
    },
    [addFiles],
  );

  /** 换封面：用户的图也走 canvas 重绘成 PNG（顺带把大小压下来）。 */
  async function handlePickCover(file: File): Promise<void> {
    if (file.size > 1024 * 1024) {
      setError('封面图不能超过 1 MB。');
      return;
    }
    const dataUrl = await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });
    if (!dataUrl) {
      setError('读不出这张图片。');
      return;
    }
    setCoverBusy(true);
    const composed = await composeFlashCover(files, dataUrl);
    setCoverBusy(false);
    if (!composed) {
      setError('这张图片没法当封面（格式不支持或画布被限制）。');
      return;
    }
    setCover(composed);
    setCoverTouched(true);
    setError(null);
  }

  async function restoreCover(): Promise<void> {
    setCoverTouched(false);
    setCoverBusy(true);
    const composed = await composeFlashCover(files);
    setCoverBusy(false);
    setCover(composed);
  }

  /**
   * 拖拽落点铺满**整个输入区**（文件框 + 外面那一圈空白 + 工具栏）：文件框内联进
   * 输入框以后它就是这一格唯一认文件的东西，而事件可能落在 `.composer` 自己身上。
   * 在捕获阶段就截下来，既轮不到 chatPane 把文件铺成「只能单独发」的卡片，
   * 也不会让浏览器直接打开拖进来的文件。
   */
  useEffect(() => {
    const host = rootRef.current?.closest('.composer');
    if (!host) return;

    const inHost = (event: globalThis.DragEvent): boolean => {
      const target = event.target;
      return target instanceof Node && host.contains(target);
    };

    function over(event: globalThis.DragEvent): void {
      if (!dataTransferHasFiles(event.dataTransfer) || !inHost(event)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'copy';
      setDragging(true);
    }
    function drop(event: globalThis.DragEvent): void {
      if (!dataTransferHasFiles(event.dataTransfer) || !inHost(event)) return;
      event.preventDefault();
      event.stopPropagation();
      setDragging(false);
      // 文件 / 文件夹都走 items（目录要靠 webkitGetAsEntry 递归展开）。
      const items = event.dataTransfer?.items ?? null;
      void collectEntries(items).then(addFromFiles);
    }

    function leave(event: globalThis.DragEvent): void {
      // 在输入区内部挪动时 relatedTarget 还在里面（dragover / dragleave 会成对地
      // 在子元素上来回刷），不算离开。
      const next = event.relatedTarget as Node | null;
      if (next && host.contains(next)) return;
      setDragging(false);
    }

    function done(): void {
      setDragging(false);
    }

    host.addEventListener('dragover', over, true);
    host.addEventListener('drop', drop, true);
    host.addEventListener('dragleave', leave, true);
    window.addEventListener('dragend', done);
    window.addEventListener('blur', done);
    return () => {
      host.removeEventListener('dragover', over, true);
      host.removeEventListener('drop', drop, true);
      host.removeEventListener('dragleave', leave, true);
      window.removeEventListener('dragend', done);
      window.removeEventListener('blur', done);
    };
  }, [addFromFiles]);

  async function submit(): Promise<void> {
    if (files.length === 0 || !canSend || sending) return;
    setSending(true);
    setError(null);
    try {
      await onSend({
        files,
        name: name.trim(),
        coverDataUrl: cover ?? '',
      });
      onClose();
    } catch (err) {
      // 失败不吞已选内容：错误显示在灯箱里，用户改一改就能重发。
      setError(err instanceof Error ? err.message : String(err));
      setSending(false);
    }
  }

  return (
    <div
      className={cn('flash-composer', dragging && 'is-dragging')}
      ref={(node) => {
        rootRef.current = node;
        if (panelRef) panelRef.current = node;
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          if (lightbox) setLightbox(false);
          else onClose();
        }
      }}
    >
      {/*
        整块输入框就是落点：没有图标、没有说明、没有一排小按钮。空的时候它占满整格、
        中间只有一句「点击打开文件选择」；已经有文件时就留一行，点它还能源源不断地加。
      */}
      <div className={cn('flash-composer-body')}>
        {files.length > 0 ? (
          <ul className={cn('flash-file-list')}>
            {files.map((file) => (
              <li key={file.path}>
                <img src={fileIconUrl(fileExtIcon(file.name))} alt="" loading="lazy" />
                <span className={cn('flash-file-name')} title={file.path}>
                  {file.name}
                </span>
                <em>{formatBytes(file.size)}</em>
                <button
                  type="button"
                  className={cn('flash-file-remove')}
                  title="移除"
                  aria-label={`移除 ${file.name}`}
                  onClick={() =>
                    setFiles((current) => current.filter((item) => item.path !== file.path))
                  }
                >
                  <X size={12} strokeWidth={2.4} />
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        <div
          className={cn('flash-picker')}
          onClick={() => filesInputRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              filesInputRef.current?.click();
            }
          }}
        >
          <Zap size={22} strokeWidth={1.6} aria-hidden="true" />
          <span>点击打开文件选择</span>
          {/* 读不出本机路径的文件（剪贴板 / 虚拟位置）挑出来时才出现，别无其它说明文字。 */}
          {error && !lightbox ? <em className={cn('flash-error')}>{error}</em> : null}
        </div>
      </div>

      {files.length > 0 ? (
        <footer className={cn('flash-composer-foot')}>
          <button
            type="button"
            className={cn('flash-btn primary')}
            onClick={() => setLightbox(true)}
          >
            确认
          </button>
        </footer>
      ) : null}

      {/* 隐藏的文件选择器：多选；整个文件夹走拖拽那条路（递归展开）。 */}
      <input
        ref={filesInputRef}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          addFromFiles(event.target.files);
          event.target.value = '';
        }}
      />
      <input
        ref={coverInputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void handlePickCover(file);
        }}
      />

      {/*
        灯箱 `createPortal` 到 body：`.composer` 带 `backdrop-filter`，会给
        `position: fixed` 的子孙另开一个包含块（就是输入框那一格），挂在里面的话
        `inset: 0` 只盖住输入区，卡片跟着掉到屏幕底部。挂到 body 才是整屏居中。
      */}
      {lightbox
        ? createPortal(
            <div
              className={cn('flash-lightbox')}
              style={{ zIndex: lightboxLayer }}
              role="dialog"
              aria-modal="true"
              aria-label="闪传封面"
              // 点灯箱外的空白退回文件框（同输入框里的媒体预览灯箱）；草稿都还在。
              onMouseDown={(event) => {
                if (event.target !== event.currentTarget || sending) return;
                setLightbox(false);
              }}
            >
              <div className={cn('flash-lightbox-card')}>
                <div className={cn('flash-lightbox-cover')}>
                  {cover ? (
                    <img src={cover} alt="闪传封面预览" />
                  ) : (
                    <span className={cn('flash-lightbox-cover-empty')}>
                      {coverBusy ? (
                        <Loader2 size={18} className={cn('flash-spin')} />
                      ) : (
                        <Sparkles size={18} strokeWidth={1.7} />
                      )}
                    </span>
                  )}
                  {coverBusy ? (
                    <span className={cn('flash-lightbox-cover-busy')}>
                      <Loader2 size={16} className={cn('flash-spin')} />
                    </span>
                  ) : null}
                </div>

                <div className={cn('flash-lightbox-body')}>
                  <div className={cn('flash-lightbox-row')}>
                    <span className={cn('flash-lightbox-label')}>标题</span>
                    <input
                      type="text"
                      className={cn('flash-lightbox-input')}
                      value={name}
                      maxLength={120}
                      placeholder={title}
                      spellCheck={false}
                      onChange={(event) => setName(event.target.value)}
                    />
                  </div>
                  <div className={cn('flash-lightbox-meta')}>
                    <span>{desc}</span>
                    <span className={cn('flash-lightbox-sep')}>·</span>
                    <span>封面 {cover ? '已就绪' : '未设置'}</span>
                  </div>
                  <ul className={cn('flash-lightbox-files')}>
                    {files.slice(0, 6).map((file) => (
                      <li key={file.path}>
                        <img src={fileIconUrl(fileExtIcon(file.name))} alt="" loading="lazy" />
                        <span title={file.path}>{file.name}</span>
                        <em>{formatBytes(file.size)}</em>
                      </li>
                    ))}
                    {files.length > 6 ? (
                      <li className={cn('flash-lightbox-more')}>…还有 {files.length - 6} 个</li>
                    ) : null}
                  </ul>
                  {error ? <span className={cn('flash-error')}>{error}</span> : null}
                </div>

                <div className={cn('flash-lightbox-actions')}>
                  <button
                    type="button"
                    className={cn('flash-btn ghost')}
                    title="上传一张自己的封面（≤ 1 MB）"
                    onClick={() => coverInputRef.current?.click()}
                  >
                    <ImagePlus size={14} /> 换封面
                  </button>
                  <button
                    type="button"
                    className={cn('flash-btn ghost')}
                    title="按文件类型重新拼一张封面"
                    disabled={coverBusy}
                    onClick={() => void restoreCover()}
                  >
                    <RotateCcw size={14} /> 默认封面
                  </button>
                  <button
                    type="button"
                    className={cn('flash-btn ghost')}
                    onClick={() => setLightbox(false)}
                  >
                    返回
                  </button>
                  <button
                    type="button"
                    className={cn('flash-btn primary')}
                    title={canSend ? '发送闪传' : sendHint}
                    disabled={sending || !canSend}
                    onClick={() => void submit()}
                  >
                    {sending ? (
                      <Loader2 size={14} className={cn('flash-spin')} />
                    ) : (
                      <SendHorizontal size={14} />
                    )}
                    {sending ? '发送中…' : '发送'}
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
