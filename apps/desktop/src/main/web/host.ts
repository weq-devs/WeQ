/**
 * Web 请求使用的 {@link HostBridge}，与桌面原生宿主隔离。
 *
 * A browser can't drive native file dialogs on the server, so the semantics
 * shift: "pick a directory" becomes "use the server's configured export dir",
 * and "save as" writes there and hands back a download id the client fetches
 * over HTTP. Reveal-in-file-manager has no meaning at all — `canReveal` is
 * false and the UI hides those buttons.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { HostBridge, SaveTarget } from '@weq/service';

export interface WebHostOptions {
  /** Directory that receives exports/saves. Created if missing. */
  exportDir: string;
  version: string;
}

/** Pending downloads, keyed by the id handed to the client. */
const downloads = new Map<
  string,
  { path: string; name: string; kind: 'file' | 'directory'; expiresAt: number }
>();
const DOWNLOAD_TTL_MS = 30 * 60 * 1000;
const MAX_DOWNLOAD_HANDLES = 4096;

function registerDownload(path: string, name: string, kind: 'file' | 'directory'): string {
  const now = Date.now();
  for (const [id, entry] of downloads) if (entry.expiresAt <= now) downloads.delete(id);
  while (downloads.size >= MAX_DOWNLOAD_HANDLES) {
    const first = downloads.keys().next().value;
    if (first !== undefined) downloads.delete(first);
  }
  const id = randomUUID();
  downloads.set(id, { path, name, kind, expiresAt: now + DOWNLOAD_TTL_MS });
  return id;
}

export function lookupDownload(id: string) {
  const entry = downloads.get(id);
  if (entry && entry.expiresAt <= Date.now()) {
    downloads.delete(id);
    return undefined;
  }
  return entry;
}

export function createWebHost({ exportDir, version }: WebHostOptions): HostBridge {
  mkdirSync(exportDir, { recursive: true });

  return {
    exportRoot: exportDir,
    registerDownload(path, name, kind) {
      return { url: `/_download/${registerDownload(path, name, kind)}` };
    },
    canReveal: false,
    // 浏览器版：整个服务由部署方用 systemd / 计划任务托管，自启动一律不参与
    // —— 既不注册 GUI（web 入口是 `node server.mjs`，需要参数 + 工作目录），
    // 也让守护进程跳过自身注册，避免和部署方的 unit 抢同一份生命周期
    // （见 apps/web/README）。
    canAutostart: false,

    async pickDirectory() {
      // No dialog: everything lands in the server-side export dir.
      return exportDir;
    },

    async pickFile() {
      // The server's filesystem isn't the user's to browse. Callers treat null
      // as "cancelled"; the UI hides these entry points on web anyway.
      return null;
    },

    async pickSaveTarget({ defaultName }): Promise<SaveTarget> {
      if (
        !defaultName ||
        defaultName === '.' ||
        defaultName === '..' ||
        // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject filename control characters.
        /[/\\\x00-\x1f:]/.test(defaultName)
      ) {
        throw new Error('保存文件名必须是单个文件名，不能包含路径或控制字符。');
      }
      const path = join(exportDir, `${randomUUID()}-${defaultName}`);
      const id = registerDownload(path, defaultName, 'file');
      return { path, downloadId: id };
    },

    async revealPath() {
      // No-op — nothing to reveal on a headless host.
    },

    async revealInFolder() {
      // No-op.
    },

    async openExternal() {
      // The browser runs on the client, not here — the server can't drive it.
      // Callers surface this as "unsupported" on web.
      throw new Error('web 环境不支持服务端打开链接，请在浏览器中直接打开');
    },

    async openHtmlReport(path) {
      const id = registerDownload(path, 'report.html', 'file');
      return { url: `/_download/${id}` };
    },

    async renderHtmlToPdf() {
      // 服务端没有 Electron 渲染引擎；年度报告 PDF 导出只在桌面版提供。
      throw new Error('web 环境不支持 PDF 渲染，请使用桌面版');
    },

    async renderHtmlToSlidesPng() {
      throw new Error('web 环境不支持图片渲染，请使用桌面版');
    },

    async renderHtmlToLongPng() {
      throw new Error('web 环境不支持图片渲染，请使用桌面版');
    },

    async openBotConsole({ url }) {
      // The bot console is its own HTTP server; let the browser open it.
      return { url };
    },

    appVersion: () => version,
    isPackaged: () => process.env.NODE_ENV === 'production',
    currentExePath: () => process.execPath,
  };
}
