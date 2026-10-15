/** Native Qzone UI: only already implemented web capabilities are exposed. */
import { z } from 'zod';
import { getHost } from '@weq/service';
import { withQzonePaginationTimeout } from '@weq/service/qzone-pagination';
import { getAppContext, type AccountServices } from '../../context/app_context';
import { procedure, router } from '../trpc';

const uin = z.string().regex(/^[1-9]\d{4,19}$/);
const account = z.object({ selfUin: uin });
const read = account.extend({ requestId: z.string().uuid() });
const target = read.extend({ hostUin: uin });
const post = target.extend({ tid: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/) });
const pending = new Map<string, { services: AccountServices; controller: AbortController }>();
const publishing = new WeakSet<AccountServices>();

function online(selfUin: string): AccountServices {
  const ctx = getAppContext();
  const services = ctx.services;
  if (!services || String(ctx.account?.context.uin) !== selfUin)
    throw new Error('账号已切换，请重新打开空间。');
  const record = services.accountConfig.getRecord();
  if (!record?.qqOnline || !record.qqPid) throw new Error('请先登录当前账号的 QQ。');
  return services;
}

async function request<T>(
  input: { selfUin: string; requestId: string },
  run: (services: AccountServices, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const services = online(input.selfUin);
  if (pending.has(input.requestId)) throw new Error('空间请求已在运行。');
  if ([...pending.values()].filter((entry) => entry.services === services).length >= 4)
    throw new Error('请等待当前空间内容加载完成。');
  const controller = new AbortController();
  pending.set(input.requestId, { services, controller });
  try {
    const result = await withQzonePaginationTimeout(controller, 60_000, () =>
      run(services, controller.signal),
    );
    controller.signal.throwIfAborted();
    if (getAppContext().services !== services) throw new Error('账号已切换，请重新打开空间。');
    return result;
  } finally {
    pending.delete(input.requestId);
  }
}

export const qzoneRouter = router({
  detail: procedure
    .input(post)
    .query(({ input }) =>
      request(input, (services, signal) =>
        services.webQuery.getQzonePostDetail(input.hostUin, input.tid, signal),
      ),
    ),
  images: procedure
    .input(post)
    .query(({ input }) =>
      request(input, (services, signal) =>
        services.webQuery.getQzonePostImages(input.hostUin, input.tid, signal),
      ),
    ),
  related: procedure
    .input(read.extend({ offset: z.number().int().min(0).max(100000) }))
    .query(({ input }) =>
      request(input, (services, signal) => services.webQuery.getQzoneRelated(input.offset, signal)),
    ),
  memories: procedure
    .input(read.extend({ year: z.number().int().min(1995).max(2100) }))
    .query(({ input }) =>
      request(input, (services, signal) => services.webQuery.getQzoneMemories(input.year, signal)),
    ),
  albumPage: procedure
    .input(target.extend({ offset: z.number().int().min(0).max(100000) }))
    .query(({ input }) =>
      request(input, (services, signal) =>
        services.webQuery.getQzoneAlbumPage(input.hostUin, input.offset, signal),
      ),
    ),
  albumDetail: procedure
    .input(
      target.extend({ topicId: z.string().min(1).max(1024), picKey: z.string().min(1).max(4096) }),
    )
    .query(({ input }) =>
      request(input, (services, signal) =>
        services.webQuery.getQzoneAlbumDetail(input.hostUin, input.topicId, input.picKey, signal),
      ),
    ),
  stats: procedure
    .input(target)
    .query(({ input }) =>
      request(input, (services, signal) =>
        services.webQuery.getQzoneSpaceStats(input.hostUin, signal),
      ),
    ),
  posts: procedure
    .input(target.extend({ offset: z.number().int().min(0).max(100_000) }))
    .query(({ input }) =>
      request(input, async (services, signal) => {
        const page = await services.webQuery.getQzoneMsgList(
          input.hostUin,
          input.offset,
          20,
          undefined,
          signal,
        );
        // Keep raw wire metadata and signed source fields out of the UI DTO.
        let nickname = page.owner?.uin === input.hostUin ? page.owner.nickname : null;
        if (!nickname) {
          try {
            nickname =
              (await services.profile.getProfileByUin(BigInt(input.hostUin)))?.nick || null;
          } catch {
            // A missing cached profile does not prevent reading the space.
          }
        }
        return {
          nickname,
          total: page.total,
          list: page.list.map(({ nativeMedia: _raw, ...item }) => item),
        };
      }),
    ),
  feeds: procedure
    .input(
      read.extend({
        cursor: z.string().min(1).max(16384).optional(),
        scope: z.union([z.literal(0), z.literal(7)]).default(0),
      }),
    )
    .query(({ input }) =>
      request(input, (services, signal) =>
        services.webQuery.getQzoneFeeds(input.selfUin, 1, 10, signal, input.cursor, input.scope),
      ),
    ),
  interactions: procedure.input(post.extend({ time: z.number().int().min(0) })).query(({ input }) =>
    request(input, async (services, signal) => {
      const interactions = await services.webQuery.getQzoneInteractions(
        input.hostUin,
        [{ tid: input.tid, time: input.time }],
        signal,
      );
      return (
        interactions.get(input.tid) ?? { comments: [], likes: [], coverage: 'unobserved' as const }
      );
    }),
  ),
  likes: procedure
    .input(post)
    .query(({ input }) =>
      request(input, (services, signal) =>
        services.webQuery.getQzoneLikesResult(input.hostUin, input.tid, signal),
      ),
    ),
  forwards: procedure
    .input(post.extend({ offset: z.number().int().min(0).max(100_000) }))
    .query(({ input }) =>
      request(input, (services, signal) =>
        services.webQuery.getQzoneForwardPage(input.hostUin, input.tid, input.offset, signal),
      ),
    ),
  feedCounts: procedure
    .input(
      read.extend({
        key: z.string().min(1).max(4096),
        appid: z.union([z.literal(4), z.literal(311)]),
      }),
    )
    .query(({ input }) =>
      request(input, (services, signal) =>
        services.webQuery.getQzoneFeedCounts(input.key, input.appid, signal),
      ),
    ),
  summary: procedure.input(post.extend({ needCommentCount: z.boolean() })).query(({ input }) =>
    request(input, async (services, signal) => {
      let likes: Awaited<ReturnType<AccountServices['webQuery']['getQzoneLikesResult']>> | null =
        null;
      try {
        likes = await services.webQuery.getQzoneLikesResult(input.hostUin, input.tid, signal);
      } catch {
        signal.throwIfAborted();
      }
      let commentCount = input.needCommentCount ? (likes?.reportedCommentCount ?? null) : null;
      if (input.needCommentCount && commentCount === null) {
        try {
          commentCount = await services.webQuery.getQzoneCommentCount(
            input.hostUin,
            input.tid,
            signal,
          );
        } catch {
          signal.throwIfAborted();
        }
      }
      if (!likes && commentCount === null) throw new Error('暂时无法读取互动数量，请稍后重试。');
      return { likes, commentCount };
    }),
  ),
  people: procedure.input(read.extend({ uins: z.array(uin).min(1).max(200) })).query(({ input }) =>
    request(input, async (services, signal) => {
      let names: Record<string, string> = {};
      try {
        names = await services.webQuery.getQzoneNicknames(input.uins, signal);
      } catch {
        signal.throwIfAborted();
      }
      for (const id of new Set(input.uins)) {
        if (names[id]) continue;
        try {
          const profile = await services.profile.getProfileByUin(BigInt(id));
          if (profile?.nick?.trim()) names[id] = profile.nick.trim();
        } catch {
          /* Unknown profile stays unknown; never use a remark as the nickname. */
        }
      }
      return names;
    }),
  ),
  cancel: procedure.input(z.object({ requestId: z.string().uuid() })).mutation(({ input }) => {
    const entry = pending.get(input.requestId);
    entry?.controller.abort(new Error('空间加载已取消。'));
    return { cancelled: Boolean(entry) };
  }),
  uploadImage: procedure
    .input(
      account.extend({
        base64: z
          .string()
          .min(1)
          .max(14 * 1024 * 1024),
      }),
    )
    .mutation(async ({ input }) => {
      const services = online(input.selfUin);
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(input.base64)) throw new Error('图片格式无效。');
      const bytes = Buffer.from(input.base64, 'base64');
      if (bytes.length > 10 * 1024 * 1024) throw new Error('请选择不超过 10 MB 的图片。');
      const host = getHost();
      if (!host.validateImageBuffer)
        throw new Error('当前运行环境不支持图片校验，请使用桌面版上传图片。');
      if (!(await host.validateImageBuffer(bytes))) throw new Error('图片格式无效。');
      const result = await services.webQuery.uploadQzoneImage(input.base64);
      if (getAppContext().services !== services) throw new Error('账号已切换，请重新打开空间。');
      return { richval: result.richval };
    }),
  publish: procedure
    .input(
      account.extend({
        content: z.string().trim().min(1).max(10_000),
        richvals: z.array(z.string().min(1).max(4096)).max(9),
        visibility: z.union([z.literal(1), z.literal(4), z.literal(64)]),
      }),
    )
    .mutation(async ({ input }) => {
      const services = online(input.selfUin);
      if (publishing.has(services)) throw new Error('说说正在发表，请稍候。');
      publishing.add(services);
      try {
        // One explicit user action, with the existing publisher's response validation.
        return await services.webQuery.publishQzone(
          input.content,
          input.richvals,
          input.visibility,
        );
      } finally {
        publishing.delete(services);
      }
    }),
});
