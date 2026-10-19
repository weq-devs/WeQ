/**
 * `mergeForward.*` —— 合成草稿、可复用素材与合成历史的本地读写。
 *
 * 合并转发的**发送**要 QQ 在线且已注入；不在线时用户辛苦拼出来的聊天记录不能丢，
 * 所以草稿落在 weq 数据目录（`userConfig.cacheDir('merge-forward')`）里，一个账号
 * 一份 JSON，下次继续编辑。
 *
 * 可修改草稿沿用原路径；素材与历史位于独立持久目录，接口绑定账号及数据源身份。
 * 真正发送仍复用 account.sendForward，本路由不调用协议发送。
 */

import { join, relative, isAbsolute, dirname } from 'node:path';
import { z } from 'zod';
import { MergeForwardArchiveStore, MergeForwardDraftStore } from '@weq/service';
import { getAppContext, requireBootstrap, requirePlatform } from '../../context/app_context';
import { procedure, router } from '../trpc';

/** 逐条消息装扮（列 40801）。0 = 未设置。raw 字段是字体两槽位的原始 wire 值。 */
const decoration = z
  .object({
    bubbleId: z.number().int().nonnegative(),
    fontId: z.number().int().nonnegative(),
    widgetId: z.number().int().nonnegative(),
    /** 41525 原值 → 元素 tag 56。透传用，绝不换算。 */
    fontId1Raw: z.number().int().nonnegative().optional(),
    /** 41531 原值 → 元素 tag 15（含 bit 16 标志位）。透传用，绝不换算。 */
    fontId2Raw: z.number().int().nonnegative().optional(),
  })
  .optional();

const sender = z.object({
  uid: z.string(),
  uin: z.string(),
  name: z.string(),
});

const node = z.object({
  id: z.string().min(1),
  sender,
  /** 内容**分段**，形状由渲染层决定，这里只保证是对象数组。 */
  segs: z.array(z.unknown()),
  time: z.number(),
  decoration,
  sourceMsgId: z.string().optional(),
  sourceCompositionId: z.string().optional(),
});

const draftInput = z.object({
  id: z.string().min(1),
  title: z.string().optional(),
  createdAt: z.number().optional(),
  nodes: z.array(node),
});

/** 已实例化的 store，按落盘路径缓存（读盘只发生一次）。 */
const stores = new Map<string, MergeForwardDraftStore>();
const archives = new Map<string, MergeForwardArchiveStore>();
const accountBinding = z.object({
  expectedAccountUin: z.string().min(1),
  expectedAccountConfigId: z.string().min(1),
});
const archiveKind = z.enum(['material', 'history']);

function boundArchive(input: z.infer<typeof accountBinding>) {
  const context = getAppContext();
  const uin = context.account?.context.uin;
  const services = context.services;
  const configId = services?.accountConfig.getRecord()?.configId;
  if (
    !uin ||
    !services ||
    uin !== input.expectedAccountUin ||
    configId !== input.expectedAccountConfigId
  )
    throw new Error('合成窗口所属账号已切换，请返回原账号后继续');
  const identity = input.expectedAccountConfigId;
  const root = join(requirePlatform().appDataRoot(), 'merge-forward', identity, 'archive');
  let store = archives.get(root);
  if (!store) {
    store = new MergeForwardArchiveStore(root);
    archives.set(root, store);
  }
  return { store, services, root };
}

function draftStore(): MergeForwardDraftStore {
  const uin = getAppContext().account?.context.uin;
  if (!uin) throw new Error('尚未打开账号');
  const dir = requireBootstrap().userConfig.cacheDir('merge-forward');
  const path = join(dir, `${uin}.json`);
  let store = stores.get(path);
  if (!store) {
    store = new MergeForwardDraftStore(path);
    stores.set(path, store);
  }
  return store;
}

function workspaceDraftStore(root: string): MergeForwardDraftStore {
  const path = join(dirname(root), 'drafts.json');
  let store = stores.get(path);
  if (!store) {
    store = new MergeForwardDraftStore(path, { strict: true });
    stores.set(path, store);
  }
  return store;
}

/**
 * 递归收集一份草稿里媒体分段引用的本机路径（图片 / 语音 / 视频 / 文件 / 缩略图）。
 * `segs` 的形状由渲染层决定，所以只挑认识的字段，其余一律忽略。
 */
