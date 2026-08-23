/**
 * `groupFeedback.*` — 项目交流群里的「反馈 bug」弹窗后端。
 *
 * 两条路径：
 *   1. submitNewBug  —— 标题 + Markdown 正文打包到缓存目录（含两份最新日志），
 *      用闪传发到群聊；拿到 filesetId 立即发送，上传在后台继续。
 *   2. submitIssueArk —— 把已有的 GitHub issue/PR 以图文 Ark 卡片发到群聊
 *      （标题 = issue/pr #N，预览图 = 群头像）。
 *
 * listIssues 从 GitHub API 拉 open 的 issue/PR（带短缓存 + 超时）；拉不到时
 * 前端回落到手动输入标题 + 编号。
 */

import { z } from 'zod';
import { existsSync } from 'node:fs';
import type { NtHelperBinding } from '@weq/native';
import { getLogger } from '@weq/service';
import { getAppContext, type AccountServices } from '../../context/app_context';
import { resolveResource } from '../../resource';
import { procedure, router } from '../trpc';
import { PROJECT_GROUP_IDS } from '../../../shared/project_groups';
import { bundleFeedbackFiles } from './help';

const logger = getLogger().child({ scope: 'group-feedback' });

const REPO = 'H3CoF6/WeQ';
const GITHUB_API = `https://api.github.com/repos/${REPO}/issues`;

export interface GithubIssueItem {
  number: number;
  title: string;
  url: string;
  kind: 'issue' | 'pr';
}

/** GitHub 列表短缓存（避免弹窗反复点击打爆匿名配额）。 */
let issuesCache: { at: number; items: GithubIssueItem[] } | null = null;
const ISSUES_CACHE_TTL_MS = 30_000;

function requireServices(): AccountServices {
  const ctx = getAppContext();
  if (!ctx.services) throw new Error('No account session open — call bootstrap.openAccount first.');
  return ctx.services;
}

/** QQ 在线（有已登录进程 + 已注入 hook 前置）检查，返回发包所需句柄。 */
function requireOnlineQq(): {
  nt: Pick<NtHelperBinding, 'sendOidbPacket'>;
  pid: number;
  uin: string;
} {
  const ctx = getAppContext();
  const services = requireServices();
  const nt = ctx.platform?.native.ntHelper;
  const record = services.accountConfig.getRecord();
  const uin = ctx.account?.context.uin;
  if (!nt || !uin || !record?.qqOnline || !record.qqPid) {
    throw new Error('需要先登录该账号的 QQ 客户端。');
  }
  if (ctx.bootstrap?.userConfig.getSettings().autoInjectQq === false) {
    throw new Error('已开启完全离线模式（自动注入 QQ 已关闭），反馈发送需要在线 QQ。');
  }
  return { nt, pid: record.qqPid, uin };
}

/** 群里「已有 issue/PR」卡片的预览图 —— 群头像 CDN URL（0 = 原图）。 */
function groupAvatarUrl(groupId: string, size = 0): string {
  return `https://p.qlogo.cn/gh/${groupId}/${groupId}/${size}`;
}

async function fetchGithubIssues(): Promise<GithubIssueItem[]> {
  const now = Date.now();
  if (issuesCache && now - issuesCache.at < ISSUES_CACHE_TTL_MS) {
    return issuesCache.items;
  }
  const resp = await fetch(`${GITHUB_API}?state=open&per_page=50&sort=updated`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'WeQ' },
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) {
    throw new Error(`GitHub API ${resp.status} ${resp.statusText}`);
  }
  const raw = (await resp.json()) as Array<{
    number: number;
    title: string;
    html_url: string;
    pull_request?: { url: string };
  }>;
  const items = raw.map((it) => ({
    number: it.number,
    title: it.title,
    url: it.html_url,
    kind: it.pull_request ? ('pr' as const) : ('issue' as const),
  }));
  issuesCache = { at: now, items };
  return items;
}

