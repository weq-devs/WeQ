/** Native Qzone UI: only already implemented web capabilities are exposed. */
import {
  getHost,
  OperationError,
  qzoneFeedSearchRecord,
  writeFileAtomic,
  type ResourceExportSummary,
} from '@weq/service';
import { QZONE_SHARE_CATEGORIES, type QzoneShareCategory } from '@weqbot/protocol/web';
import { z } from 'zod';
import { rememberQzoneAlbums, rememberQzonePosts } from '../../search_content';
import { withQzonePaginationTimeout } from '@weq/service/qzone-pagination';
import { getAppContext, type AccountServices } from '../../context/app_context';
import { procedure, router } from '../trpc';
import { uniqueFilename } from '../../account_resource_exports';
import { transferTarget } from '../../../shared/transfer_progress';
import {
  bindExportSaveRequest,
  exportAccountBindingInput,
  exportSavePolicyInput,
  prepareExportDestination,
} from './export_save';
import { planUrlMediaExport } from './media_save';

const uin = z.string().regex(/^[1-9]\d{4,19}$/);
const account = z.object({ selfUin: uin });
const read = account.extend({ requestId: z.string().uuid() });
const target = read.extend({ hostUin: uin });
const post = target.extend({ tid: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/) });
const boundTarget = target.extend({ expectedAccountConfigId: z.string().min(1) });
const category = z.custom<QzoneShareCategory>((value) =>
  QZONE_SHARE_CATEGORIES.some((candidate) => value === candidate),
);
const pageNumber = z.number().int().min(1).max(100_000);
const blog = boundTarget.extend({ blogId: z.string().regex(/^[1-9]\d{0,15}$/) });
const contentOffset = z.number().int().min(0).max(100_000);
const videoExportInput = exportAccountBindingInput.required().extend({
  hostUin: uin,
  items: z
    .array(
      z.object({
        id: z.string().regex(/^[a-zA-Z0-9_-]{1,256}$/),
        name: z.string().min(1),
        url: z
          .string()
          .url()
          .refine((value) => {
            const url = URL.parse(value);
            return (
              url &&
              ['http:', 'https:'].includes(url.protocol) &&
              !url.username &&
              !url.password &&
              !url.port
            );
          }, '空间视频地址无效'),
      }),
    )
    .min(1),
  savePolicy: exportSavePolicyInput,
});
const pending = new Map<string, { services: AccountServices; controller: AbortController }>();
const publishing = new WeakSet<AccountServices>();
const archiveWriting = new WeakSet<AccountServices>();

