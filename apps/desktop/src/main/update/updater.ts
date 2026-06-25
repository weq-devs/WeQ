/**
 * In-app updater orchestration.
 *
 * Split of concerns:
 *   - CHECK  — our own lightweight path (see ./mirrors): speed-test the
 *     accelerators, read `latest.yml` from the fastest, semver-compare against
 *     the running version. Works in dev too (no Electron packaging needed).
 *   - DOWNLOAD + INSTALL — electron-updater's `autoUpdater` (generic provider),
 *     pointed at the winning mirror, for proven sha512-verified download +
 *     silent NSIS install + relaunch. On a mirror error we fall back down the
 *     ranked list before giving up.
 *
 * State + events flow to the renderer through the `update` tRPC router:
 *   - `updateBus.emit('progress', UpdateProgress)`  → settings progress bar
 *   - `updateBus.emit('event', UpdateEvent)`        → available / downloaded / error
 */

import { app } from 'electron';
import { EventEmitter } from 'node:events';
import semver from 'semver';
import electronUpdater from 'electron-updater';
import { resolveBestMirror } from './mirrors';

const { autoUpdater } = electronUpdater;

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
let lastCheckedAt = 0;
const CHECK_TTL_MS = 5 * 60_000;

export function getUpdateState(): UpdateState | null {
  return lastState;
}

function isDev(): boolean {
  return !app.isPackaged;
}

function isNewer(latest: string, current: string): boolean {
  const a = semver.coerce(latest);
  const b = semver.coerce(current);
  return a && b ? semver.gt(a, b) : false;
}

/**
 * Speed-test mirrors, read the manifest, compare versions. Emits `available`
 * when a newer version exists. Throws if no mirror is reachable.
 */
export async function checkForUpdate(force = false): Promise<UpdateState> {
  const current = app.getVersion();
  if (!force && lastState && Date.now() - lastCheckedAt < CHECK_TTL_MS) {
    return lastState;
  }

  const best = await resolveBestMirror();
  const hasUpdate = isNewer(best.version, current);
  lastState = {
    current,
    latest: best.version,
    hasUpdate,
    base: best.base,
    ranked: best.ranked,
  };
  lastCheckedAt = Date.now();

  if (hasUpdate) {
    updateBus.emit('event', { kind: 'available', latest: best.version } satisfies UpdateEvent);
  }
  return lastState;
}

let wired = false;

/** Attach the persistent autoUpdater listeners once (progress + downloaded). */
function wireAutoUpdater(): void {
  if (wired) return;
  wired = true;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('download-progress', (p) => {
    updateBus.emit('progress', {
      percent: p.percent,
      transferred: p.transferred,
      total: p.total,
      bytesPerSecond: p.bytesPerSecond,
    } satisfies UpdateProgress);
  });

  autoUpdater.on('update-downloaded', (info) => {
    updateBus.emit('event', { kind: 'downloaded', latest: info.version } satisfies UpdateEvent);
  });
}

/** One download attempt against a single mirror base. Resolves on success. */
function attemptDownload(base: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const onError = (e: Error): void => finish(e);
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      autoUpdater.off('error', onError);
      if (err) reject(err);
      else resolve();
    };

    autoUpdater.on('error', onError);
    autoUpdater.setFeedURL({ provider: 'generic', url: base });
    autoUpdater
      .checkForUpdates()
      .then((result) => {
        if (!result || !result.updateInfo) throw new Error('未获取到更新信息');
        return autoUpdater.downloadUpdate();
      })
      .then(() => finish())
      .catch((e: unknown) => finish(e instanceof Error ? e : new Error(String(e))));
  });
}

/**
 * Download the update, walking the ranked mirror list until one succeeds.
 * Progress + the terminal `downloaded` event reach the renderer over
 * `updateBus`. A total failure emits an `error` event and rejects.
 */
export async function startDownload(): Promise<void> {
  if (isDev()) throw new Error('开发模式不支持自更新，请使用打包后的安装版。');

  if (!lastState?.hasUpdate || lastState.ranked.length === 0) {
    await checkForUpdate(true);
  }
  const ranked = lastState?.ranked ?? [];
  if (!lastState?.hasUpdate || ranked.length === 0) {
    throw new Error('当前已是最新版本或没有可用的更新源。');
  }

  wireAutoUpdater();

  let lastErr: Error | null = null;
  for (const base of ranked) {
    try {
      await attemptDownload(base);
      return; // success — 'update-downloaded' already notified the renderer
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
    }
  }

  const message = lastErr?.message ?? '更新下载失败';
  updateBus.emit('event', { kind: 'error', message } satisfies UpdateEvent);
  throw new Error(message);
}

/** Quit, run the downloaded NSIS installer silently, and relaunch. */
export function quitAndInstall(): void {
  if (isDev()) throw new Error('开发模式不支持自更新。');
  // (isSilent, isForceRunAfter): silent install in place, then relaunch.
  autoUpdater.quitAndInstall(true, true);
}
