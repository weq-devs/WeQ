/**
 * Update types + the event bus and cached state that the router reads.
 *
 * Split from `updater.ts` (which imports `electron` and `electron-updater`) so
 * the update router — and through it the whole `AppRouter` — stays importable
 * outside Electron. The web app mounts the same router; its actions are wired
 * to no-ops because a browser-served WeQ can't replace its own binary.
 */

import { EventEmitter } from 'node:events';
import type { BackgroundTask } from '../../shared/background_task';

export interface UpdateState {
  includePrerelease?: boolean;
  channel?: string;
  /** Running app version (app.getVersion()). */
  current: string;
  /** Latest version from the manifest, or null if never checked. */
  latest: string | null;
  /** Whether `latest` is newer than `current`. */
  hasUpdate: boolean;
  /** Fastest mirror's release base, or null. */
  base: string | null;
  /** Healthy mirror bases, fastest first (download fallback order). */
  ranked: string[];
  /**
   * This copy is installed by a distro package manager (AUR), so it can check
   * for updates but must not replace its own files — `pacman` owns them.
   * Set by the updater at check time; absent in older cached shapes.
   */
  managed?: boolean;
}

export interface UpdateProgress {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

export type UpdateDownloadTask = Pick<
  BackgroundTask,
  'id' | 'status' | 'statusLabel' | 'actions' | 'foreground' | 'note'
> & { version?: string; progress?: UpdateProgress };

export type UpdateEvent =
  | { kind: 'availability'; available: boolean }
  | { kind: 'download-task'; task: UpdateDownloadTask | null }
  /** Speed-test started — `mirrors` mirrors are being screened. */
  | { kind: 'checking'; mirrors: number }
  | { kind: 'check-failed' }
  /**
   * Speed-test done — `base` won, `ranked` is the full fallback order. Also
   * carries the version verdict so the UI can leave its "checking" state even
   * when there is no update (nothing else would tell it the check finished).
   */
  | { kind: 'chosen'; base: string; ranked: string[]; latest: string; hasUpdate: boolean }
  | { kind: 'available'; latest: string }
  | { kind: 'downloaded'; latest: string }
  | { kind: 'installing' }
  | { kind: 'error'; message: string };

export const updateBus = new EventEmitter();

export type UpdateBanner = Extract<UpdateEvent, { kind: 'available' | 'downloaded' }>;
let updateBanner: UpdateBanner | null = null;
const dismissedBanners = new Map<string, UpdateBanner['kind']>();
const bannerListeners = new Set<(banner: UpdateBanner | null) => void>();

function visibleUpdateBanner() {
  if (!updateBanner) return null;
  const dismissed = dismissedBanners.get(updateBanner.latest);
  return dismissed === 'downloaded' || dismissed === updateBanner.kind ? null : updateBanner;
}

function changeUpdateBanner(next: UpdateBanner | null) {
  if (next?.latest === updateBanner?.latest && next?.kind === updateBanner?.kind) return;
  const previous = visibleUpdateBanner();
  updateBanner = next;
  const visible = visibleUpdateBanner();
  if (previous !== visible) for (const listener of bannerListeners) listener(visible);
}

updateBus.on('event', (event: UpdateEvent) => {
  if (event.kind === 'downloaded') changeUpdateBanner(event);
  else if (event.kind === 'available') {
    if (updateBanner?.kind !== 'downloaded' || updateBanner.latest !== event.latest)
      changeUpdateBanner(event);
  } else if (
    event.kind === 'installing' ||
    (event.kind === 'chosen' && !event.hasUpdate) ||
    (event.kind === 'availability' && !event.available)
  )
    changeUpdateBanner(null);
});

export function subscribeUpdateBanner(listener: (banner: UpdateBanner | null) => void) {
  bannerListeners.add(listener);
  listener(visibleUpdateBanner());
  return () => bannerListeners.delete(listener);
}

export function dismissUpdateBanner(banner: UpdateBanner) {
  if (updateBanner?.latest !== banner.latest || updateBanner.kind !== banner.kind) return;
  if (!visibleUpdateBanner()) return;
  dismissedBanners.set(banner.latest, banner.kind);
  if (dismissedBanners.size > 32) dismissedBanners.delete(dismissedBanners.keys().next().value!);
  for (const listener of bannerListeners) listener(null);
}

/** Last check result, cached for the session (settings getState + startup red dot). */
let lastState: UpdateState | null = null;

export function getUpdateState(): UpdateState | null {
  return lastState;
}

export function setUpdateState(state: UpdateState | null): void {
  const wasAvailable = lastState?.hasUpdate === true;
  lastState = state;
  const available = state?.hasUpdate === true;
  if (available !== wasAvailable)
    updateBus.emit('event', { kind: 'availability', available } satisfies UpdateEvent);
}

/**
 * The shell-specific half of the update flow. The desktop app installs the
 * `electron-updater` implementation; hosts that can't self-update leave the
 * default no-op actions in place.
 */
export interface UpdateActions {
  getInterval(): number;
  setInterval(minutes: number): void;
  getPrerelease(): boolean;
  setPrerelease(enabled: boolean): void;
  check(force: boolean): Promise<UpdateState>;
  assertDownloadAvailable?(): void;
  startDownload(foreground?: boolean, pageId?: string): Promise<void>;
  getDownloadTask?(): UpdateDownloadTask | null;
  backgroundDownload?(id: string): void;
  forgetDownloadTask?(id: string): boolean;
  quitAndInstall(): void;
  /** False when this host can't self-update, so the UI can hide the card. */
  readonly supported: boolean;
}

const unsupported: UpdateActions = {
  getInterval: () => 60,
  setInterval: () => {},
  getPrerelease: () => false,
  setPrerelease: () => {},
  supported: false,
  async check() {
    return lastState ?? { current: '', latest: null, hasUpdate: false, base: null, ranked: [] };
  },
  async startDownload() {
    // No-op — nothing to install into.
  },
  quitAndInstall() {
    // No-op.
  },
};

let actions: UpdateActions = unsupported;

export function setUpdateActions(next: UpdateActions): void {
  actions = next;
}

export function getUpdateActions(): UpdateActions {
  return actions;
}
