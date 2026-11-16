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
 * 主文档复用服务层已取得的 HTML；所有联网子资源也由服务层校验并固定 IP 传输。
 */

import { BrowserWindow, session } from 'electron';
import type { LinkScreenshotRequest } from '@weq/service';

const WIDTH = 1000;
const HEIGHT = 640;
/** 首屏之后再等一拍，让懒加载的图片/字体落位（截白图的主要原因）。 */
const SETTLE_MS = 900;

let seq = 0;

/** 在一次性沙盒窗口里加载 url 并截取首屏，返回 PNG 字节；失败返回 null。 */
export async function screenshotPage(input: LinkScreenshotRequest): Promise<Buffer | null> {
  if (input.signal.aborted) return null;
  seq += 1;
  const partition = `link-shot-${seq}`;
  const ses = session.fromPartition(partition, { cache: false });
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  // 页面若试图触发下载，直接掐掉——预览不需要任何文件落盘。
  ses.on('will-download', (event) => event.preventDefault());
  const url = new URL(input.url).href;
  let mainServed = false;
  ses.webRequest.onBeforeRequest((details, callback) => {
    const protocol = new URL(details.url).protocol;
    const allowed =
      !input.signal.aborted &&
      ['GET', 'HEAD'].includes(details.method) &&
      !['subFrame', 'object', 'media', 'webSocket', 'ping', 'cspReport'].includes(
        details.resourceType,
      ) &&
      (details.resourceType === 'mainFrame'
        ? details.url === url && !mainServed
        : ['http:', 'https:', 'data:', 'blob:'].includes(protocol));
    callback({ cancel: !allowed });
  });
  for (const scheme of ['http', 'https'])
    ses.protocol.handle(scheme, async (request) => {
      if (input.signal.aborted || !['GET', 'HEAD'].includes(request.method))
        return new Response(null, { status: 403 });
      if (request.url === url && !mainServed) {
        mainServed = true;
        return new Response(input.html, {
          headers: {
            'content-type': 'text/html;charset=utf-8',
            'content-security-policy':
              "worker-src 'none'; frame-src 'none'; object-src 'none'; connect-src http: https:",
          },
        });
      }
      const resource = await input.fetchResource(request.url);
      if (!resource || input.signal.aborted) return new Response(null, { status: 403 });
      return new Response(request.method === 'HEAD' ? null : new Uint8Array(resource.bytes), {
        headers: { 'content-type': resource.contentType },
      });
    });

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
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.on('will-redirect', (event) => event.preventDefault());
  const abort = () => {
    if (!win.isDestroyed()) win.destroy();
  };
  input.signal.addEventListener('abort', abort, { once: true });

  try {
    await win.loadURL(url);
    if (win.isDestroyed() || input.signal.aborted) return null;
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    if (win.isDestroyed() || input.signal.aborted) return null;
    const image = await win.webContents.capturePage();
    return image.isEmpty() ? null : image.toPNG();
  } catch {
    return null;
  } finally {
    if (!win.isDestroyed()) win.destroy();
    input.signal.removeEventListener('abort', abort);
    ses.webRequest.onBeforeRequest(null);
    for (const scheme of ['http', 'https']) ses.protocol.unhandle(scheme);
    void ses.clearStorageData().catch(() => {});
  }
}
