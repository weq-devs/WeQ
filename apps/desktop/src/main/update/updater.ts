/**
 * In-app updater orchestration.
 *
 * Split of concerns:
 *   - CHECK  — our own lightweight path (see ./mirrors): speed-test the
 *     accelerators, read `latest.yml` from the fastest, semver-compare against
 *     the running version. Works in dev too (no Electron packaging needed).
 *   - DOWNLOAD + INSTALL — electron-updater's `autoUpdater` (generic provider),
 *     pointed at the winning mirror, for proven sha512-verified download +
 *     silent install + relaunch. macOS ad-hoc 构建另核官方包并由退出后助手替换，
 *     不使用绑定旧 cdhash 的 Squirrel。镜像下载错误仍按排名回退。
 *
 * State + events flow to the renderer through the `update` tRPC router:
 *   - `updateBus.emit('progress', UpdateProgress)`  → settings progress bar
 *   - `updateBus.emit('event', UpdateEvent)`        → available / downloaded / error
 */

import { app } from 'electron';
import semver from 'semver';
import electronUpdater from 'electron-updater';
import { FILE_MIRRORS, resolveBestMirror } from './mirrors';
import { announceUpdateAvailableSafe } from '../weq_assistant/update_tweet';
import { finishMacUpdate, installMacUpdate, prepareMacUpdate, usesMacAdhocUpdater } from './mac';
import type { MacUpdatePlan } from './mac_install';
import {
  getUpdateState,
  setUpdateActions,
  setUpdateState,
  updateBus,
  type UpdateEvent,
  type UpdateProgress,
  type UpdateState,
} from './state';

const { autoUpdater } = electronUpdater;

let lastCheckedAt = 0;
const CHECK_TTL_MS = 5 * 60_000;

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
  const cached = getUpdateState();
  if (!force && cached && Date.now() - lastCheckedAt < CHECK_TTL_MS) {
    return cached;
  }

  // Let the UI show "testing N mirrors…" instead of a blank 4–6s wait: this is
  // the slow phase (every dead mirror burns its full screen timeout).
  updateBus.emit('event', { kind: 'checking', mirrors: FILE_MIRRORS.length } satisfies UpdateEvent);
  const best = await resolveBestMirror();
  const hasUpdate = isNewer(best.version, current);
  const state: UpdateState = {
    current,
    latest: best.version,
    hasUpdate,
    base: best.base,
    ranked: best.ranked,
  };
  setUpdateState(state);
  lastCheckedAt = Date.now();

  // Surface which mirror won (and the fallback order) so the UI can say
  // "已选加速站：xxx" — the check is otherwise invisible.
  updateBus.emit('event', {
    kind: 'chosen',
    base: best.base,
    ranked: best.ranked,
    latest: best.version,
    hasUpdate,
  } satisfies UpdateEvent);

  if (hasUpdate) {
    updateBus.emit('event', { kind: 'available', latest: best.version } satisfies UpdateEvent);
    // WeQ 助手开着 → 追加一条「更新可用」推文（best-effort，同版本只发一次）。
    announceUpdateAvailableSafe(best.version);
  }
  return state;
}

let wired = false;
let downloaded = false;
let installing = false;
let downloading = false;
let macAdhoc = false;
let macDownload: { file: string; version: string } | null = null;
let macPlan: MacUpdatePlan | null = null;

function installFailed(error: unknown): void {
  installing = false;
  updateBus.emit('event', {
    kind: 'error',
    message: error instanceof Error ? error.message : String(error),
  } satisfies UpdateEvent);
}

