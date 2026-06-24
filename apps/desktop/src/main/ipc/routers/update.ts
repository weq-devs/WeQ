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
 */

import { observable } from '@trpc/server/observable';
import { procedure, router } from '../trpc';
import {
  checkForUpdate,
  getUpdateState,
  quitAndInstall,
  startDownload,
  updateBus,
  type UpdateEvent,
  type UpdateProgress,
  type UpdateState,
} from '../../update/updater';

export const updateRouter = router({
  /** Last cached check result, or null if not checked yet this session. */
  getState: procedure.query((): UpdateState | null => getUpdateState()),

  /** Speed-test mirrors + compare versions. Rejects if no mirror is reachable. */
  check: procedure.mutation((): Promise<UpdateState> => checkForUpdate(true)),

  /**
   * Kick off the download. Returns immediately — progress and the terminal
   * state arrive over `onProgress` / `onEvent`; failures surface as an `error`
   * event (so we swallow the rejection here).
   */
  download: procedure.mutation((): boolean => {
    void startDownload().catch(() => {});
    return true;
  }),

  /** Quit, install the downloaded update silently, relaunch. */
  install: procedure.mutation((): boolean => {
    quitAndInstall();
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
