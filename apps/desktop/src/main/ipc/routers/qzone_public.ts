/**
 * 空友爱看（公共空间）IPC —— 推荐流、详情、评论与互动写操作。
 *
 * 与 `qzone.ts`（旧空间 web cgi）分开挂载：这一套走 h5 gotrpc 网关，
 * 目标是**推荐域**的动态，动态身份是 `cell_common.union_id` + `cell_feed_transfer`，
 * 与旧说说的 `tid` 不通用。所以这里只做「把渲染层拿到的原始 feed 原样交给服务层」，
 * 不在主进程重新拼造目标 —— 拼错就是给别人点赞 / 评论。
 *
 * 读走 `request()`（限流、超时、账号切换校验、可取消），写不套读重试，
 * 并且在真正发包前用 `current()` 复核账号与 QQ 进程没有变。
 */
import { z } from 'zod';
import { withQzonePaginationTimeout } from '@weq/service/qzone-pagination';
import { getAppContext, type AccountServices } from '../../context/app_context';
import { procedure, router } from '../trpc';

const uin = z.string().regex(/^[1-9]\d{4,19}$/);
const account = z.object({ selfUin: uin });
const read = account.extend({ requestId: z.string().uuid() });
/**
 * 上游 feed / comment 是任意 JSON 对象，但必须带 `cell_common.union_id`。
 * 这里只做体积与顶层形状约束，真正的身份校验在服务层（发请求前拒掉）。
 */
const json = z.record(z.string(), z.unknown());
const feed = json.refine((value) => Object.keys(value).length > 0, '动态对象不能为空');
const comment = json.refine((value) => Object.keys(value).length > 0, '评论对象不能为空');

const pending = new Map<string, { services: AccountServices; controller: AbortController }>();
const writing = new WeakSet<AccountServices>();

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
  if (pending.has(input.requestId)) throw new Error('空友请求已在运行。');
  if ([...pending.values()].filter((entry) => entry.services === services).length >= 4)
    throw new Error('请等待当前空友内容加载完成。');
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

/** 写操作：一次只允许一个，且发包前复核账号 / QQ 进程没变。 */
async function write<T>(
  input: { selfUin: string },
  run: (services: AccountServices, current: () => void) => Promise<T>,
): Promise<T> {
  const services = online(input.selfUin);
  if (writing.has(services)) throw new Error('请等待当前空友操作完成。');
  const pid = services.accountConfig.getRecord()?.qqPid;
  const current = (): void => {
    if (getAppContext().services !== services) throw new Error('账号已切换，请重新打开空间。');
    if (services.accountConfig.getRecord()?.qqPid !== pid)
      throw new Error('QQ 运行时已改变，请核对 QQ 后重新打开空间。');
  };
  writing.add(services);
  try {
    current();
    return await run(services, current);
  } finally {
    writing.delete(services);
  }
}

/**
 * 公共域（爱看）的作者标识与本地账号 uid **不是同一套**：推荐流里作者的 `uid`
 * 是 32 位大写十六进制（如 `EE9795E575FCD8B4C47E405DE11D2F5A`），而账号的 uid 是
 * `u_xxx` 形式。所以「这条评论是不是我发的」不能拿本地 uid 直接比。
 *
 * 做法：把**写操作回执**里带回来的公共域 uid 记下来（发评论 / 回复后上游会把
 * 操作者对象原样回传），后续用它判断删除入口。拿不到就不显示删除 —— 宁可少一个
 * 入口，也不把别人的评论标成自己的。
 */
const publicUidByAccount = new Map<string, string>();

function rememberPublicUid(accountKey: string, value: unknown): void {
  const user = (value as { user?: { uid?: unknown } } | null)?.user;
  const uid = typeof user?.uid === 'string' ? user.uid.trim() : '';
  if (uid && uid !== accountKey) publicUidByAccount.set(accountKey, uid);
}

/**
 * 评论 / 回复要用操作者身份（uin / uid / nick）。服务层刻意不读 profile 库，
 * 所以在这里补齐；本地 uid 拿不到时留空串（上游接受）。
 */
async function selfIdentity(
  services: AccountServices,
  selfUin: string,
): Promise<{ uin: string; uid: string; nick: string; publicUid: string }> {
  const uid = getAppContext().account?.selfUid ?? '';
  let nick = '';
  try {
    nick = (await services.profile.getProfileByUin(BigInt(selfUin)))?.nick?.trim() ?? '';
  } catch {
    // 资料库缺失不影响评论，昵称留空由上游回填。
  }
  return { uin: selfUin, uid, nick, publicUid: publicUidByAccount.get(selfUin) ?? '' };
}

