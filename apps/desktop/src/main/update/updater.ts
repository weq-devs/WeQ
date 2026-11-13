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
import { TransferGate, shouldPauseTransfer } from '@weq/service/data-saver';
import { transferBehavior } from '@weq/service/network-scope';
import {
  transferOwner,
  transferRestricted,
  transferCanResume,
  watchTransferPolicy,
} from '@weq/service/transfer-policy';
import { refreshTransferPolicy, hostDataSaver } from '../data_saver';
import { backgroundTasks } from '../background_tasks';
import { DEFAULT_UPDATE_CHECK_INTERVAL_MINUTES } from '@weq/service/update-settings';
import { UpdateCheckScheduler } from './scheduler';
import { existsSync } from 'node:fs';
import semver from 'semver';
import electronUpdater from 'electron-updater';
import { FILE_MIRRORS, resolveBestMirror } from './mirrors';
import { announceUpdateAvailableSafe } from '../weq_assistant/update_tweet';
import {
  finishMacUpdate,
  installMacUpdate,
  prepareMacUpdate,
  usesMacVerifiedArchiveUpdater,
} from './mac';
import type { MacUpdatePlan } from './mac_install';
import { isPackageManaged, managedUpdateHint } from './managed';
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
let cancelDownload: (() => void) | undefined;
let updateGate: TransferGate | undefined;
let updateSizePolicy: ((bytes: number) => void) | undefined;

let lastCheckedAt = 0;
const CHECK_TTL_MS = 5 * 60_000;
let preferences = { get: () => false, set: (_enabled: boolean): void => {} };
let preferenceRevision = 0;
const intervalPreferences = {
  getInterval: () => DEFAULT_UPDATE_CHECK_INTERVAL_MINUTES,
  setInterval: (_minutes: number): void => {},
};
const updateScheduler = new UpdateCheckScheduler(async () => {
  if (downloading || downloaded || installing) return;
  try {
    await checkForUpdate(true);
  } catch (error) {
    updateBus.emit('event', { kind: 'check-failed' } satisfies UpdateEvent);
    throw error;
  }
});

export function startAutomaticUpdateChecks(): void {
  if (!app.isPackaged) return;
  updateScheduler.configure(intervalPreferences.getInterval(), true);
  app.once('will-quit', () => updateScheduler.stop());
}

export function setCheckPrerelease(enabled: boolean): void {
  if (downloading || installing) throw new Error('请等待当前更新完成后再切换测试版检查');
  preferences.set(enabled);
  preferenceRevision++;
  setUpdateState(null);
  downloaded = false;
  macPlan = null;
}

function isDev(): boolean {
  return !app.isPackaged;
}

/**
 * 运行环境是否由发行版包管理器托管（AUR）。每次现算而不是模块级常量：
 * 测试要能在同一个进程里切换两种形态，而真实运行中它不会变。
 */
function packageManaged(): boolean {
  return isPackageManaged({ env: process.env, execPath: process.execPath, exists: existsSync });
}

function isNewer(latest: string, current: string): boolean {
  const a = semver.valid(latest);
  const b = semver.valid(current);
  return a && b ? semver.gt(a, b) : false;
}

/**
 * Speed-test mirrors, read the manifest, compare versions. Emits `available`
 * when a newer version exists. Throws if no mirror is reachable.
 */
