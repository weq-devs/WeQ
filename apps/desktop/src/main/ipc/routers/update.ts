/**
 * Update router — in-app check / download / install over GitHub accelerators.
 *
 *   - `getState`   — last cached check result (drives the settings card + red dot)
 *   - `check`      — speed-test mirrors + compare versions (throws if offline)
 *   - `download`   — start the download (non-blocking; progress via subscription)
 *   - `install`    — quit + silently install + relaunch
 *   - `onProgress` — download progress stream (settings progress bar)
 *   - `onEvent`    — available / downloaded / error (state machine + red dot)
 *
 * Mirrors the EventEmitter→observable bridge used by `bootstrap.onVoiceModelProgress`.
 *
 * The actual work is behind {@link UpdateActions}, installed by the shell — the
 * desktop app wires `electron-updater`, other hosts get no-ops. That keeps this
 * router (and the shared `AppRouter` type) free of Electron imports.
 */

import { observable } from '@trpc/server/observable';
import { TRPCError } from '@trpc/server';
import { procedure, router } from '../trpc';
import { backgroundTasks, runBackgroundTask } from '../../background_tasks';
import {
  getUpdateActions,
  getUpdateState,
  updateBus,
  type UpdateEvent,
  type UpdateProgress,
  type UpdateState,
} from '../../update/state';

const desktop = procedure.use(({ ctx, next }) => {
  if (ctx.authorize)
    throw new TRPCError({ code: 'FORBIDDEN', message: '仅允许桌面端管理应用更新。' });
  return next();
});

let downloadTask: Promise<unknown> | null = null;

export const updateRouter = router({
  /** Last cached check result, or null if not checked yet this session. */
  getState: procedure.query((): UpdateState | null => getUpdateState()),

  /** True when this host can actually install updates (false on web). */
  isSupported: procedure.query(
    ({ ctx }): boolean => !ctx.authorize && getUpdateActions().supported,
  ),

  /** Speed-test mirrors + compare versions. Rejects if no mirror is reachable. */
  check: desktop.mutation((): Promise<UpdateState> => getUpdateActions().check(true)),

  /**
   * Kick off the download. Returns immediately — progress and the terminal
   * state arrive over `onProgress` / `onEvent`; failures surface as an `error`
   * event (so we swallow the rejection here).
   */
  download: desktop.mutation((): boolean => {
    if (!downloadTask) {
      downloadTask = runBackgroundTask(
        {
          kind: 'update',
          name: `WeQ 更新包${getUpdateState()?.latest ? ` · ${getUpdateState()!.latest}` : ''}`,
        },
        async (id) => {
          const progress = (p: UpdateProgress) =>
            backgroundTasks.update(id, {
              progress: p.percent,
              note: `${(p.transferred / 1024 / 1024).toFixed(1)} / ${(p.total / 1024 / 1024).toFixed(1)} MiB`,
            });
          updateBus.on('progress', progress);
          try {
            if (!getUpdateActions().supported) throw new Error('当前宿主不支持应用更新');
            await getUpdateActions().startDownload();
          } finally {
            updateBus.off('progress', progress);
          }
        },
        () => ({ note: '更新包已下载，等待重启安装' }),
      )
        .catch(() => {})
        .finally(() => {
          downloadTask = null;
        });
    }
    return true;
  }),

  /** Quit, install the downloaded update silently, relaunch. */
  install: desktop.mutation((): boolean => {
    getUpdateActions().quitAndInstall();
    return true;
  }),

  /** Download progress stream (all attempts share it). */
  onProgress: procedure.subscription(() => {
    return observable<UpdateProgress>((emit) => {
      const handler = (p: UpdateProgress): void => emit.next(p);
      updateBus.on('progress', handler);
      return () => {
        updateBus.off('progress', handler);
      };
    });
  }),

  /** Lifecycle events: available / downloaded / error. */
  onEvent: procedure.subscription(() => {
    return observable<UpdateEvent>((emit) => {
      const handler = (e: UpdateEvent): void => emit.next(e);
      updateBus.on('event', handler);
      return () => {
        updateBus.off('event', handler);
      };
    });
  }),
});