function online(selfUin: string): AccountServices {
  const ctx = getAppContext();
  const services = ctx.services;
  if (!services || String(ctx.account?.context.uin) !== selfUin)
    throw new Error('账号已切换，请重新打开空间。');
  const record = services.accountConfig.getRecord();
  if (!record?.qqOnline || !record.qqPid)
    throw new OperationError('请先登录当前账号的 QQ。', 'expected');
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

function readBound<T>(
  input: z.infer<typeof boundTarget>,
  run: (services: AccountServices, signal: AbortSignal) => Promise<T>,
) {
  return request(input, (services, signal) => {
    if (services.accountConfig.getRecord()?.configId !== input.expectedAccountConfigId)
      throw new Error('账号数据源已切换，请重新打开空间。');
    return run(services, signal);
  });
}

export const qzoneRouter = router({
  archiveState: procedure
    .input(post.extend({ time: z.number().int().positive(), refresh: z.boolean().default(false) }))
    .query(({ input }) =>
      request(input, async (services, signal) => {
        return services.webQuery.getQzoneArchiveState(
          input.hostUin,
          input.tid,
          input.time,
          input.selfUin,
          signal,
          input.refresh,
        );
      }),
    ),
  setArchiveState: procedure
    .input(
      post.extend({
        expectedAccountConfigId: z.string().min(1),
        time: z.number().int().positive(),
        action: z.enum(['contribute', 'uncontribute', 'unarchive']),
      }),
    )
    .mutation(({ input }) =>
      request(input, async (services, signal) => {
        if (services.accountConfig.getRecord()?.configId !== input.expectedAccountConfigId)
          throw new Error('账号数据源已切换，已停止提交。');
        if (archiveWriting.has(services)) throw new Error('空间状态操作正在进行。');
        archiveWriting.add(services);
        try {
          const result = await services.webQuery.setQzoneArchiveState(
            input.hostUin,
            input.tid,
            input.time,
            input.selfUin,
            input.action,
            () => {
              if (online(input.selfUin) !== services) throw new Error('账号已切换，已停止提交。');
            },
            signal,
          );
          return {
            accepted: result.accepted,
            confirmed: result.confirmed,
            expectedStatus: result.expectedStatus,
            state: result.detail
              ? await services.webQuery
                  .getQzoneArchiveState(input.hostUin, input.tid, input.time, input.selfUin, signal)
                  .catch(() => null)
              : null,
          };
        } finally {
          archiveWriting.delete(services);
        }
      }),
    ),
  upvotes: procedure
    .input(post.extend({ time: z.number().int().positive(), refresh: z.boolean().default(false) }))
    .query(({ input }) =>
      request(input, async (services, signal) => {
        const detail = await services.webQuery.getQzoneNativeDetail(
          input.hostUin,
          input.tid,
          input.time,
          signal,
          input.refresh,
        );
        return detail.upvote ?? null;
      }),
    ),
  mediaTypes: procedure
    .input(post.extend({ time: z.number().int().positive() }))
    .query(({ input }) =>
      request(input, (services, signal) =>
        services.webQuery.getQzoneMediaTypes(input.hostUin, input.tid, input.time, signal),
      ),
    ),
  detail: procedure
    .input(post.extend({ time: z.number().int().positive().optional() }))
    .query(({ input }) =>
      request(input, async (services, signal) => {
        const detail = await services.webQuery.getQzonePostDetail(
          input.hostUin,
          input.tid,
          signal,
          undefined,
          input.time,
        );
        if (detail.post)
          rememberQzonePosts(
            services.contentSearch,
            input.hostUin,
            [{ ...detail.post, content: detail.content }],
            '',
            true,
          );
        return detail;
      }),
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
      request(input, async (services, signal) => {
        const page = await services.webQuery.getQzoneAlbumPage(input.hostUin, input.offset, signal);
        rememberQzoneAlbums(services.contentSearch, input.hostUin, page.albums);
        return page;
      }),
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
  blogs: procedure
    .input(boundTarget.extend({ offset: contentOffset }))
    .query(({ input }) =>
      readBound(input, (services, signal) =>
        services.webQuery.qzoneBlogs(input.hostUin, input.offset, signal),
      ),
    ),
  blog: procedure
    .input(blog)
    .query(({ input }) =>
      readBound(input, (services, signal) =>
        services.webQuery.qzoneBlog(input.hostUin, input.blogId, signal),
      ),
    ),
  blogComments: procedure
    .input(blog.extend({ offset: contentOffset }))
    .query(({ input }) =>
      readBound(input, (services, signal) =>
        services.webQuery.qzoneBlogComments(input.hostUin, input.blogId, input.offset, signal),
      ),
    ),
  shares: procedure
    .input(boundTarget.extend({ category, page: pageNumber }))
    .query(({ input }) =>
      readBound(input, (services, signal) =>
        services.webQuery.qzoneShares(input.hostUin, input.category, input.page, signal),
      ),
    ),
  shareComments: procedure
    .input(boundTarget.extend({ shareId: z.string().regex(/^\d{1,32}$/), page: pageNumber }))
    .query(({ input }) =>
      readBound(input, (services, signal) =>
        services.webQuery.qzoneShareComments(input.hostUin, input.shareId, input.page, signal),
      ),
    ),
  exportShares: procedure.input(boundTarget.extend({ category })).mutation(async ({ input }) => {
    const services = online(input.selfUin);
    if (services.accountConfig.getRecord()?.configId !== input.expectedAccountConfigId)
      throw new Error('账号数据源已切换，请重新打开空间。');
    const host = getHost();
    const target = await host.pickSaveTarget({
      defaultName: `QQ空间分享-${input.hostUin}-${input.category}-${Date.now()}.json`,
      extension: 'json',
      locationKey: 'qzone-shares',
    });
    if (!target) return null;
    const items = await readBound(input, async (services, signal) => {
      const shares = new Map<
        string,
        Awaited<ReturnType<typeof services.webQuery.qzoneShares>>['items'][number]
      >();
      let page: number | null = 1;
      while (page !== null) {
        signal.throwIfAborted();
        const result = await services.webQuery.qzoneShares(
          input.hostUin,
          input.category,
          page,
          signal,
        );
        const count = shares.size;
        for (const share of result.items) if (!shares.has(share.id)) shares.set(share.id, share);
        if (page > 1 && count === shares.size)
          throw new Error('QQ 空间重复返回分享页，导出未完成，请重试。');
        page = result.next;
      }
      return [...shares.values()];
    });
    if (online(input.selfUin) !== services) throw new Error('账号已切换，导出已取消。');
    await writeFileAtomic(
      target.path,
      `${JSON.stringify({ version: 1, hostUin: input.hostUin, category: input.category, items }, null, 2)}\n`,
    );
    return {
      path: target.downloadId ? null : target.path,
      downloadUrl: target.downloadId ? `/_download/${target.downloadId}` : null,
      count: items.length,
    };
  }),
  visitors: procedure
    .input(boundTarget.extend({ page: pageNumber }))
    .query(({ input }) =>
      readBound(input, (services, signal) =>
        services.webQuery.qzoneVisitors(input.hostUin, input.page, signal),
      ),
    ),
  guestbook: procedure
    .input(boundTarget.extend({ offset: contentOffset }))
    .query(({ input }) =>
      readBound(input, (services, signal) =>
        services.webQuery.qzoneGuestbook(input.hostUin, input.offset, signal),
      ),
    ),
  videos: procedure
    .input(boundTarget.extend({ offset: contentOffset }))
    .query(({ input }) =>
      readBound(input, (services, signal) =>
        services.webQuery.qzoneVideos(input.hostUin, input.offset, signal),
      ),
    ),
  exportVideos: procedure.input(videoExportInput).mutation(async ({ input }) => {
    const { services, bootstrap } = getAppContext();
    if (!services) throw new Error('未打开账号');
    const check = bindExportSaveRequest(input, () => {
      const current = getAppContext();
      return {
        uin: current.account?.context.uin.toString(),
        configId: current.services?.accountConfig.getRecord()?.configId,
        services: current.services,
      };
    });
    check();
    const items = [...new Map(input.items.map((item) => [item.id, item])).values()];
    const plan = (item: (typeof items)[number], signal?: AbortSignal) => {
      const url = `weq-media://album?${new URLSearchParams({ src: item.url })}`;
      return planUrlMediaExport(url, item.name, check, signal);
    };
    const single = items.length === 1 ? await plan(items[0]!) : null;
    const policy = await prepareExportDestination(
      input.savePolicy,
      bootstrap?.userConfig.getSettings().defaultExportDir,
      getHost(),
      single?.output ?? { kind: 'directory' },
      check,
    );
    if (!policy) return null;
    return services.exportManager.startResourceExport({
      kind: 'media',
      name: single?.output.name ?? 'QQ 空间视频',
      transferTarget: [
        transferTarget('qzone-videos', input.hostUin),
        ...(single ? [transferTarget('qzone-video', input.hostUin, items[0]!.id)] : []),
      ],
      display: {
        action: '导出空间视频',
        context: 'QQ 空间视频',
        subject: single?.fileName ?? `${items.length} 个视频`,
        fileName: Boolean(single),
      },
      savePolicy: policy,
      output: single?.output,
      run: async (context) => {
        if (single) return single.run(context);
        const used = new Set<string>();
        const failed: ResourceExportSummary['failed'] = [];
        let ok = 0;
        context.progress(0, items.length);
        for (const [index, item] of items.entries()) {
          const target = transferTarget('qzone-video', input.hostUin, item.id);
          let fileName = item.name;
          let success = false;
          try {
            check();
            context.signal.throwIfAborted();
            const media = await plan(item, context.signal);
            fileName = uniqueFilename(media.fileName, used);
            await media.run(
              {
                directory: context.directory,
                signal: context.signal,
                progress() {},
                transferProgress: (received, total) =>
                  context.transferProgress?.(received, total, target),
              },
              fileName,
            );
            ok++;
            success = true;
          } catch (reason) {
            check();
            context.signal.throwIfAborted();
            failed.push({
              fileName,
              error: reason instanceof Error ? reason.message : String(reason),
            });
          } finally {
            context.transferItemFinished?.(target, success);
          }
          context.progress(index + 1, items.length);
        }
        return { total: items.length, ok, failed };
      },
    });
  }),
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
        rememberQzonePosts(services.contentSearch, input.hostUin, page.list, nickname ?? '');
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
      request(input, async (services, signal) => {
        const page = await services.webQuery.getQzoneFeeds(
          input.selfUin,
          1,
          10,
          signal,
          input.cursor,
          input.scope,
        );
        services.contentSearch?.remember(
          page.feeds.flatMap((feed) => {
            const record = qzoneFeedSearchRecord(feed);
            return record ? [record] : [];
          }),
        );
        return page;
      }),
    ),
  interactions: procedure
    .input(
      post.extend({ time: z.number().int().min(0), structuredOnly: z.boolean().default(false) }),
    )
    .query(({ input }) =>
      request(input, async (services, signal) => {
        if (input.structuredOnly)
          return services.webQuery.getQzoneStructuredComments(input.hostUin, input.tid, signal);
        const interactions = await services.webQuery.getQzoneInteractions(
          input.hostUin,
          [{ tid: input.tid, time: input.time }],
          signal,
        );
        return (
          interactions.get(input.tid) ?? {
            comments: [],
            likes: [],
            coverage: 'unobserved' as const,
          }
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
    .input(
      post.extend({
        cursor: z
          .object({
            attachInfo: z.string().min(1).max(8192),
            previousPageKey: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .nullable()
          .default(null),
      }),
    )
    .query(({ input }) =>
      request(input, (services, signal) =>
        services.webQuery.getQzoneForwardPage(input.hostUin, input.tid, input.cursor, signal),
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
    entry?.controller.abort(new DOMException('空间加载已取消。', 'AbortError'));
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