export async function checkForUpdate(force = false): Promise<UpdateState> {
  const current = app.getVersion();
  const cached = getUpdateState();
  const includePrerelease = preferences.get();
  const revision = preferenceRevision;
  if (
    !force &&
    cached &&
    cached.includePrerelease === includePrerelease &&
    Date.now() - lastCheckedAt < CHECK_TTL_MS
  ) {
    return cached;
  }

  // Let the UI show "testing N mirrors…" instead of a blank 4–6s wait: this is
  // the slow phase (every dead mirror burns its full screen timeout).
  updateBus.emit('event', { kind: 'checking', mirrors: FILE_MIRRORS.length } satisfies UpdateEvent);
  const best = await resolveBestMirror(undefined, includePrerelease, !(await hostDataSaver()));
  if (revision !== preferenceRevision) throw new Error('更新检查选项已改变，请重新检查');
  const hasUpdate = isNewer(best.version, current);
  const state: UpdateState = {
    includePrerelease,
    channel: best.channel,
    current,
    latest: best.version,
    hasUpdate,
    base: best.base,
    ranked: best.ranked,
    managed: packageManaged(),
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
let macVerifiedArchive = false;
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
    if (macVerifiedArchive) {
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
    autoUpdater.allowPrerelease = getUpdateState()?.includePrerelease === true;
    autoUpdater.channel = getUpdateState()?.channel ?? 'latest';
    autoUpdater.allowDowngrade = false;
    autoUpdater
      .checkForUpdates()
      .then((result) => {
        if (!result?.updateInfo) throw new Error('未获取到更新信息');
        const token = result.cancellationToken;
        if (!token) throw new Error('更新器未提供可取消的下载任务');
        cancelDownload = () => token.cancel();
        const sizes = result.updateInfo.files?.map((file) => file.size ?? 0) ?? [];
        const size = Math.max(0, ...sizes);
        if (size > 0) updateSizePolicy?.(size);
        if (updateGate?.paused) {
          token.cancel();
          throw new Error('省流量模式已暂停');
        }
        return autoUpdater.downloadUpdate(token);
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
  // 包管理器托管的副本没有可写的安装目录：与其让 autoUpdater 在全部镜像上
  // 失败一遍（Linux 走 AppImageUpdater，`$APPIMAGE` 不存在），不如直接给出正解。
  if (packageManaged()) throw new Error(managedUpdateHint(true) ?? '当前安装不支持自动更新。');
  if (downloading || installing) return;
  downloading = true;
  downloaded = false;
  try {
    await refreshTransferPolicy();
  } catch (error) {
    downloading = false;
    throw error;
  }
  const owner = transferOwner();
  const gate = new TransferGate();
  updateGate = gate;
  const taskId = backgroundTasks.start({ kind: 'update', name: '下载 WeQ 更新' });
  let total = 0;
  let received = 0;
  let policyPaused = false;
  const updatePolicy = () => {
    const behavior = transferBehavior();
    const restricted = transferRestricted(owner) || (policyPaused && !transferCanResume(owner));
    policyPaused = restricted;
    const blocked = shouldPauseTransfer(restricted, false, total, received, behavior);
    if (!blocked && gate.pauseReasons.includes('network') && !behavior.dataSaverAutoResume)
      gate.restrict('resume-required', true);
    if (!blocked && behavior.dataSaverAutoResume) gate.restrict('resume-required', false);
    gate.restrict('network', blocked);
    if (gate.paused) {
      cancelDownload?.();
      backgroundTasks.finish(taskId, 'paused', {
        statusLabel: gate.pauseReasons.includes('user') ? '已暂停' : '省流量模式已暂停',
      });
      backgroundTasks.setActions(taskId, [
        {
          id: 'continue',
          label: '继续下载',
          run: () => {
            gate.continue();
            updatePolicy();
          },
        },
      ]);
    } else {
      backgroundTasks.resume(taskId);
      backgroundTasks.setActions(taskId, [
        {
          id: 'pause',
          label: '暂停',
          run: () => {
            gate.pause();
            updatePolicy();
          },
        },
      ]);
    }
  };
  const progressPolicy = (progress: UpdateProgress) => {
    total = progress.total;
    received = progress.transferred;
    updatePolicy();
  };
  updateSizePolicy = (bytes) => {
    total = bytes;
    updatePolicy();
  };
  updateBus.on('progress', progressPolicy);
  const unwatch = watchTransferPolicy(updatePolicy);
  updatePolicy();
  try {
    await downloadUpdate();
    backgroundTasks.finish(taskId, 'completed');
  } catch (error) {
    backgroundTasks.resume(taskId);
    backgroundTasks.finish(taskId, 'failed', { note: String(error) });
    const message = error instanceof Error ? error.message : String(error);
    updateBus.emit('event', { kind: 'error', message } satisfies UpdateEvent);
    throw error;
  } finally {
    unwatch();
    updateBus.off('progress', progressPolicy);
    cancelDownload = undefined;
    updateGate = undefined;
    updateSizePolicy = undefined;
    backgroundTasks.setActions(taskId, []);
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

  macVerifiedArchive = usesMacVerifiedArchiveUpdater();
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
      for (;;) {
        await updateGate?.wait();
        try {
          await attemptDownload(base);
          break;
        } catch (error) {
          if (!updateGate?.paused) throw error;
        }
      }
      success = true;
      break;
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
    }
  }

  if (!success) throw lastErr ?? new Error('更新下载失败');
  if (macVerifiedArchive) {
    // 下载事件只说明 ZIP 已落地；官方哈希与固定发布身份通过后才允许安装。
    const update = macDownload as { file: string; version: string } | null;
    if (!update?.file) throw new Error('未取得 macOS 更新包路径');
    macPlan = await prepareMacUpdate(update.file, update.version, state.includePrerelease === true);
    downloaded = true;
    updateBus.emit('event', { kind: 'downloaded', latest: update.version } satisfies UpdateEvent);
  }
}

/** 安装已获用户确认，退出时不再重复询问普通助手依赖。 */
export function isInstallingUpdate(): boolean {
  return installing;
}

/** 下载验证完成后退出、安装并重新打开应用。 */
export function quitAndInstall(): void {
  if (isDev()) throw new Error('开发模式不支持自更新。');
  if (packageManaged()) throw new Error(managedUpdateHint(true) ?? '当前安装不支持自动更新。');
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
export function installUpdateActions(
  options?: typeof preferences & Partial<typeof intervalPreferences>,
): void {
  if (options) preferences = options;
  if (options?.getInterval) intervalPreferences.getInterval = options.getInterval;
  if (options?.setInterval) intervalPreferences.setInterval = options.setInterval;
  if (process.platform === 'darwin' && app.isPackaged) {
    // 等新版本真正完成首个页面加载，不能在原生初始化前就删除回退副本。
    app.once('browser-window-created', (_event, window) => {
      window.webContents.once('did-finish-load', () => {
        void finishMacUpdate();
      });
    });
  }
  setUpdateActions({
    getInterval: () => intervalPreferences.getInterval(),
    setInterval: (minutes) => {
      intervalPreferences.setInterval(minutes);
      if (app.isPackaged) updateScheduler.configure(minutes);
    },
    getPrerelease: () => preferences.get(),
    setPrerelease: setCheckPrerelease,
    supported: true,
    check: checkForUpdate,
    startDownload,
    quitAndInstall,
  });
}