/** Attach the persistent autoUpdater listeners once (progress + downloaded). */
function wireAutoUpdater(): void {
  if (wired) return;
  wired = true;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  // Differential download reports progress against "bytes of the *diff*", and
  // silently skips every block it copies from the local old installer — so the
  // bar sits at 0% for minutes and then jumps straight to 100%. A full download
  // is linear and always emits steady `download-progress`, which is what the
  // settings bar needs; the bytes saved by diffing don't pay for the UX here.
  autoUpdater.disableDifferentialDownload = true;

  autoUpdater.on('download-progress', (p) => {
    updateBus.emit('progress', {
      percent: p.percent,
      transferred: p.transferred,
      total: p.total,
      bytesPerSecond: p.bytesPerSecond,
    } satisfies UpdateProgress);
  });

  autoUpdater.on('update-downloaded', (info) => {
    if (macAdhoc) {
      macDownload = { file: info.downloadedFile, version: info.version };
      return;
    }
    downloaded = true;
    updateBus.emit('event', { kind: 'downloaded', latest: info.version } satisfies UpdateEvent);
  });

  // macOS 的系统准备／安装发生在下载 Promise 结束之后，仍需把错误送回界面。
  autoUpdater.on('error', (error) => {
    if (!installing) return;
    installFailed(error);
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
        if (!result?.updateInfo) throw new Error('未获取到更新信息');
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
  if (downloading || installing) return;
  downloading = true;
  downloaded = false;
  try {
    await downloadUpdate();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateBus.emit('event', { kind: 'error', message } satisfies UpdateEvent);
    throw error;
  } finally {
    downloading = false;
  }
}

async function downloadUpdate(): Promise<void> {
  if (!getUpdateState()?.hasUpdate) {
    await checkForUpdate(true);
  }
  const state = getUpdateState();
  const ranked = state?.ranked ?? [];
  if (!state?.hasUpdate || ranked.length === 0) {
    throw new Error('当前已是最新版本或没有可用的更新源。');
  }

  macAdhoc = await usesMacAdhocUpdater();
  macDownload = null;
  macPlan = null;
  wireAutoUpdater();

  let lastErr: Error | null = null;
  let success = false;
  for (const base of ranked) {
    try {
      // Let the UI name the mirror that's actually serving this attempt — the
      // first choice can fail mid-download and we silently fall back here.
      updateBus.emit('event', {
        kind: 'chosen',
        base,
        ranked,
        latest: state?.latest ?? '',
        hasUpdate: true,
      } satisfies UpdateEvent);
      await attemptDownload(base);
      success = true;
      break;
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
    }
  }

  if (!success) throw lastErr ?? new Error('更新下载失败');
  if (macAdhoc) {
    // MacUpdater 的应用层事件早于 Squirrel 验证；ad-hoc 必须另核官方包后才就绪。
    const update = macDownload as { file: string; version: string } | null;
    if (!update?.file) throw new Error('未取得 macOS 更新包路径');
    macPlan = await prepareMacUpdate(update.file, update.version);
    downloaded = true;
    updateBus.emit('event', { kind: 'downloaded', latest: update.version } satisfies UpdateEvent);
  }
}

/** 下载验证完成后退出、安装并重新打开应用。 */
export function quitAndInstall(): void {
  if (isDev()) throw new Error('开发模式不支持自更新。');
  if (!downloaded) throw new Error('更新尚未下载完成，请先下载更新。');
  if (installing) return;
  installing = true;
  updateBus.emit('event', { kind: 'installing' } satisfies UpdateEvent);
  // (isSilent, isForceRunAfter): silent install in place, then relaunch.
  try {
    if (macPlan) void installMacUpdate(macPlan).catch(installFailed);
    else autoUpdater.quitAndInstall(true, true);
  } catch (error) {
    installFailed(error);
    throw error;
  }
}

/** Wire this Electron implementation into the shell-agnostic update router. */
export function installUpdateActions(): void {
  if (process.platform === 'darwin' && app.isPackaged) {
    // 等新版本真正完成首个页面加载，不能在原生初始化前就删除回退副本。
    app.once('browser-window-created', (_event, window) => {
      window.webContents.once('did-finish-load', () => {
        void finishMacUpdate();
      });
    });
  }
  setUpdateActions({
    supported: true,
    check: checkForUpdate,
    startDownload,
    quitAndInstall,
  });
}
