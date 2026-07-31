/**
 * Update types + the event bus and cached state that the router reads.
 *
 * Split from `updater.ts` (which imports `electron` and `electron-updater`) so
 * the update router — and through it the whole `AppRouter` — stays importable
 * outside Electron. The web app mounts the same router; its actions are wired
 * to no-ops because a browser-served WeQ can't replace its own binary.
 */

import { EventEmitter } from 'node:events';

export interface UpdateState {
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
}

export interface UpdateProgress {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

export type UpdateEvent =
  | { kind: 'available'; latest: string }
  | { kind: 'downloaded'; latest: string }
  | { kind: 'error'; message: string };

export const updateBus = new EventEmitter();

/** Last check result, cached for the session (settings getState + startup red dot). */
let lastState: UpdateState | null = null;

export function getUpdateState(): UpdateState | null {
  return lastState;
}

export function setUpdateState(state: UpdateState | null): void {
  lastState = state;
}

/**
 * The shell-specific half of the update flow. The desktop app installs the
 * `electron-updater` implementation; hosts that can't self-update leave the
 * default no-op actions in place.
 */
export interface UpdateActions {
  check(force: boolean): Promise<UpdateState>;
  startDownload(): Promise<void>;
  quitAndInstall(): void;
  /** False when this host can't self-update, so the UI can hide the card. */
  readonly supported: boolean;
}

const unsupported: UpdateActions = {
  supported: false,
  async check() {
    return (
      lastState ?? { current: '', latest: null, hasUpdate: false, base: null, ranked: [] }
    );
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
