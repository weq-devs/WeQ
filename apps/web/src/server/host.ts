/**
 * Web implementation of {@link HostBridge}.
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
const downloads = new Map<string, { path: string; name: string }>();

export function lookupDownload(id: string): { path: string; name: string } | undefined {
  return downloads.get(id);
}

export function createWebHost({ exportDir, version }: WebHostOptions): HostBridge {
  mkdirSync(exportDir, { recursive: true });

  return {
    canReveal: false,

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
      const id = randomUUID();
      const path = join(exportDir, `${id}-${defaultName}`);
      downloads.set(id, { path, name: defaultName });
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
      const id = randomUUID();
      downloads.set(id, { path, name: 'report.html' });
      return { url: `/_download/${id}` };
    },

    async openBotConsole({ url }) {
      // The bot console is its own HTTP server; let the browser open it.
      return { url };
    },

    appVersion: () => version,
    isPackaged: () => process.env.NODE_ENV === 'production',
  };
}
