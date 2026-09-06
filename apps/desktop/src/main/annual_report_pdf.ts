/**
 * 年度报告 PDF 渲染 —— Electron-only。
 *
 * 把 renderer 拼好的自包含 HTML（内联样式、无外部依赖）渲染成 A4 PDF。
 * 复用 link_shot 的隔离窗口范式：不可见、沙箱、无 preload、不碰账号会话。
 *
 * 本模块只能被桌面侧引用（经 `apps/desktop/src/main/host.ts` 注入），
 * 不能出现在共享 router 的静态依赖里 —— 否则 `electron` 会被拉进 web bundle
 * （见 `apps/web/scripts/check-electron-free.ts`）。
 */

import { BrowserWindow } from 'electron';

/** 渲染 HTML → PDF 字节。 */
export async function renderPdfFromHtml(html: string): Promise<Buffer> {
  const win = new BrowserWindow({
    width: 900,
    height: 1300,
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  try {
    const loaded = win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    await Promise.race([loaded, new Promise((resolve) => setTimeout(resolve, 8000))]);
    if (win.isDestroyed()) throw new Error('窗口已销毁');
    // 等字体/布局落定，避免首帧缺字。
    await win.webContents
      .executeJavaScript('document.fonts.ready.then(() => true)')
      .catch(() => true);
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      preferCSSPageSize: true,
    });
    if (pdf.length === 0) throw new Error('printToPDF 返回空文件');
    return pdf;
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}
