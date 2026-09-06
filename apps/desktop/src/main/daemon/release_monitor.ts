/**
 * GitHub release 监控的 GUI 侧编排（Electron 主进程）。
 *
 * 分工（对应守护进程 release.rs 的约定）：
 *   - 守护进程：真正轮询 GitHub（Rust 实现），发现新版本置 `pending`；
 *   - 本模块：定期读 `release_watch_status`，看到 `pending` 就
 *       1) 发**系统通知**（Electron Notification，约定要求的弹窗方式）；
 *       2) 把 release 推文发布进 docroot + QQ（复用 WeQ 助手管线，推文内容
 *          取 CHANGELOG.md 对应章节，见 ./changelog.ts）；
 *       3) `release_ack` 告诉守护进程「已处理」，下一轮不再重复提醒。
 *
 * 通知与推文都成功（或推文 best-effort 失败但通知已弹出）后才 ack —— ack 即
 * 「用户已被提醒过」。守护进程重启后 pending 仍在，WeQ 重启也能补提醒一次。
 */

import { join } from 'node:path';
import { app, Notification, shell } from 'electron';
import {
  daemonReleaseWatchStatus,
  daemonReleaseAck,
  getLogger,
  logErrorContext,
  type DaemonReleaseWatchInfo,
} from '@weq/service';
import { publishReleasePages, type ReleasePageInput } from '../weq_assistant/release_page';
import { getReleaseChangelogEntry } from '../weq_assistant/changelog';
import { requireBootstrap } from '../context/app_context';
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
 * 确保 release 监控循环在跑（幂等）。开启 WeQ 助手（即守护进程 HTTP）时
 * 一并调用；守护进程不在时循环空转（每轮查询返回 null，下轮再试）。
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

/** 停止轮询（关 WeQ 助手时；守护进程的 GitHub 轮询独立存在，不受影响）。 */
export function stopReleaseMonitor(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  logger.info('release monitor stopped', { event: 'release-monitor-stop' });
}

/** 一轮：读状态 → 有 pending 就通知 + 发推文 + ack。 */
async function tick(): Promise<void> {
  if (!Notification.isSupported()) return; // 无通知能力的环境只发推文
  const status = await daemonReleaseWatchStatus();
  const pending = status?.pending;
  if (!pending) return;

  const version = pending.replace(/^v/i, '');
  logger.info('new release detected by daemon', {
    event: 'release-detected',
    version,
    latest: status?.latest_seen ?? null,
  });

  // 1) 系统通知（约定第 3 条：新 release 弹系统提示）。
  const releaseUrl = `https://github.com/H3CoF6/WeQ/releases/tag/v${version}`;
  lastReleaseUrl = releaseUrl;
  const entry = getReleaseChangelogEntry(version);
  const summary = entry?.summary ?? `WeQ ${version} 发布了，点击查看更新内容。`;
  showNotification(version, summary, releaseUrl);

  // 2) release 推文（WeQ 助手管线；未开助手 / 无账号时静默跳过）。
  await publishReleaseTweet(version, summary, releaseUrl);

  // 3) ack：守护进程清 pending、推进 current_version。
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

/**
 * 把 release 推文发布进 docroot 并（开着账号时）同步进 QQ。开关关闭 /
 * 无账号时只落 docroot（守护进程 HTTP 若在跑，卡片地址仍然可用）。
 * 全程 best-effort：失败记日志，不影响 ack（通知已经弹出过，不重复打扰）。
 */
async function publishReleaseTweet(
  version: string,
  summary: string,
  releaseUrl: string,
): Promise<void> {
  try {
    const userConfig = requireBootstrap().userConfig;
    const docroot = join(userConfig.cacheDir('weq-assistant'), 'docroot');
    const input: ReleasePageInput = {
      version,
      title: `WeQ ${version} 发布`,
      summary,
      releaseUrl,
    };
    const ok = await publishReleasePages(docroot, input);
    logger.info('release pages published', {
      event: 'weq-release-published',
      version,
      ok,
    });
  } catch (error) {
    // bootstrap 未就绪 / docroot 不存在（助手从未开启）→ 静默跳过。
    logger.info('skipped release tweet publish', {
      event: 'weq-release-publish-skipped',
      version,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** 应用版本（`1.2.3`，不带 v）。 */
export function currentAppVersion(): string {
  return app.getVersion();
}
