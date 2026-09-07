/**
 * 「更新可用」推文 —— 应用内更新检查（打包版）发现新版本时，把一条
 * 「WeQ x.y.z 更新可用」推文发进 WeQ 助手。
 *
 * 守护进程 Release 监控（daemon/release_monitor.ts）只负责发现新版本时弹系统
 * 通知；本模块是唯一把新版本写成 WeQ 助手推文的入口，由应用自身的更新检查
 * （`update/updater.ts` 的 checkForUpdate）触发，路由固定 `/p/update` +
 * `/cover/update`。
 *
 * 全程 best-effort：助手未开启 / bootstrap 未就绪 / 无账号时静默跳过。
 * 推文先写本地库（tweets.ts），同版本只入库一次；账号在线时立即注入 QQ，
 * 否则等下次账号打开 / 助手开关同步时由 syncTweets 自然补上。
 */

import { join } from 'node:path';
import { publishReleasePages, type ReleasePageInput } from './release_page';
import { addTweet, loadTweets, tweetsStorePath } from './tweets';
import { getReleaseChangelogEntry } from './changelog';
import { WeqAssistantService, getLogger, logErrorContext } from '@weq/service';
import { getAppContext, requireBootstrap } from '../context/app_context';
import { resolveResource } from '../resource';

const logger = getLogger().child({ scope: 'weq-assistant-update' });

/** 更新推文的固定路由名（/p/update + /cover/update）。 */
const SLUG = 'update';

/** fire-and-forget 入口：checkForUpdate 里调用，永不抛错。 */
export function announceUpdateAvailableSafe(version: string): void {
  void announceUpdateAvailable(version).catch((error) => {
    logger.warn('update announcement failed', {
      event: 'weq-update-announce-failed',
      version,
      ...logErrorContext(error),
    });
  });
}

/** 发布「更新可用」推文（页面 + 封面 + 本地推文库 + 尽快注入 QQ）。 */
export async function announceUpdateAvailable(version: string): Promise<void> {
  const v = version.replace(/^v/i, '');
  const userConfig = requireBootstrap().userConfig;

  // 只有开着 WeQ 助手才发 —— 关着的时候连 docroot 都不该动。
  if (!userConfig.getSettings().weqAssistant.enabled) {
    logger.info('assistant disabled, skip update announcement', {
      event: 'weq-update-announce-skipped',
      version: v,
    });
    return;
  }

  const assistantDir = userConfig.cacheDir('weq-assistant');
  const docroot = join(assistantDir, 'docroot');

  // 内容约定与 release 推文一致：正文取 CHANGELOG 对应章节的第一条 bullet。
  const entry = getReleaseChangelogEntry(v);
  const summary = entry?.summary ?? `WeQ ${v} 已发布，点击查看更新内容。`;
  const releaseUrl = `https://github.com/H3CoF6/WeQ/releases/tag/v${v}`;
  const title = `WeQ ${v} 更新可用`;
  const input: ReleasePageInput = { version: v, title, summary, releaseUrl, slug: SLUG };

  // 页面 / 封面幂等重发（主题变更后也随重发刷新）。
  const pagesOk = await publishReleasePages(docroot, input);
  logger.info('update pages published', {
    event: 'weq-update-published',
    version: v,
    ok: pagesOk,
  });

  // 同一版本只入库一次（coverPath + title 判重）。
  const storePath = tweetsStorePath(assistantDir);
  if (loadTweets(storePath).some((t) => t.coverPath === `/cover/${SLUG}` && t.title === title)) {
    return;
  }
  const tweet = addTweet(storePath, {
    coverPath: `/cover/${SLUG}`,
    pagePath: `/p/${SLUG}`,
    title,
    contentText: summary,
    prompt: `[WeQ助手] 新版本 v${v}`,
    previewText: `[WeQ助手] 发现新版本 v${v}`,
  });

  // 账号在线且助手在跑 → 立即注入；否则等下次账号打开 / 开关同步时由
  // syncTweets 按本地推文库自然补上。静态账号禁止写助手头像（与
  // app_context.applyWeqAssistant 同一约定）。
  const ctx = getAppContext();
  if (ctx.account && ctx.platform) {
    const port = userConfig.getSettings().weqAssistant.port;
    const svc = new WeqAssistantService(
      ctx.account,
      ctx.platform,
      userConfig.getWeqAssistantUid(),
      !ctx.accountIsStatic,
    );
    const logo = resolveResource('brand', 'logo.png') ?? undefined;
    await svc.injectTweet(port, tweet, logo);
    logger.info('update tweet injected', { event: 'weq-update-injected', version: v });
  }
}
