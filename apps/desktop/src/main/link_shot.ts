/**
 * 网页预截图 —— 链接卡片抓不到 og:image 时的兜底封面。
 *
 * 一个 URL 走到这里，意味着我们真的要把陌生网页**跑起来**（脚本会执行）。所以这个窗口
 * 按「一次性沙盒」造：
 *   · `show: false` + 离屏，用户看不到、也点不到；
 *   · 独立 `partition`（非 persist:）—— cookie / storage 进程退出即蒸发，不碰账号会话；
 *   · 无 preload、`nodeIntegration` 关、`contextIsolation` 开 —— 页面拿不到任何 bridge；
 *   · `setWindowOpenHandler` 一律 deny、`will-navigate` 只准同源跳转 —— 页面不能自己开窗
 *     或把我们导去别处；
 *   · session 的 download 全部取消、权限请求（地理位置/摄像头/通知…）全部拒绝
 *     —— 「打开链接自动下载木马」在这里是走不通的：字节根本不落盘。
 *   · 8 秒硬超时，无论加载完没有都截图并销毁窗口，不留后台页面。
 *
 * 调用方是 LinkPreviewService（通过 setScreenshotHook 注入），URL 在那边已过完 SSRF 闸门。
 */

import { BrowserWindow, session } from 'electron';

const WIDTH = 1000;
const HEIGHT = 640;
const LOAD_TIMEOUT_MS = 8000;
/** 首屏之后再等一拍，让懒加载的图片/字体落位（截白图的主要原因）。 */
const SETTLE_MS = 900;

let seq = 0;

/** 在一次性沙盒窗口里加载 url 并截取首屏，返回 PNG 字节；失败返回 null。 */
export async function screenshotPage(url: string): Promise<Buffer | null> {
  seq += 1;
  const partition = `link-shot-${seq}`;
  const ses = session.fromPartition(partition, { cache: false });
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  // 页面若试图触发下载，直接掐掉——预览不需要任何文件落盘。
  ses.on('will-download', (event) => event.preventDefault());

  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    show: false,
    webPreferences: {
      partition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      javascript: true,
      offscreen: true,
      images: true,
    },
  });
  win.webContents.setAudioMuted(true);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const origin = new URL(url).origin;
  win.webContents.on('will-navigate', (event, next) => {
    if (!next.startsWith(origin)) event.preventDefault();
  });

  try {
    const loaded = win.loadURL(url).catch(() => {});
    await Promise.race([loaded, new Promise((r) => setTimeout(r, LOAD_TIMEOUT_MS))]);
    if (win.isDestroyed()) return null;
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    if (win.isDestroyed()) return null;
    const image = await win.webContents.capturePage();
    return image.isEmpty() ? null : image.toPNG();
  } catch {
    return null;
  } finally {
    if (!win.isDestroyed()) win.destroy();
    void ses.clearStorageData().catch(() => {});
  }
}
