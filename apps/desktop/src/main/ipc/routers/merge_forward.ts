/**
 * `mergeForward.*` —— 「合成聊天记录」（合并转发）草稿的读写。
 *
 * 合并转发的**发送**要 QQ 在线且已注入；不在线时用户辛苦拼出来的聊天记录不能丢，
 * 所以草稿落在 weq 数据目录（`userConfig.cacheDir('merge-forward')`）里，一个账号
 * 一份 JSON，下次继续编辑。
 *
 * 这里**刻意不碰 protocol**：真正的合并转发发送（UploadLongMsg）由另一分支接入，
 * 本路由只负责「草稿的本地持久化」这一件事。
 */

import { join } from 'node:path';
import { z } from 'zod';
import { MergeForwardDraftStore } from '@weq/service';
import { getAppContext, requireBootstrap } from '../../context/app_context';
import { procedure, router } from '../trpc';

/** 逐条消息装扮（列 40801）。0 = 未设置。 */
const decoration = z
  .object({
    bubbleId: z.number().int().nonnegative(),
    fontId: z.number().int().nonnegative(),
    widgetId: z.number().int().nonnegative(),
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
  /** 渲染视图元素，形状由渲染层决定，这里只保证是对象数组。 */
  elements: z.array(z.record(z.string(), z.unknown())),
  time: z.number(),
  decoration,
  sourceMsgId: z.string().optional(),
});

const draftInput = z.object({
  id: z.string().min(1),
  title: z.string().optional(),
  createdAt: z.number().optional(),
  nodes: z.array(node),
});

/** 已实例化的 store，按落盘路径缓存（读盘只发生一次）。 */
const stores = new Map<string, MergeForwardDraftStore>();

function draftStore(): MergeForwardDraftStore {
  const uin = getAppContext().account?.context.uin;
  const dir = requireBootstrap().userConfig.cacheDir('merge-forward');
  const path = join(dir, `${uin ?? 'unknown'}.json`);
  let store = stores.get(path);
  if (!store) {
    store = new MergeForwardDraftStore(path);
    stores.set(path, store);
  }
  return store;
}

export const mergeForwardRouter = router({
  /** 当前账号的全部草稿，最近更新在前。 */
  list: procedure.query(() => draftStore().list()),

  /** 新建 / 覆盖一份草稿。 */
  save: procedure.input(draftInput).mutation(({ input }) => draftStore().save(input)),

  /** 删除一份草稿。 */
  remove: procedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(({ input }) => draftStore().remove(input.id)),
});

export type MergeForwardRouter = typeof mergeForwardRouter;
