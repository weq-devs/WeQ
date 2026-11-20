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
import { z } from 'zod';
import { isUpdateCheckInterval } from '@weq/service/update-settings';
import { procedure, router } from '../trpc';
import { backgroundTasks } from '../../background_tasks';
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

export const updateRouter = router({
  getInterval: procedure.query(() => getUpdateActions().getInterval()),
  setInterval: desktop
    .input(z.object({ minutes: z.number().refine(isUpdateCheckInterval) }))
    .mutation(({ input }) => {
      getUpdateActions().setInterval(input.minutes);
      return getUpdateActions().getInterval();
    }),
  getPrerelease: procedure.query(() => getUpdateActions().getPrerelease()),
  setPrerelease: desktop.input(z.object({ enabled: z.boolean() })).mutation(({ input }) => {
    getUpdateActions().setPrerelease(input.enabled);
    return getUpdateActions().getPrerelease();
  }),
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
  download: desktop
    .input(z.object({ foreground: z.boolean().optional() }).optional())
    .mutation(({ input }): boolean => {
      const actions = getUpdateActions();
      if (!actions.supported) throw new Error('当前宿主不支持应用更新');
      actions.assertDownloadAvailable?.();
      void actions.startDownload(input?.foreground).catch(() => {});
      return true;
    }),

  controlDownload: desktop
    .input(
      z.object({
        id: z.string().uuid(),
        action: z.enum(['pause', 'continue', 'retry', 'background']),
      }),
    )
    .mutation(async ({ input }) => {
      const actions = getUpdateActions();
      if (actions.getDownloadTask?.()?.id !== input.id) throw new Error('更新下载已改变，请刷新');
      if (input.action === 'background') actions.backgroundDownload?.(input.id);
      else await backgroundTasks.act(input.id, input.action);
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
      const task = getUpdateActions().getDownloadTask?.();
      if (task) handler({ kind: 'download-task', task });
      return () => {
        updateBus.off('event', handler);
      };
    });
  }),
});