export const qzonePublicRouter = router({
  /** 当前账号有没有爱看入口、能不能推。 */
  capabilities: procedure
    .input(read)
    .query(({ input }) =>
      request(input, (services, signal) => services.webQuery.getQzonePublicCapabilities(signal)),
    ),

  /**
   * 操作者身份（uin / uid / nick）。评论要用它，界面用它判断「哪些评论是我发的」
   * 从而显示删除入口 —— 公共域的作者只有 uid，靠 uid 比对。
   */
  me: procedure
    .input(read)
    .query(({ input }) => request(input, (services) => selfIdentity(services, input.selfUin))),

  /** 推荐流首页（`cursor` 省略）或续页；游标由服务层封装并绑定当前账号。 */
  feeds: procedure
    .input(read.extend({ cursor: z.string().min(1).max(65536).optional() }))
    .query(({ input }) =>
      request(input, (services, signal) =>
        services.webQuery.getQzonePublicFeeds(input.cursor, signal),
      ),
    ),

  detail: procedure
    .input(read.extend({ feed }))
    .query(({ input }) =>
      request(input, (services, signal) =>
        services.webQuery.getQzonePublicFeedDetail(input.feed, signal),
      ),
    ),

  comments: procedure
    .input(read.extend({ feed, cursor: z.string().min(1).max(65536) }))
    .query(({ input }) =>
      request(input, (services, signal) =>
        services.webQuery.getQzonePublicComments(input.feed, input.cursor, signal),
      ),
    ),

  replies: procedure
    .input(
      read.extend({
        feed,
        comment,
        cursor: z.string().max(65536).default(''),
        pageSize: z.number().int().min(1).max(50).default(20),
      }),
    )
    .query(({ input }) =>
      request(input, (services, signal) =>
        services.webQuery.getQzonePublicReplies(
          input.feed,
          input.comment,
          input.cursor,
          input.pageSize,
          signal,
        ),
      ),
    ),

  // ───────────────────────── 写操作 ─────────────────────────

  /** 「推」/ 取消推 —— 与普通赞是两个独立接口。 */
  upvote: procedure
    .input(account.extend({ feed, enable: z.boolean() }))
    .mutation(({ input }) =>
      write(input, (services, current) =>
        services.webQuery.setQzonePublicUpvote(input.feed, input.enable, current),
      ),
    ),

  like: procedure
    .input(account.extend({ feed, enable: z.boolean() }))
    .mutation(({ input }) =>
      write(input, (services, current) =>
        services.webQuery.setQzonePublicLike(input.feed, input.enable, current),
      ),
    ),

  /** 给评论点赞；给了 `reply` 就改为给该回复点赞（like_type 3）。 */
  commentLike: procedure
    .input(account.extend({ feed, comment, enable: z.boolean(), reply: comment.optional() }))
    .mutation(({ input }) =>
      write(input, (services, current) =>
        services.webQuery.setQzonePublicCommentLike(
          input.feed,
          input.comment,
          input.enable,
          input.reply,
          current,
        ),
      ),
    ),

  follow: procedure
    .input(account.extend({ feed, enable: z.boolean() }))
    .mutation(({ input }) =>
      write(input, (services, current) =>
        services.webQuery.setQzonePublicFollow(input.feed, input.enable, current),
      ),
    ),

  comment: procedure
    .input(account.extend({ feed, content: z.string().trim().min(1).max(4096) }))
    .mutation(({ input }) =>
      write(input, async (services, current) => {
        const self = await selfIdentity(services, input.selfUin);
        current();
        const data = await services.webQuery.commentQzonePublic(
          input.feed,
          { uin: self.uin, uid: self.uid, nick: self.nick },
          input.content,
          current,
        );
        // 回执里的 comment.user 就是本账号在公共域的身份，记下来供删除入口判定。
        rememberPublicUid(input.selfUin, data.comment);
        return data;
      }),
    ),

  reply: procedure
    .input(
      account.extend({
        feed,
        comment,
        content: z.string().trim().min(1).max(4096),
        reply: comment.optional(),
      }),
    )
    .mutation(({ input }) =>
      write(input, async (services, current) => {
        const self = await selfIdentity(services, input.selfUin);
        current();
        const data = await services.webQuery.replyQzonePublic(
          input.feed,
          { uin: self.uin, uid: self.uid, nick: self.nick },
          input.comment,
          input.content,
          input.reply,
          current,
        );
        rememberPublicUid(input.selfUin, data.reply);
        return data;
      }),
    ),

  deleteComment: procedure
    .input(account.extend({ feed, comment }))
    .mutation(({ input }) =>
      write(input, (services, current) =>
        services.webQuery.deleteQzonePublicComment(input.feed, input.comment, current),
      ),
    ),

  deleteReply: procedure
    .input(account.extend({ feed, comment, reply: comment }))
    .mutation(({ input }) =>
      write(input, (services, current) =>
        services.webQuery.deleteQzonePublicReply(input.feed, input.comment, input.reply, current),
      ),
    ),

  forward: procedure
    .input(account.extend({ feed, reason: z.string().max(4096).default('') }))
    .mutation(({ input }) =>
      write(input, (services, current) =>
        services.webQuery.forwardQzonePublicFeed(input.feed, input.reason, current),
      ),
    ),

  cancel: procedure.input(z.object({ requestId: z.string().uuid() })).mutation(({ input }) => {
    const entry = pending.get(input.requestId);
    entry?.controller.abort(new Error('空友加载已取消。'));
    return { cancelled: Boolean(entry) };
  }),
});