export const groupFeedbackRouter = router({
  /** QQ 是否在线（决定头部 bug 图标亮/灰）。 */
  status: procedure.query((): { online: boolean; pid: number | null } => {
    const ctx = getAppContext();
    const record = ctx.services?.accountConfig.getRecord();
    const online = Boolean(record?.qqOnline && record.qqPid);
    return { online, pid: online ? (record?.qqPid ?? null) : null };
  }),

  /** 拉取仓库 open 的 issue/PR 列表（连不上 GitHub 时前端回落手动输入）。 */
  listIssues: procedure.query(
    async (): Promise<
      { ok: true; items: GithubIssueItem[] } | { ok: false; reason: 'error'; message: string }
    > => {
      try {
        return { ok: true, items: await fetchGithubIssues() };
      } catch (e) {
        return {
          ok: false,
          reason: 'error',
          message: e instanceof Error ? e.message : String(e),
        };
      }
    },
  ),

  /**
   * 路径 1：新 bug —— 正文 + 两份最新日志打包到缓存目录，闪传发到群聊。
   * 拿到 filesetId 立即发送（不等上传完成）。
   */
  submitNewBug: procedure
    .input(
      z.object({
        groupId: z.string().min(1),
        title: z.string().min(1).max(200),
        body: z.string().min(1),
      }),
    )
    .mutation(
      async ({
        input,
      }): Promise<
        | { ok: true; filesetUuid: string; shareUrl: string; folder: string }
        | { ok: false; reason: 'offline' | 'offline-mode' | 'bundle' | 'send'; message: string }
      > => {
        if (!PROJECT_GROUP_IDS.includes(input.groupId)) {
          return { ok: false, reason: 'send', message: '该群不在项目交流群列表中' };
        }
        let online: { nt: Pick<NtHelperBinding, 'sendOidbPacket'>; pid: number; uin: string };
        try {
          online = requireOnlineQq();
        } catch (e) {
          const offlineMode =
            getAppContext().bootstrap?.userConfig.getSettings().autoInjectQq === false;
          return {
            ok: false,
            reason: offlineMode ? ('offline-mode' as const) : ('offline' as const),
            message: e instanceof Error ? e.message : String(e),
          };
        }
        const services = requireServices();
        try {
          await getAppContext().bootstrap?.injectHook.ensure(online.pid, online.uin);
        } catch (e) {
          return {
            ok: false,
            reason: 'offline',
            message: `注入 QQ hook 失败：${e instanceof Error ? e.message : String(e)}`,
          };
        }

        // 打包正文 + 两份最新日志到缓存目录。
        const bundle = bundleFeedbackFiles({ title: input.title, body: input.body });
        if (!bundle.ok || !bundle.folder) {
          return { ok: false, reason: 'bundle', message: bundle.errors?.join('\n') ?? '打包失败' };
        }
        const files = (bundle.files ?? []).map((path) => ({ path }));

        const record = services.accountConfig.getRecord();
        const thumbPath = resolveResource('brand', 'bug_banner.png');
        if (!thumbPath || !existsSync(thumbPath)) {
          return { ok: false, reason: 'bundle', message: '缺少缩略图资源 bug_banner.png' };
        }

        try {
          const result = await services.flashTransfer.uploadBundleToGroup({
            files,
            options: {
              name: input.title,
              thumbPath,
              uploader: {
                uin: record?.uin ?? online.uin,
                nickname: record?.displayName ?? '',
                uid: record?.uid ?? '',
              },
            },
            groupId: Number(input.groupId),
          });
          return {
            ok: true,
            filesetUuid: result.filesetUuid,
            shareUrl: result.shareUrl,
            folder: bundle.folder,
          };
        } catch (e) {
          logger.warn('group feedback flash send failed', {
            event: 'feedback-flash-send-failed',
            groupId: input.groupId,
            error: e instanceof Error ? e.message : String(e),
          });
          return {
            ok: false,
            reason: 'send',
            message: e instanceof Error ? e.message : String(e),
          };
        }
      },
    ),

  /**
   * 路径 2：已有 GitHub issue/PR —— 图文 Ark 卡片发到群聊。
   * 标题 = issue/pr #N；描述 = issue 标题；预览图 = 群头像。
   */
  submitIssueArk: procedure
    .input(
      z.object({
        groupId: z.string().min(1),
        number: z.number().int().positive(),
        kind: z.enum(['issue', 'pr']).default('issue'),
        title: z.string().min(1).max(200),
      }),
    )
    .mutation(
      async ({
        input,
      }): Promise<
        { ok: true } | { ok: false; reason: 'offline' | 'offline-mode' | 'send'; message: string }
      > => {
        if (!PROJECT_GROUP_IDS.includes(input.groupId)) {
          return { ok: false, reason: 'send', message: '该群不在项目交流群列表中' };
        }
        let online: { nt: Pick<NtHelperBinding, 'sendOidbPacket'>; pid: number; uin: string };
        try {
          online = requireOnlineQq();
        } catch (e) {
          const offlineMode =
            getAppContext().bootstrap?.userConfig.getSettings().autoInjectQq === false;
          return {
            ok: false,
            reason: offlineMode ? ('offline-mode' as const) : ('offline' as const),
            message: e instanceof Error ? e.message : String(e),
          };
        }
        try {
          await getAppContext().bootstrap?.injectHook.ensure(online.pid, online.uin);
        } catch (e) {
          return {
            ok: false,
            reason: 'offline',
            message: `注入 QQ hook 失败：${e instanceof Error ? e.message : String(e)}`,
          };
        }
        try {
          await requireServices().flashTransfer.sendTuwenArkToGroup({
            groupId: Number(input.groupId),
            cardTitle: `${input.kind === 'pr' ? 'PR' : 'Issue'} #${input.number}`,
            desc: input.title,
            jumpUrl: `https://github.com/${REPO}/issues/${input.number}`,
            previewUrl: groupAvatarUrl(input.groupId),
          });
          return { ok: true };
        } catch (e) {
          logger.warn('group feedback ark send failed', {
            event: 'feedback-ark-send-failed',
            groupId: input.groupId,
            error: e instanceof Error ? e.message : String(e),
          });
          return {
            ok: false,
            reason: 'send',
            message: e instanceof Error ? e.message : String(e),
          };
        }
      },
    ),
});
