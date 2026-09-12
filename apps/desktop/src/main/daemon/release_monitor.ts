/**
 * GitHub release 监控的 GUI 侧编排（Electron 主进程）。
 *
 * 分工（对应守护进程 release.rs 的约定）：
 *   - 守护进程：真正轮询 GitHub（Rust 实现），发现新版本置 `pending`；
 *   - 本模块：定期读 `release_watch_status`，看到 `pending` 就
 *       1) 弹**系统通知**（Electron Notification，点击跳 GitHub release 页）；
 *       2) `release_ack` 告诉守护进程「已处理」，下一轮不再重复提醒。
 *
 * 这里只负责「提醒更新」；把新版本做成 WeQ 助手推文的逻辑由打包版应用内更新
 * 检查统一负责（update/updater.ts → weq_assistant/update_tweet.ts，写入
 * `/p/update` + 本地推文库 + QQ），本模块不再重复写 docroot / 库。
 *
 * ack 即「用户已被提醒过」。守护进程重启后 pending 仍在，WeQ 重启也能补提醒一次。
 */

import { app, Notification, shell } from 'electron';
import {
  daemonReleaseWatchStatus,
  daemonReleaseAck,
  getLogger,
  logErrorContext,
  type DaemonReleaseWatchInfo,
} from '@weq/service';
import { getReleaseChangelogEntry } from '../weq_assistant/changelog';
import { resolveResource } from '../resource';

const logger = getLogger().child({ scope: 'daemon-release-monitor' });

/** 设置页轮询间隔（守护进程自己在按小时轮 GitHub，这里只管「提醒」）。 */
const POLL_INTERVAL_MS = 30_000;

let timer: NodeJS.Timeout | null = null;
/** 通知里点「查看」要跳的 URL（按版本缓存，notification 回闭包取用）。 */
let lastReleaseUrl: string | null = null;

/** 当前守护进程的 release 状态快照（设置页查询用）。 */
export async function currentReleaseStatus(): Promise<DaemonReleaseWatchInfo | null> {
  return daemonReleaseWatchStatus();
}

/**
 * 确保 release 提醒循环在跑（幂等）。随 Electron 启动挂着；守护进程不在时
 * 循环空转（每轮查询返回 null，下轮再试），watching=false 也不产生提醒。
 */
export function startReleaseMonitor(): void {
  if (timer) return;
  timer = setInterval(() => {
    void tick().catch((error) => {
      logger.warn('release monitor tick failed', {
        event: 'release-monitor-tick-failed',
        ...logErrorContext(error),
      });
    });
  }, POLL_INTERVAL_MS);
  logger.info('release monitor started', { event: 'release-monitor-start' });
}

/** 停止提醒循环（保留给需要停用的调用方；守护进程的 GitHub 轮询独立存在，不受影响）。 */
export function stopReleaseMonitor(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  logger.info('release monitor stopped', { event: 'release-monitor-stop' });
}

/** 一轮：读状态 → 有 pending 就通知 + ack。 */
async function tick(): Promise<void> {
  if (!Notification.isSupported()) return; // 无通知途径：跳过本轮，pending 保留待下次重试
  const status = await daemonReleaseWatchStatus();
  const pending = status?.pending;
  if (!pending) return;

  const version = pending.replace(/^v/i, '');
  logger.info('new release detected by daemon', {
    event: 'release-detected',
    version,
    latest: status?.latest_seen ?? null,
  });

  // 1) 系统通知（新 release 的提醒方式）。
  const releaseUrl = `https://github.com/H3CoF6/WeQ/releases/tag/v${version}`;
  lastReleaseUrl = releaseUrl;
  const entry = getReleaseChangelogEntry(version);
  const summary = entry?.summary ?? `WeQ ${version} 发布了，点击查看更新内容。`;
  showNotification(version, summary, releaseUrl);

  // 2) ack：守护进程清 pending、推进 current_version。
  const after = await daemonReleaseAck(pending);
  logger.info('release acknowledged to daemon', {
    event: 'release-acked',
    version,
    pending: after?.pending ?? null,
  });
}

/** 发系统通知；点击跳 GitHub release 页。 */
function showNotification(version: string, summary: string, releaseUrl: string): void {
  const notification = new Notification({
    title: `WeQ ${version} 发布了`,
    body: summary,
    icon: resolveResource('brand', 'logo.png') ?? undefined,
  });
  notification.on('click', () => {
    void shell.openExternal(lastReleaseUrl ?? releaseUrl);
  });
  notification.show();
}

/** 应用版本（`1.2.3`，不带 v）。 */
export function currentAppVersion(): string {
  return app.getVersion();
}
