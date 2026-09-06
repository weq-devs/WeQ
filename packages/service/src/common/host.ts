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
  /** False in dev builds. */
  isPackaged(): boolean;
}

let installed: HostBridge | null = null;

/** Install the host implementation. Call once, before any router runs. */
export function setHost(host: HostBridge): void {
  installed = host;
}

export function getHost(): HostBridge {
  if (!installed) throw new Error('HostBridge not installed — call setHost() at startup.');
  return installed;
}
