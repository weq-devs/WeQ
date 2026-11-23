import { ipcMain, nativeImage, type BrowserWindow, type NativeImage } from 'electron';
import { floatingWindowTypeOption } from './linux_window_backend';
import { labelPerformanceWindow } from './performance_process_labels';
import {
  MESSAGE_IMAGE_CHANNEL,
  MESSAGE_IMAGE_WINDOW_PREFIX,
  type MessageImageResult,
} from '../shared/message_image';

const TILE_HEIGHT = 1200;
const MAX_PIXELS = 32_000_000;
const MAX_HEIGHT = 32_767;
const TOO_LARGE = '所选消息生成的图片过大，请减少选中的消息后重试';
type MessageImageJob = {
  window: BrowserWindow;
  timer: ReturnType<typeof setTimeout>;
  busy: boolean;
  finished: boolean;
  bottom?: number;
  tiles: { png: Buffer; rows: number }[];
  pixelWidth: number;
  pixelHeight: number;
};
const windows = new Map<number, MessageImageJob>();

export function isMessageImageWindow(url: string, name: string) {
  return (
    url === 'about:blank' &&
    name.startsWith(MESSAGE_IMAGE_WINDOW_PREFIX) &&
    /^[0-9a-f-]{36}$/.test(name.slice(MESSAGE_IMAGE_WINDOW_PREFIX.length))
  );
}

export function allowMessageImageWindow(owner: BrowserWindow) {
  if (windows.has(owner.webContents.id)) return { action: 'deny' } as const;
  const [width, height] = owner.getContentSize();
  const [x, y] = owner.getPosition();
  return {
    action: 'allow',
    overrideBrowserWindowOptions: {
      x,
      y,
      width,
      height,
      useContentSize: true,
      show: false,
      frame: false,
      skipTaskbar: true,
      ...floatingWindowTypeOption(),
      webPreferences: {
        sandbox: false,
        nodeIntegration: false,
        contextIsolation: true,
        backgroundThrottling: false,
        webviewTag: false,
      },
    },
  } as const;
}

export function registerMessageImageWindow(owner: BrowserWindow, window: BrowserWindow) {
  const id = owner.webContents.id;
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  labelPerformanceWindow(window, '聊天长图');
  const timer = setTimeout(() => {
    if (!window.isDestroyed()) window.destroy();
  }, 45_000);
  const entry = {
    window,
    timer,
    busy: false,
    finished: false,
    tiles: [],
    pixelWidth: 0,
    pixelHeight: 0,
  };
  windows.set(id, entry);
  window.once('closed', () => {
    clearTimeout(timer);
    if (windows.get(id) === entry) windows.delete(id);
  });
}

