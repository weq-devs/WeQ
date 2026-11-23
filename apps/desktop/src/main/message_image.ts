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
const windows = new Map<number, { window: BrowserWindow; capturing: boolean }>();

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
  window.webContents.setZoomFactor(owner.webContents.getZoomFactor());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  labelPerformanceWindow(window, '聊天长图');
  const entry = { window, capturing: false };
  windows.set(id, entry);
  const timeout = setTimeout(() => {
    if (!window.isDestroyed()) window.destroy();
  }, 45_000);
  window.once('closed', () => {
    clearTimeout(timeout);
    if (windows.get(id) === entry) windows.delete(id);
  });
}

async function captureMessageImage(window: BrowserWindow): Promise<NativeImage> {
  const contents = window.webContents;
  const bounds = (await contents.executeJavaScript(`(() => {
    const node = document.querySelector('[data-weq-message-image-ready]');
    if (!node) return null;
    const { left, top, right, bottom } = node.getBoundingClientRect();
    const x = Math.floor(left + scrollX);
    const y = Math.floor(top + scrollY);
    return {
      x, y,
      width: Math.ceil(right + scrollX) - x,
      height: Math.ceil(bottom + scrollY) - y,
      ratio: devicePixelRatio,
    };
  })()`)) as { x: number; y: number; width: number; height: number; ratio: number } | null;
  if (!bounds?.width || !bounds.height) throw new Error('聊天长图没有可复制的内容');
  const { x, y, width, height, ratio } = bounds;
  if (Math.ceil(height * ratio) > MAX_HEIGHT || width * height * ratio ** 2 > MAX_PIXELS)
    throw new Error('所选消息生成的图片过大，请减少选中的消息后重试');

  const { debugger: cdp } = contents;
  cdp.attach('1.3');
  try {
    // 隐藏窗口允许 Chromium 为视口外像素重新合成。分段限定单次合成的纹理尺寸。
    let output: Buffer | undefined;
    let pixelWidth = 0;
    let rows = 0;
    for (let offset = 0; offset < height; offset += TILE_HEIGHT) {
      const { data } = (await cdp.sendCommand('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
        clip: { x, y: y + offset, width, height: Math.min(TILE_HEIGHT, height - offset), scale: 1 },
      })) as { data: string };
      const tile = nativeImage.createFromBuffer(Buffer.from(data, 'base64'));
      const size = tile.getSize();
      if (tile.isEmpty()) throw new Error('截图为空');
      if (height <= TILE_HEIGHT) return tile;
      if (!output) {
        pixelWidth = size.width;
        const capacity = Math.ceil((height * size.height) / TILE_HEIGHT) + 1;
        if (pixelWidth * capacity > MAX_PIXELS) throw new Error('图片过大，请减少选中的消息');
        output = Buffer.allocUnsafe(pixelWidth * capacity * 4);
      }
      const bitmap = tile.toBitmap();
      const offsetBytes = rows * pixelWidth * 4;
      if (
        size.width !== pixelWidth ||
        bitmap.length !== size.width * size.height * 4 ||
        offsetBytes + bitmap.length > output.length
      ) {
        throw new Error('聊天长图的截图尺寸不一致');
      }
      bitmap.copy(output, offsetBytes);
      rows += size.height;
    }
    if (!output || !rows) throw new Error('截图为空');
    return nativeImage.createFromBitmap(output.subarray(0, rows * pixelWidth * 4), {
      width: pixelWidth,
      height: rows,
    });
  } finally {
    if (!contents.isDestroyed() && cdp.isAttached()) cdp.detach();
  }
}

export function registerMessageImageIpc(write: (image: NativeImage) => Promise<void>) {
  ipcMain.handle(MESSAGE_IMAGE_CHANNEL, async (event): Promise<MessageImageResult> => {
    const entry = windows.get(event.sender.id);
    if (!entry || entry.window.isDestroyed()) return { ok: false, error: '找不到聊天长图窗口' };
    if (entry.capturing) return { ok: false, error: '正在生成聊天长图' };
    entry.capturing = true;
    try {
      const image = await captureMessageImage(entry.window);
      if (image.isEmpty()) throw new Error('截图为空');
      if (event.sender.isDestroyed() || entry.window.isDestroyed())
        return { ok: false, error: '聊天长图窗口已关闭' };
      await write(image);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      entry.capturing = false;
    }
  });
}
