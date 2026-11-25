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
import { z } from 'zod/v3';
import { JsonStore } from '@weq/service/json-store';
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
import {
  downloadTaskReceipt,
  downloadTaskSnapshot,
  isPendingDownload,
} from '../download_task_receipt';
import { holdDownloadOnPage } from '../download_page';
import { DEFAULT_UPDATE_CHECK_INTERVAL_MINUTES } from '@weq/service/update-settings';
import { UpdateCheckScheduler } from './scheduler';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
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
  type UpdateDownloadTask,
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
  clearInstallTaskActions();
  restoreUpdateTask();
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
  updateBus.emit('event', {
    kind: 'checking',
    mirrors: Math.min(3, FILE_MIRRORS.length),
  } satisfies UpdateEvent);
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
  emitDownloadTask();
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
let archiveDownload: { file: string; version: string } | null = null;
let macPlan: MacUpdatePlan | null = null;
let activeTaskId: string | undefined;
let latestTaskId: string | undefined;
let lastDownload: UpdateReceipt | undefined;
let lastProgress: UpdateProgress | undefined;
let lastDownloadEvent = 'null';
const updateReceipt = downloadTaskReceipt.extend({
  version: z
    .string()
    .refine((value) => !!semver.valid(value))
    .optional(),
  channel: z.string().optional(),
  includePrerelease: z.boolean(),
});
type UpdateReceipt = z.infer<typeof updateReceipt>;
let downloadStore: JsonStore<{ current?: UpdateReceipt }> | undefined;

function updatePresentation(version?: string) {
  return {
    kind: 'update' as const,
    name: '下载 WeQ 更新',
    display: { action: '下载 WeQ 更新', subject: version },
  };
}

function getDownloadTask(): UpdateDownloadTask | null {
  const saved = lastDownload;
  if (!saved) return null;
  const latest = getUpdateState()?.latest;
  if (!downloading && !downloaded && latest && saved.version && saved.version !== latest)
    return null;
  const task = backgroundTasks.snapshot().find((item) => item.id === saved.id);
  if (!task || task.status === 'cancelled' || (task.status === 'completed' && !downloaded))
    return null;
  const { id, status, statusLabel, actions, foreground, note } = task;
  return {
    id,
    status,
    statusLabel,
    actions,
    foreground,
    note,
    version: saved.version,
    progress: lastProgress,
  };
}

function emitDownloadTask() {
  const task = getDownloadTask();
  const key = JSON.stringify(
    task && [task.id, task.status, task.statusLabel, task.actions, task.foreground, task.version],
  );
  if (key === lastDownloadEvent) return;
  lastDownloadEvent = key;
  updateBus.emit('event', { kind: 'download-task', task } satisfies UpdateEvent);
}

function backgroundDownload(id: string) {
  const saved = lastDownload;
  const task = getDownloadTask();
  if (task?.id !== id || saved?.id !== id || !task.foreground || !isPendingDownload(task.status))
    return;
  const updated = { ...saved, foreground: false };
  try {
    downloadStore?.replace({ current: updated }, true);
  } catch (error) {
    console.warn('[更新] 任务记录保存失败', error);
  }
  lastDownload = updated;
  backgroundTasks.setForeground(id, false);
  emitDownloadTask();
}

function restoreUpdateTask() {
  const saved = lastDownload;
  if (!saved) return;
  const { version, channel: _channel, includePrerelease, ...task } = saved;
  latestTaskId = saved.id;
  const installed = version !== undefined && !isNewer(version, app.getVersion());
  const channelChanged = includePrerelease !== preferences.get();
  const managed = packageManaged();
  const matches = !installed && !channelChanged && !managed;
  const status = matches
    ? saved.status === 'failed'
      ? 'failed'
      : 'paused'
    : installed && saved.status === 'completed'
      ? 'completed'
      : 'cancelled';
  backgroundTasks.project(
    {
      ...task,
      ...updatePresentation(version),
      foreground: Boolean(saved.foreground) && !isPendingDownload(saved.status),
      status,
      statusLabel: status === 'paused' ? '等待继续' : undefined,
      note: installed
        ? '当前 WeQ 已达到该版本，无需继续下载。'
        : managed
          ? '当前由包管理器维护，请通过包管理器更新。'
          : channelChanged
            ? '更新渠道已变更，请在版本与更新中重新检查。'
            : status === 'paused'
              ? '继续时会重新核对版本；完整的安装包可校验复用，未完成的会重新下载。'
              : saved.note,
      actions: [],
    },
    matches ? [retryUpdateAction(saved.id, status === 'failed' ? 'retry' : 'continue')] : [],
  );
  emitDownloadTask();
}

