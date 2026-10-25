/**
 * `HostBridge` — the shell-specific capabilities a router may need.
 *
 * Everything else in `@weq/service` is pure Node. These four operations are
 * the only ones that differ between an Electron window (native file dialogs,
 * `shell.openPath`) and a browser served over HTTP (no dialogs at all — the
 * server picks a directory and the client downloads over the wire).
 *
 * Routers call `getHost()`; each app installs its implementation at startup
 * via `setHost()`. This keeps `import 'electron'` out of the router layer.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { StorageRoot, StorageUsageItem } from '../bootstrap/storage_usage';
import type { StorageCleanupResult } from '../bootstrap/storage_cleanup';

/** Where a "save as" request should land, plus how to hand it to the user. */
export interface SaveTarget {
  /** Absolute path the caller should write/copy to. */
  path: string;
  /**
   * Opaque id the client can use to fetch the file afterwards, when the host
   * can't put it where the user wanted it directly (web). `null` on Electron —
   * the user already chose the final location.
   */
  downloadId: string | null;
}

export interface HostBridge {
  /** 宿主额外拥有的目录，显式标记运行数据或受保护的安装资源。 */
  storageRoots?(): StorageRoot[];
  clearStorageAfterExit?(targets: StorageUsageItem[]): Promise<void>;
  storageCleanupResult?(): Promise<StorageCleanupResult | null>;
  /** 仅宿主支持时提供；调用方必须先明确确认重启。 */
  restartApplication?(): Promise<void>;
  /** Web 服务端导出根目录；桌面端由原生目录选择，不设此字段。 */
  readonly exportRoot?: string;
  registerDownload?(path: string, name: string, kind: 'file' | 'directory'): { url: string };
  /** 桌面保留原 Electron 会话的媒体读取，Web 缺省使用原生 fetch。 */
  fetchMedia?(url: string, opts?: { signal?: AbortSignal }): Promise<Response>;
  /** Decode uploaded image bytes; absent when the host has no image decoder. */
  validateImageBuffer?(bytes: Uint8Array): Promise<boolean>;
  /** Decode a cached collection image; absent when the host cannot verify images. */
  inspectCollectionImage?(path: string): Promise<{ width: number; height: number } | null>;
  /**
   * Pick a directory. Electron opens a folder dialog; web returns a
   * server-side directory (no dialog). `null` means the user cancelled —
   * web never cancels.
   */
  pickDirectory(opts?: { title?: string }): Promise<string | null>;
  /**
   * Pick a single file. Electron opens a file dialog; web has no way to browse
   * the server's disk, so it returns `null` (callers surface "unsupported").
   */
  pickFile(opts?: { title?: string; extensions?: string[] }): Promise<string | null>;
  /**
   * Resolve where to save `defaultName`. Electron opens a save dialog; web
   * allocates a path under the export dir and returns a `downloadId`.
   */
  pickSaveTarget(opts: {
    defaultName: string;
    /** 相同扩展名的不同导出功能可分别记忆位置。 */
    locationKey?: string;
    /** Extension for the dialog filter (no leading dot). */
    extension?: string;
  }): Promise<SaveTarget | null>;
  /** Reveal a path in the OS file manager / default app. No-op on web. */
  revealPath(path: string): Promise<void>;
  /** Select a path in the OS file manager (highlight it). No-op on web. */
  revealInFolder(path: string): Promise<void>;
  /**
   * Open an external URL (http/https/deep link) with the OS default handler.
   * Throws when the host can't open links (web — the client must open them
   * itself).
   */
  openExternal(url: string): Promise<void>;
  /** Whether {@link revealPath} does anything — the UI hides the button when false. */
  readonly canReveal: boolean;
  /**
   * Show an HTML report. Electron opens an isolated window and returns `null`
   * (already handled); web returns a URL the client should open in a new tab.
   */
  openHtmlReport(path: string): Promise<{ url: string } | null>;
  /**
   * Render a self-contained HTML document to a PDF buffer.
   * Electron opens an isolated hidden window and calls `printToPDF`; hosts
   * that can't render PDFs throw (callers surface "unsupported").
   */
  renderHtmlToPdf(html: string): Promise<Buffer>;
  /**
   * Screenshot a self-contained HTML document into one PNG per `.slide`
   * (in document order). Electron opens an isolated hidden window, resolves
   * each slide's box and captures it; hosts without a rendering engine throw.
   *
   * `indexes` restricts the capture to those 0-based slides; `overlayHtml` is
   * appended inside every captured slide (the QQ-space share chrome).
   */
  renderHtmlToSlidesPng(
    html: string,
    opts?: { indexes?: number[]; overlayHtml?: string },
  ): Promise<Buffer[]>;
  /**
   * Screenshot every `.slide` of a self-contained HTML document and stitch them
   * vertically into a single tall PNG. Same isolation guarantees as
   * {@link renderHtmlToSlidesPng}.
   */
  renderHtmlToLongPng(html: string): Promise<Buffer>;
  /**
   * Show an exported bot's WebUI console, logging in with `key`. Electron opens
   * a window and returns `null`; web returns the URL for the client to open.
   */
  openBotConsole(opts: {
    url: string;
    key: string;
    title?: string;
  }): Promise<{ url: string } | null>;
  /** App version string (`app.getVersion()` on Electron, package version on web). */
  appVersion(): string;
  /**
   * Whether this host participates in OS-level autostart at all. False on the
   * web/server host (the deployer's process manager owns it — a bare
   * `node server.mjs` needs args + cwd, so registering either the GUI or the
   * daemon would fight that) and false on unpackaged desktop dev builds (no
   * stable executable path).
   *
   * False means: the router refuses `setDaemonAutostart`, the settings toggle
   * is disabled, and the daemon is spawned with `WEQ_DAEMON_NO_AUTOSTART` so it
   * skips its own idempotent self-registration.
   */
  readonly canAutostart: boolean;
  /** False in dev builds. */
  isPackaged(): boolean;
  /**
   * Absolute path of the GUI binary the daemon should launch on boot:
   * `$APPIMAGE` when running from an AppImage (its mount path changes every
   * run), else `app.getPath('exe')`; `process.execPath` on web/server. WeQ
   * never registers an autostart task of its own — the daemon remembers this
   * path and spawns it.
   */
  currentExePath(): string;
}

let installed: HostBridge | null = null;
const requestHost = new AsyncLocalStorage<HostBridge>();

/** 同进程 Web 请求使用自己的宿主，不改变桌面端原生能力。 */
export function withHost<T>(host: HostBridge, action: () => T): T {
  return requestHost.run(host, action);
}

/** Install the host implementation. Call once, before any router runs. */
export function setHost(host: HostBridge): void {
  installed = host;
}

export function getHost(): HostBridge {
  const scoped = requestHost.getStore();
  if (scoped) return scoped;
  if (!installed) throw new Error('HostBridge not installed — call setHost() at startup.');
  return installed;
}