function collectMediaPaths(nodes: readonly unknown[]): string[] {
  const out: string[] = [];
  const walkSegs = (segs: unknown): void => {
    if (!Array.isArray(segs)) return;
    for (const seg of segs) {
      if (!seg || typeof seg !== 'object') continue;
      const s = seg as Record<string, unknown>;
      if (['image', 'record', 'video', 'file'].includes(String(s.t))) {
        if (typeof s.path === 'string' && s.path) out.push(s.path);
        if (typeof s.thumbPath === 'string' && s.thumbPath) out.push(s.thumbPath);
      }
      if (s.t === 'node') walkSegs(s.segs);
    }
  };
  for (const node of nodes) {
    if (node && typeof node === 'object') walkSegs((node as Record<string, unknown>).segs);
  }
  return out;
}

/**
 * 把草稿里引用的本机媒体登记为可预览。
 *
 * 草稿里存的路径都是用户之前亲手选过的，但 `FileResourceService` 的信任名单只在
 * 内存里（重启 / 重新登录会重建），没有这一步，重启后预览会退回「未找到」。
 */
function trustDraftMedia(nodes: readonly unknown[]): void {
  const fileResource = getAppContext().services?.fileResource;
  if (!fileResource) return;
  for (const path of collectMediaPaths(nodes)) fileResource.trustPath(path);
}

export const mergeForwardRouter = router({
  workspaceDrafts: procedure.input(accountBinding).query(({ input }) => {
    const { root } = boundArchive(input);
    const current = workspaceDraftStore(root).list();
    const legacy = draftStore()
      .list()
      .filter((draft) => !current.some((item) => item.id === draft.id));
    for (const draft of [...current, ...legacy]) trustDraftMedia(draft.nodes);
    return { current, legacy };
  }),
  workspaceSave: procedure
    .input(accountBinding.extend({ draft: draftInput }))
    .mutation(async ({ input }) => {
      const { root, services } = boundArchive(input);
      for (const path of collectMediaPaths(input.draft.nodes)) {
        const rel = relative(join(root, 'media'), path);
        const inside =
          rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel);
        if (!inside && !(await services.fileResource.resolveLocalFile(path)))
          throw new Error('媒体访问未授权');
      }
      boundArchive(input);
      const result = workspaceDraftStore(root).save(structuredClone(input.draft));
      trustDraftMedia(result.nodes);
      return result;
    }),
  workspaceRemove: procedure
    .input(accountBinding.extend({ id: z.string().min(1) }))
    .mutation(({ input }) => {
      const { root, store } = boundArchive(input);
      workspaceDraftStore(root).remove(input.id);
      draftStore().remove(input.id);
      if (/^[a-zA-Z0-9-]+$/.test(input.id)) store.remove('history', input.id);
    }),
  archiveList: procedure.input(accountBinding.extend({ kind: archiveKind })).query(({ input }) => {
    const { store, services } = boundArchive(input);
    const entries = store.list(input.kind);
    for (const entry of entries)
      for (const path of collectMediaPaths(entry.nodes)) services.fileResource.trustPath(path);
    return entries;
  }),

  archiveAppend: procedure
    .input(accountBinding.extend({ kind: archiveKind, draft: draftInput }))
    .mutation(async ({ input }) => {
      const { store, services, root } = boundArchive(input);
      const result = await store.append(input.kind, input.draft, async (path) => {
        const rel = relative(join(root, 'media'), path);
        return (
          (rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel)) ||
          Boolean(await services.fileResource.resolveLocalFile(path))
        );
      });
      for (const path of collectMediaPaths(result.nodes)) services.fileResource.trustPath(path);
      return result;
    }),

  archiveRemove: procedure
    .input(accountBinding.extend({ kind: archiveKind, id: z.string().min(1) }))
    .mutation(({ input }) => boundArchive(input).store.remove(input.kind, input.id)),

  /** 当前账号的全部草稿，最近更新在前。 */
  list: procedure.query(() => {
    const drafts = draftStore().list();
    for (const draft of drafts) trustDraftMedia(draft.nodes);
    return drafts;
  }),

  /** 新建 / 覆盖一份草稿。 */
  save: procedure.input(draftInput).mutation(({ input }) => {
    trustDraftMedia(input.nodes);
    return draftStore().save(input);
  }),

  /** 删除一份草稿。 */
  remove: procedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(({ input }) => draftStore().remove(input.id)),
});

export type MergeForwardRouter = typeof mergeForwardRouter;