async function captureBatch(job: MessageImageJob): Promise<void> {
  const contents = job.window.webContents;
  const bounds = (await contents.executeJavaScript(`(() => {
    const node = document.querySelector('[data-weq-message-image-ready]');
    if (!node) return null;
    const { left, top, right, bottom } = node.getBoundingClientRect();
    return {
      left: left + scrollX, top: top + scrollY,
      right: right + scrollX, bottom: bottom + scrollY,
      ratio: devicePixelRatio,
    };
  })()`)) as { left: number; top: number; right: number; bottom: number; ratio: number } | null;
  if (!bounds) throw new Error('聊天长图没有可复制的内容');
  // CDP 的裁剪使用应用缩放后的 DIP。相邻批次取同一个全图边界，避免每段单独进位。
  const zoom = contents.getZoomFactor();
  const x = Math.floor(bounds.left * zoom);
  const y = job.bottom ?? Math.round(bounds.top * zoom);
  const bottom = Math.round(bounds.bottom * zoom);
  const width = Math.ceil(bounds.right * zoom) - x;
  const height = bottom - y;
  if (width <= 0 || height <= 0) throw new Error('聊天长图没有可复制的内容');
  const measuredScale = bounds.ratio / zoom;
  const roundedScale = Math.round(measuredScale);
  const scale = Math.abs(measuredScale - roundedScale) < 1e-6 ? roundedScale : measuredScale;
  const estimatedHeight = job.pixelHeight + height * scale;
  if (estimatedHeight > MAX_HEIGHT || width * scale * estimatedHeight > MAX_PIXELS)
    throw new Error(TOO_LARGE);

  const { debugger: cdp } = contents;
  cdp.attach('1.3');
  try {
    // 单条消息本身也可能很高。限制每次合成的纹理尺寸，只保留压缩后的截图。
    for (let offset = 0; offset < height; offset += TILE_HEIGHT) {
      const top = y + offset;
      const tileHeight = Math.min(TILE_HEIGHT, height - offset);
      // 非整数屏幕缩放下，以全图的物理像素边界为准，多取一行 DIP 供拼接时裁掉。
      const rows = Math.round((top + tileHeight) * scale) - Math.round(top * scale);
      const { data } = (await cdp.sendCommand('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
        clip: { x, y: top, width, height: tileHeight + Number(!Number.isInteger(scale)), scale: 1 },
      })) as { data: string };
      const png = Buffer.from(data, 'base64');
      const tile = nativeImage.createFromBuffer(png);
      const size = tile.getSize();
      if (tile.isEmpty()) throw new Error('截图为空');
      if (size.height < rows || (job.pixelWidth && size.width !== job.pixelWidth))
        throw new Error('聊天长图的截图尺寸不一致');
      const pixelHeight = job.pixelHeight + rows;
      if (pixelHeight > MAX_HEIGHT || size.width * pixelHeight > MAX_PIXELS)
        throw new Error(TOO_LARGE);
      job.pixelWidth = size.width;
      job.pixelHeight = pixelHeight;
      job.tiles.push({ png, rows });
    }
    job.bottom = bottom;
  } finally {
    if (!contents.isDestroyed() && cdp.isAttached()) cdp.detach();
  }
}

function composeImage({ tiles, pixelWidth, pixelHeight }: MessageImageJob): NativeImage {
  if (!tiles.length) throw new Error('聊天长图没有可复制的内容');
  const rowBytes = pixelWidth * 4;
  if (tiles.length === 1) {
    const tile = nativeImage.createFromBuffer(tiles[0]!.png);
    if (tile.getSize().height === pixelHeight) return tile;
  }
  const output = Buffer.allocUnsafe(rowBytes * pixelHeight);
  let offset = 0;
  for (const { png, rows } of tiles) {
    const bitmap = nativeImage.createFromBuffer(png).toBitmap();
    const length = rows * rowBytes;
    if (bitmap.length < length) throw new Error('聊天长图的截图尺寸不一致');
    bitmap.copy(output, offset, 0, length);
    offset += length;
  }
  return nativeImage.createFromBitmap(output, { width: pixelWidth, height: pixelHeight });
}

export function registerMessageImageIpc(write: (image: NativeImage) => Promise<void>) {
  ipcMain.handle(
    MESSAGE_IMAGE_CHANNEL,
    async (event, action: unknown): Promise<MessageImageResult> => {
      const entry = windows.get(event.sender.id);
      if (!entry || entry.window.isDestroyed()) return { ok: false, error: '找不到聊天长图窗口' };
      if (entry.busy || entry.finished) return { ok: false, error: '聊天长图正在处理或已完成' };
      if (action !== 'prepare' && action !== 'append' && action !== 'finish')
        return { ok: false, error: '未知的截图操作' };
      entry.busy = true;
      entry.timer.refresh();
      try {
        if (action === 'prepare') {
          // about:blank 的绘制文档初始化后才能应用父窗口的缩放。
          const contents = entry.window.webContents;
          contents.setZoomFactor(event.sender.getZoomFactor());
          await contents.executeJavaScript(
            'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))',
          );
          return { ok: true };
        }
        if (action === 'append') {
          await captureBatch(entry);
          return { ok: true };
        }
        const image = composeImage(entry);
        if (image.isEmpty()) throw new Error('截图为空');
        if (event.sender.isDestroyed() || entry.window.isDestroyed())
          return { ok: false, error: '聊天长图窗口已关闭' };
        await write(image);
        entry.finished = true;
        return { ok: true };
      } catch (error) {
        entry.finished = true;
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      } finally {
        entry.busy = false;
        if (entry.finished) entry.tiles.length = 0;
        else if (!entry.window.isDestroyed()) entry.timer.refresh();
      }
    },
  );
}
