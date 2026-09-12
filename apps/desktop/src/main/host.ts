/**
 * Electron implementation of {@link HostBridge} — native file dialogs and
 * opening paths in the system file manager. Installed once from `index.ts`
 * before any router runs.
 */

import { app, dialog, shell } from 'electron';
import { spawn } from 'node:child_process';
import type { HostBridge, SaveTarget } from '@weq/service';

/**
 * `shell.openPath` 在 Windows / Linux 上都会等待系统处理程序返回：
 *   - Windows：Explorer / “打开方式”对话框（Electron 36.8 才合入 non-blocking
 *     修复，electron/electron#48087）；
 *   - Linux：GNOME 上拉起 Nautilus 后去连 Tracker3 索引，连接失败时 promise
 *     永不 resolve，主进程主线程被同步卡死（IPC 不回复、应用无法退出）。
 * 因此两平台都改用独立进程打开目录、立刻返回；只有 macOS 走 `shell.openPath`。
 */
function revealInFileManager(path: string): Promise<void> {
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      const child = spawn('explorer', [path], { detached: true, stdio: 'ignore' });
      child.on('error', () => {
        // explorer 启动失败（极罕见）时退回 openPath，fire-and-forget 避免再卡。
        void shell.openPath(path).catch(() => {});
      });
      child.unref();
      resolve();
    });
  }
  if (process.platform === 'linux') {
    return new Promise((resolve) => {
      const child = spawn('xdg-open', [path], { detached: true, stdio: 'ignore' });
      child.on('error', () => {
        // xdg-open 缺失时退回 gio open（同样独立进程，不等待）。
        const gio = spawn('gio', ['open', path], { detached: true, stdio: 'ignore' });
        gio.on('error', () => {
          // 最后的兜底：不等待的 shell.openPath（极少触发，避免再卡）。
          void shell.openPath(path).catch(() => {});
        });
        gio.unref();
      });
      child.unref();
      resolve();
    });
  }
  return shell.openPath(path).then((err) => {
    if (err) throw new Error(err);
  });
}

export const electronHost: HostBridge = {
  canReveal: true,

  async pickDirectory(opts) {
    const result = await dialog.showOpenDialog({
      title: opts?.title,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0] ?? null;
  },

  async pickFile(opts) {
    const result = await dialog.showOpenDialog({
      title: opts?.title,
      filters: opts?.extensions?.length
        ? [{ name: 'File', extensions: opts.extensions }]
        : undefined,
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0] ?? null;
  },

  async pickSaveTarget({ defaultName, extension }): Promise<SaveTarget | null> {
    const result = await dialog.showSaveDialog({
      defaultPath: defaultName,
      filters: extension ? [{ name: 'File', extensions: [extension] }] : undefined,
    });
    if (result.canceled || !result.filePath) return null;
    return { path: result.filePath, downloadId: null };
  },

  async revealPath(path) {
    await revealInFileManager(path);
  },

  async revealInFolder(path) {
    shell.showItemInFolder(path);
  },

  async openExternal(url) {
    await shell.openExternal(url);
  },

  async openHtmlReport(path) {
    const { openReportWindow } = await import('./report_window');
    await openReportWindow(path);
    return null;
  },

  async renderHtmlToPdf(html) {
    const { renderPdfFromHtml } = await import('./annual_report_pdf');
    return renderPdfFromHtml(html);
  },

  async renderHtmlToSlidesPng(html, opts) {
    const { renderHtmlToSlidesPng } = await import('./html_shot');
    return renderHtmlToSlidesPng(html, opts);
  },

  async renderHtmlToLongPng(html) {
    const { renderHtmlToLongPng } = await import('./html_shot');
    return renderHtmlToLongPng(html);
  },

  async openBotConsole({ url, key, title }) {
    const { openBotWebUiWindow } = await import('./bot_webui_window');
    await openBotWebUiWindow(url, key, title);
    return null;
  },

  appVersion: () => app.getVersion(),
  isPackaged: () => app.isPackaged,
  // 「开机拉起 WeQ」的意图交给守护进程记着（GUI 自己不注册任何原生自启）：
  // pnpm dev 拉起的 electron 没有安装、没有固定路径语义，让它开机起是错的 ——
  // 只允许打包版开启。
  canAutostart: app.isPackaged,
  currentExePath: () => {
    // AppImage 下 `app.getPath('exe')` 是本次运行的临时挂载点
    // （`/tmp/.mount_<name>.<rand>/…`），重启后必然不存在 —— 必须用 $APPIMAGE
    // （AppImage 文件本身，路径稳定）。其它打包形态两者等价。
    const appImage = process.env.APPIMAGE;
    return appImage && appImage.length > 0 ? appImage : app.getPath('exe');
  },
};
