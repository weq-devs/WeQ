import { randomUUID } from 'node:crypto';
import { withDatabaseWorkload } from '@weq/db';
import { QZONE_SHARE_CATEGORIES } from '@weqbot/protocol/web';
import { z } from 'zod/v3';
import { getAppContext } from '../context/app_context';
import { assertAccountToolScope } from './account_scope';

export function capabilityAccount() {
  assertAccountToolScope();
  const ctx = getAppContext();
  const record = ctx.services?.accountConfig.getRecord();
  if (!ctx.account || !ctx.services || !record) throw new Error('账号尚未就绪。');
  const selfUin = String(ctx.account.context.uin);
  return { ctx, services: ctx.services, selfUin, expectedAccountConfigId: record.configId };
}

function frontendCapability<S extends z.ZodRawShape>(
  name: string,
  featureId: string,
  summary: string,
  shape: S,
  run: (input: z.infer<z.ZodObject<S>>) => unknown,
) {
  const input = z.object(shape).strict();
  return { name, featureId, summary, input, run: (args: unknown) => run(input.parse(args)) };
}

async function qzone() {
  const account = capabilityAccount();
  const { qzoneRouter } = await import('../ipc/routers/qzone');
  return {
    api: qzoneRouter.createCaller({ authorize: assertAccountToolScope }),
    account: {
      selfUin: account.selfUin,
      expectedAccountConfigId: account.expectedAccountConfigId,
      requestId: randomUUID(),
    },
  };
}

const hostUin = z.string().regex(/^[1-9]\d{4,19}$/);
const offset = z.number().int().min(0).max(100_000).default(0);
const page = z.number().int().min(1).max(100_000).default(1);
const tid = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);