function forgetDownloadTask(id: string) {
  if (activeTaskId === id) return false;
  if (downloadStore?.data.current?.id === id) downloadStore.replace({}, true);
  if (lastDownload?.id === id) lastDownload = undefined;
  emitDownloadTask();
  return true;
}

function clearInstallTaskActions() {
  if (latestTaskId) backgroundTasks.setActions(latestTaskId, []);
}

function retryUpdateAction(id: string, action: 'retry' | 'continue') {
  return {
    id: action,
    label: action === 'retry' ? '重试下载' : '继续下载',
    run: () => {
      assertDownloadAvailable();
      if (lastDownload?.id !== id) throw new Error('更新任务已变更，请重新检查更新');
      void startDownload(id).catch(() => {});
    },
  };
}

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
    if (macVerifiedArchive || process.platform === 'linux') {
      archiveDownload = { file: info.downloadedFile, version: info.version };
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
const UPDATE_PAUSED = new Error('更新下载已暂停');
function attemptDownload(base: string, state: UpdateState): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let paused = false;
    const onError = (e: Error): void => finish(e);
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      cancelDownload = undefined;
      autoUpdater.off('error', onError);
      if (err) reject(paused ? UPDATE_PAUSED : err);
      else resolve();
    };

    autoUpdater.on('error', onError);
    autoUpdater.setFeedURL({ provider: 'generic', url: base });
    autoUpdater.allowPrerelease = state.includePrerelease === true;
    autoUpdater.channel = state.channel ?? 'latest';
    autoUpdater.allowDowngrade = false;
    autoUpdater
      .checkForUpdates()
      .then((result) => {
        if (!result?.updateInfo) throw new Error('未获取到更新信息');
        if (result.updateInfo.version !== state.latest)
          throw new Error('下载源返回了不同版本的更新清单');
        const token = result.cancellationToken;
        if (!token) throw new Error('更新器未提供可取消的下载任务');
        cancelDownload = () => {
          if (paused) return;
          paused = true;
          token.cancel();
        };
        const sizes = result.updateInfo.files?.map((file) => file.size ?? 0) ?? [];
        const size = Math.max(0, ...sizes);
        if (size > 0) updateSizePolicy?.(size);
        if (updateGate?.paused) cancelDownload?.();
        if (paused) throw UPDATE_PAUSED;
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
function assertDownloadAvailable() {
  if (isDev()) throw new Error('开发模式不支持自更新，请使用打包后的安装版。');
  // 包管理器托管的副本没有可写的安装目录：与其让 autoUpdater 在全部镜像上
  // 失败一遍（Linux 走 AppImageUpdater，`$APPIMAGE` 不存在），不如直接给出正解。
  if (packageManaged()) throw new Error(managedUpdateHint(true) ?? '当前安装不支持自动更新。');
}

export async function startDownload(
  resumeId?: string,
  foreground?: boolean,
  pageId?: string,
): Promise<void> {
  assertDownloadAvailable();
  if (downloading || installing) return;
  const saved = lastDownload;
  const savedTask = saved && backgroundTasks.snapshot().find((task) => task.id === saved.id);
  const check = getUpdateState();
  const includePrerelease = preferences.get();
  let version = check?.hasUpdate ? (check.latest ?? undefined) : undefined;
  let channel = version ? (check?.channel ?? 'latest') : undefined;
  const reuse =
    savedTask &&
    saved &&
    savedTask.status !== 'cancelled' &&
    saved.includePrerelease === includePrerelease &&
    (resumeId === saved.id ||
      (savedTask.status !== 'completed' &&
        (!version ||
          !saved.version ||
          (saved.version === version && (!saved.channel || saved.channel === channel)))));
  if (resumeId && !reuse) throw new Error('更新任务已变更，请重新检查更新');
  if (reuse && saved.version) version = saved.version;
  if (reuse && saved.channel) channel = saved.channel;
  const expectedVersion = version;
  const expectedChannel = channel;
  downloading = true;
  downloaded = false;
  lastProgress = undefined;
  clearInstallTaskActions();
  if (pageId) {
    foreground =
      (!reuse || Boolean(savedTask.foreground)) &&
      holdDownloadOnPage(pageId, 'software-update', () => backgroundDownload(taskId));
  }
  const taskId = reuse
    ? saved.id
    : backgroundTasks.start({ ...updatePresentation(version), foreground });
  if (reuse && foreground !== undefined) backgroundTasks.setForeground(taskId, foreground);
  latestTaskId = taskId;
  activeTaskId = taskId;
  backgroundTasks.resume(taskId);
  backgroundTasks.update(taskId, { progress: undefined, note: undefined });
  const persist = () => {
    const task = backgroundTasks.snapshot().find((item) => item.id === taskId);
    if (!task) return;
    lastDownload = { ...downloadTaskSnapshot(task), version, channel, includePrerelease };
    emitDownloadTask();
    if (!downloadStore) return;
    const previous = downloadStore.data.current;
    if (
      previous?.id === taskId &&
      previous.status === task.status &&
      previous.foreground === task.foreground &&
      previous.version === version &&
      previous.channel === channel &&
      previous.statusLabel === task.statusLabel &&
      Math.floor((previous.progress ?? 0) / 10) === Math.floor((task.progress ?? 0) / 10)
    )
      return;
    try {
      downloadStore.replace({ current: lastDownload }, true);
    } catch (error) {
      console.warn('[更新] 任务记录保存失败', error);
    }
  };
  persist();
  const gate = new TransferGate();
  if (resumeId && savedTask?.status === 'paused') gate.continue();
  updateGate = gate;
  let owner = transferOwner();
  let total = 0;
  let received = 0;
  let policyPaused = false;
  let verifying = false;
  const updatePolicy = () => {
    if (verifying) return;
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
    persist();
  };
  const progressPolicy = (progress: UpdateProgress) => {
    lastProgress = progress;
    total = progress.total;
    received = progress.transferred;
    updatePolicy();
    backgroundTasks.update(taskId, {
      progress: total > 0 ? (received / total) * 100 : undefined,
      note: `${(received / 1048576).toFixed(1)} / ${total > 0 ? (total / 1048576).toFixed(1) : '未知'} MiB`,
    });
    persist();
  };
  updateSizePolicy = (bytes) => {
    total = bytes;
    updatePolicy();
  };
  let unwatch: (() => void) | undefined;
  try {
    await refreshTransferPolicy();
    owner = transferOwner();
    updateBus.on('progress', progressPolicy);
    unwatch = watchTransferPolicy(updatePolicy);
    updatePolicy();
    await downloadUpdate(
      expectedVersion,
      expectedChannel,
      (latest, selectedChannel) => {
        version = latest;
        channel = selectedChannel;
        backgroundTasks.update(taskId, { display: updatePresentation(latest).display });
        persist();
      },
      () => {
        verifying = true;
        backgroundTasks.resume(taskId);
        backgroundTasks.update(taskId, { statusLabel: '正在校验更新包' });
        backgroundTasks.setActions(taskId, []);
        persist();
      },
    );
    backgroundTasks.resume(taskId);
    backgroundTasks.finish(taskId, 'completed', { note: '更新包已下载，等待重启安装' });
    backgroundTasks.setActions(taskId, [
      {
        id: 'install',
        label: '重启并安装',
        run: () => {
          if (latestTaskId !== taskId) throw new Error('请选择当前已下载的更新');
          quitAndInstall();
        },
      },
    ]);
  } catch (error) {
    backgroundTasks.resume(taskId);
    const message = error instanceof Error ? error.message : String(error);
    backgroundTasks.finish(taskId, 'failed', { note: message });
    backgroundTasks.setActions(taskId, [retryUpdateAction(taskId, 'retry')]);
    updateBus.emit('event', { kind: 'error', message } satisfies UpdateEvent);
    throw error;
  } finally {
    unwatch?.();
    updateBus.off('progress', progressPolicy);
    cancelDownload = undefined;
    updateGate = undefined;
    updateSizePolicy = undefined;
    persist();
    activeTaskId = undefined;
    downloading = false;
  }
}

async function downloadUpdate(
  expectedVersion: string | undefined,
  expectedChannel: string | undefined,
  target: (version: string, channel: string) => void,
  verify: () => void,
): Promise<void> {
  if (!getUpdateState()?.hasUpdate) {
    await checkForUpdate(true);
  }
  const state = getUpdateState();
  const ranked = state?.ranked ?? [];
  if (!state?.hasUpdate || !state.latest || ranked.length === 0) {
    throw new Error('当前已是最新版本或没有可用的更新源。');
  }
  if (expectedVersion && state.latest !== expectedVersion)
    throw new Error(
      `原任务是 ${expectedVersion}，当前可用版本为 ${state.latest}；请在版本与更新中明确发起新下载。`,
    );
  const channel = state.channel ?? 'latest';
  if (expectedChannel && channel !== expectedChannel)
    throw new Error('原任务的更新渠道已变更，请在版本与更新中明确发起新下载。');
  target(state.latest, channel);

  macVerifiedArchive = usesMacVerifiedArchiveUpdater();
  archiveDownload = null;
  macPlan = null;
  wireAutoUpdater();

  let lastErr: Error | null = null;
  let success = false;
  for (const base of ranked.slice(0, 8)) {
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
          await attemptDownload(base, state);
          break;
        } catch (error) {
          if (error !== UPDATE_PAUSED && !updateGate?.paused) throw error;
        }
      }
      success = true;
      break;
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
    }
  }

  if (!success) throw lastErr ?? new Error('更新下载失败');
  if (macVerifiedArchive || process.platform === 'linux') verify();
  if (macVerifiedArchive) {
    // 下载事件只说明 ZIP 已落地；官方哈希与固定发布身份通过后才允许安装。
    const update = archiveDownload as { file: string; version: string } | null;
    if (!update?.file || update.version !== state.latest)
      throw new Error('macOS 更新包与已检查版本不一致，未安装');
    macPlan = await prepareMacUpdate(update.file, update.version, state.includePrerelease === true);
    downloaded = true;
    updateBus.emit('event', { kind: 'downloaded', latest: update.version } satisfies UpdateEvent);
  } else if (process.platform === 'linux') {
    const update = archiveDownload as { file: string; version: string } | null;
    if (
      !update?.file ||
      update.version !== state.latest ||
      !semver.valid(update.version) ||
      !semver.gt(update.version, state.current)
    )
      throw new Error('Linux 更新包与已检查版本不一致，未安装');
    const arch = process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'arm64' : null;
    const fileName = `weQ-${update.version}-linux-${arch}.AppImage`;
    const { basename } = await import('node:path');
    if (!arch || basename(update.file) !== fileName)
      throw new Error('Linux 更新包架构或文件名不一致，未安装');
    const { fetchOfficialArchive, verifyOfficialArchive } = await import('./official_archive');
    const expected = await fetchOfficialArchive(
      update.version,
      fileName,
      state.includePrerelease === true,
    );
    await verifyOfficialArchive(update.file, expected);
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
  options?: typeof preferences & Partial<typeof intervalPreferences> & { dataRoot?: string },
): void {
  if (options) preferences = options;
  if (options?.getInterval) intervalPreferences.getInterval = options.getInterval;
  if (options?.setInterval) intervalPreferences.setInterval = options.setInterval;
  if (options?.dataRoot && !isDev()) {
    downloadStore = new JsonStore(
      join(options.dataRoot, `app-update-task-${process.platform}-${process.arch}.json`),
      () => ({}),
      {
        normalize: (value) => z.object({ current: updateReceipt.optional() }).parse(value),
      },
    );
    lastDownload = downloadStore.data.current;
    restoreUpdateTask();
  }
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
    assertDownloadAvailable,
    startDownload: (foreground, pageId) => startDownload(undefined, foreground, pageId),
    getDownloadTask,
    backgroundDownload,
    forgetDownloadTask,
    quitAndInstall,
  });
}
