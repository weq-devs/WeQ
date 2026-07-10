/**
 * `account.fileResource.*` — the 本地资源 → 文件 页面 backend.
 *
 * Two listings, both thin tRPC skins over `FileResourceService` (see
 * `@weq/service`):
 *   - `fileDir.*`  — the recursive `nt_data/File/Ori` walk (chat files on disk).
 *   - `download.*` — file_assistant.db entries, existence-probed per page.
 *
 * Listings never return bytes: image previews stream via
 * `weq-media://localfile?path=<abs>`; reveal / open in the OS file manager are
 * mutations here (electron `shell`), gated so the File-dir reveal can only touch
 * paths inside `File/Ori`. `download.*` reveals the db-recorded `localPath`
 * directly (the user's own download records — same trust as the chat file card).
 */

import { z } from 'zod';
import { existsSync } from 'node:fs';
import { getAppContext, type AccountServices } from '../../context/app_context';
import { procedure, router } from '../trpc';

function requireServices(): AccountServices {
  const ctx = getAppContext();
  if (!ctx.services) {
    throw new Error('No account session open — call bootstrap.openAccount first.');
  }
  return ctx.services;
}

const categoryEnum = z.enum([
  'all',
  'image',
  'video',
  'audio',
  'document',
  'archive',
  'code',
  'program',
  'other',
]);

const listInput = z.object({
  category: categoryEnum.optional(),
  search: z.string().optional(),
  sort: z.enum(['time', 'name', 'size']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().optional(),
});

/** Reveal a path in the OS file manager; falls back to opening on failure. */
async function revealInFolder(path: string): Promise<void> {
  const { shell } = await import('electron');
  shell.showItemInFolder(path);
}

/** Open a path with the OS default handler. */
async function openPath(path: string): Promise<{ ok: boolean; error?: string }> {
  const { shell } = await import('electron');
  const err = await shell.openPath(path);
  return err ? { ok: false, error: err } : { ok: true };
}

export const fileResourceRouter = router({
  // ── File 目录 (nt_data/File/Ori) ──────────────────────────────────────────
  fileDir: router({
    /** Presence + per-category counts. `refresh` forces a rescan. */
    summary: procedure
      .input(z.object({ refresh: z.boolean().optional() }).optional())
      .query(({ input }) => {
        return requireServices().fileResource.getFileDirSummary(input?.refresh ?? false);
      }),

    /** A filtered + sorted + paged slice of the File/Ori snapshot. */
    list: procedure.input(listInput).query(({ input }) => {
      return requireServices().fileResource.listFileDir(input);
    }),

    /** Reveal a File/Ori file in the OS file manager (path must be inside Ori). */
    reveal: procedure
      .input(z.object({ path: z.string().min(1) }))
      .mutation(async ({ input }) => {
        const svc = requireServices().fileResource;
        if (!svc.isUnderFileDir(input.path)) {
          return { ok: false, error: '路径不在 File 目录内' };
        }
        if (!existsSync(input.path)) return { ok: false, error: '文件不存在' };
        await revealInFolder(input.path);
        return { ok: true };
      }),

    /** Open a File/Ori file with the OS default handler (path must be inside Ori). */
    open: procedure
      .input(z.object({ path: z.string().min(1) }))
      .mutation(async ({ input }) => {
        const svc = requireServices().fileResource;
        if (!svc.isUnderFileDir(input.path)) {
          return { ok: false, error: '路径不在 File 目录内' };
        }
        if (!existsSync(input.path)) return { ok: false, error: '文件不存在' };
        return openPath(input.path);
      }),
  }),

  // ── 下载文件 (file_assistant.db) ──────────────────────────────────────────
  download: router({
    /** A filtered + sorted + paged slice of file_assistant.db (existence-probed). */
    list: procedure.input(listInput).query(({ input }) => {
      return requireServices().fileResource.listDownloadFiles(input);
    }),

    /** Reveal a downloaded file by its db-recorded localPath. */
    reveal: procedure
      .input(z.object({ path: z.string().min(1) }))
      .mutation(async ({ input }) => {
        if (!existsSync(input.path)) return { ok: false, error: '文件已不存在' };
        await revealInFolder(input.path);
        return { ok: true };
      }),

    /** Open a downloaded file by its db-recorded localPath. */
    open: procedure
      .input(z.object({ path: z.string().min(1) }))
      .mutation(async ({ input }) => {
        if (!existsSync(input.path)) return { ok: false, error: '文件已不存在' };
        return openPath(input.path);
      }),
  }),

  /** Drop both snapshots so the next summary/list rebuilds from disk. */
  refresh: procedure.mutation(() => {
    requireServices().fileResource.invalidate();
    return true;
  }),
});