export const FRONTEND_CAPABILITIES = [
  frontendCapability(
    'search_global_content',
    'messages.history.search',
    '按类别分页搜索当前数据源的消息、联系人、群、文件、空间、收藏和邮箱。',
    {
      keyword: z.string().trim().min(1).max(256),
      category: z.enum([
        'contact',
        'group',
        'chatRecord',
        'file',
        'qzone',
        'collection',
        'mailMessage',
      ]),
      sources: z
        .array(z.enum(['qq', 'clone', 'assistant']))
        .min(1)
        .max(3)
        .optional(),
      offset,
      limit: z.number().int().min(1).max(20).default(10),
    },
    ({ keyword, category, sources, offset, limit }) => {
      const { services } = capabilityAccount();
      return withDatabaseWorkload('bulk', () =>
        services.unifiedSearch.moreSearch(category, keyword, offset, limit, 'all', sources),
      );
    },
  ),
  frontendCapability(
    'list_group_todos',
    'groups.todos',
    '读取指定群的本地待办。',
    {
      groupCode: z.string().regex(/^[1-9]\d{0,19}$/),
    },
    async (input) => {
      const { accountRouter } = await import('../ipc/routers/account');
      return accountRouter
        .createCaller({ authorize: assertAccountToolScope })
        .listGroupTodos(input);
    },
  ),
  frontendCapability(
    'get_qzone_space_stats',
    'qzone.profile.activity',
    '读取空间主页的资料统计。',
    { hostUin },
    async (input) => {
      const { api, account } = await qzone();
      return api.stats({ ...account, ...input });
    },
  ),
  frontendCapability(
    'list_qzone_posts',
    'qzone.timeline',
    '读取指定空间的说说。',
    { hostUin, offset },
    async (input) => {
      const { api, account } = await qzone();
      return api.posts({ ...account, ...input });
    },
  ),
  frontendCapability(
    'get_qzone_post',
    'qzone.timeline',
    '按说说 ID 读取正文。',
    { hostUin, tid, time: z.number().int().positive().optional() },
    async (input) => {
      const { api, account } = await qzone();
      return api.detail({ ...account, ...input });
    },
  ),
  frontendCapability(
    'list_qzone_feed',
    'qzone.feed.favorites',
    '读取好友动态，可筛选特别关心。',
    {
      cursor: z.string().min(1).max(16_384).optional(),
      favorites: z.boolean().default(false),
    },
    async ({ cursor, favorites }) => {
      const { api, account } = await qzone();
      return api.feeds({ ...account, cursor, scope: favorites ? 7 : 0 });
    },
  ),
  frontendCapability(
    'list_qzone_related',
    'qzone.related',
    '读取与本账号相关的空间互动。',
    { offset },
    async (input) => {
      const { api, account } = await qzone();
      return api.related({ ...account, ...input });
    },
  ),
  frontendCapability(
    'list_qzone_albums',
    'qzone.self-albums',
    '按空间所有者读取相册，可省略以查看自己的相册。',
    { hostUin: hostUin.optional(), offset },
    async (input) => {
      const { api, account } = await qzone();
      return api.albumPage({
        ...account,
        hostUin: input.hostUin ?? account.selfUin,
        offset: input.offset,
      });
    },
  ),
  frontendCapability(
    'list_qzone_visitors',
    'qzone.profile.activity',
    '按页读可访问的空间访客。',
    { hostUin, page },
    async (input) => {
      const { api, account } = await qzone();
      return api.visitors({ ...account, ...input });
    },
  ),
  frontendCapability(
    'list_qzone_guestbook',
    'qzone.profile.activity',
    '读取可访问的空间留言板。',
    { hostUin, offset },
    async (input) => {
      const { api, account } = await qzone();
      return api.guestbook({ ...account, ...input });
    },
  ),
  frontendCapability(
    'list_qzone_blogs',
    'qzone.profile.activity',
    '读取空间日志标题及标识。',
    { hostUin, offset },
    async (input) => {
      const { api, account } = await qzone();
      return api.blogs({ ...account, ...input });
    },
  ),
  frontendCapability(
    'get_qzone_blog',
    'qzone.profile.activity',
    '按日志 ID 读空间日志正文。',
    { hostUin, blogId: z.string().regex(/^[1-9]\d{0,15}$/) },
    async (input) => {
      const { api, account } = await qzone();
      return api.blog({ ...account, ...input });
    },
  ),
  frontendCapability(
    'list_qzone_shares',
    'qzone.profile.activity',
    '按类型分页读取空间历史分享。',
    {
      hostUin,
      category: z
        .number()
        .refine((value): value is (typeof QZONE_SHARE_CATEGORIES)[number] =>
          QZONE_SHARE_CATEGORIES.some((candidate) => value === candidate),
        ),
      page,
    },
    async (input) => {
      const { api, account } = await qzone();
      return api.shares({ ...account, ...input });
    },
  ),
  frontendCapability(
    'list_qzone_videos',
    'qzone.timeline',
    '读取指定空间的视频列表。',
    { hostUin, offset },
    async (input) => {
      const { api, account } = await qzone();
      return api.videos({ ...account, ...input });
    },
  ),
  frontendCapability(
    'list_saved_analysis_reports',
    'analysis.saved-reports',
    '分页读取当前数据源已保存的分析报告摘要。',
    { offset, limit: z.number().int().min(1).max(20).default(10) },
    async ({ offset, limit }) => {
      const account = capabilityAccount();
      const { accountRouter } = await import('../ipc/routers/account');
      const api = accountRouter.createCaller({ authorize: assertAccountToolScope });
      const reports = await api.analysisReports.list({
        expectedAccountUin: account.selfUin,
        expectedAccountConfigId: account.expectedAccountConfigId,
      });
      const next = offset + limit;
      return {
        items: reports.slice(offset, next).map(({ request, status, updatedAt }) => ({
          id: request.id,
          name: request.name,
          kind: request.kind,
          period: request.period,
          status,
          updatedAt,
        })),
        nextOffset: next < reports.length ? next : null,
      };
    },
  ),
  frontendCapability(
    'get_contact_online_status',
    'contacts.profile',
    '按联系人 UID 读取当前已知的在线状态。',
    {
      uid: z
        .string()
        .regex(/^u_[A-Za-z0-9_-]+$/)
        .max(128),
    },
    async (input) => {
      const { accountRouter } = await import('../ipc/routers/account');
      return accountRouter
        .createCaller({ authorize: assertAccountToolScope })
        .getOnlineStatus(input);
    },
  ),
  frontendCapability(
    'get_qzone_post_interactions',
    'qzone.post.interactions',
    '读取指定说说的评论、点赞和查询覆盖情况。',
    { hostUin, tid, time: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) },
    async (input) => {
      const { api, account } = await qzone();
      return api.interactions({ ...account, ...input });
    },
  ),
  frontendCapability(
    'get_qzone_album_media',
    'qzone.self-albums',
    '按相册和媒体标识读取空间相册中的媒体详情。',
    { hostUin, topicId: z.string().min(1).max(1024), picKey: z.string().min(1).max(4096) },
    async (input) => {
      const { api, account } = await qzone();
      return api.albumDetail({ ...account, ...input });
    },
  ),
];
