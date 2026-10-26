import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { observable } from '@trpc/server/observable';
import { classifyChatType } from '@weq/codec';
import { describeViewerFile, discoverViewerSources, getHost, readViewerPage } from '@weq/service';
import { getAppContext } from '../../context/app_context';
import {
  closeViewerSources,
  registerViewerSource,
  viewerSource,
  viewerMedia,
  beginViewerRead,
  discoverExportDirectories,
} from '../../export_viewer';
import { pushConversationJump } from '../../group_keyword_bus';
import { procedure, router } from '../trpc';

const pendingScans = new Map<string, { path: string; expires: number }>();
function scanToken(path: string) {
  for (const [token, scan] of pendingScans)
    if (scan.expires < Date.now()) pendingScans.delete(token);
  if (pendingScans.size >= 16) pendingScans.delete(pendingScans.keys().next().value!);
  const token = randomUUID();
  pendingScans.set(token, { path, expires: Date.now() + 10 * 60_000 });
  return token;
}
export type ViewerScanEvent =
  | { kind: 'source'; source: ReturnType<typeof registerViewerSource> }
  | { kind: 'done'; truncated: boolean; unreadable: number; scanToken: string | null };
function registerExports(result: Awaited<ReturnType<typeof discoverExportDirectories>>) {
  const registered: string[] = [];
  try {
    const sources = result.sources.map((source) => {
      const item = registerViewerSource(source);
      registered.push(item.id);
      return item;
    });
    return { ...result, sources, scanToken: null as string | null };
  } catch (error) {
    closeViewerSources(registered);
    throw error;
  }
}

async function local(id: string) {
  const source = viewerSource(id);
  const ctx = getAppContext();
  const services = ctx.services;
  const uin = ctx.account?.context.uin;
  const configId = ctx.services?.accountConfig.getRecord()?.configId;
  const conv = source.conversation;
  if (!services || !uin || !configId || !conv) return null;
  const contacts = await services.recentContacts.getRecentContact(-1);
  const matches = contacts.filter(
    (c) =>
      (c.targetUid === conv.conv ||
        (conv.kind === 'c2c' &&
          /^[1-9]\d*$/.test(conv.conv) &&
          String(c.targetUin) === conv.conv)) &&
      classifyChatType(c.chatType) === (conv.kind === 'group' ? 'group' : 'direct'),
  );
  const targets = new Set(matches.map((c) => c.targetUid).filter(Boolean));
  if (getAppContext().services !== services) throw new Error('账号已切换，请重试。');
  return targets.size === 1 ? { kind: conv.kind, conv: [...targets][0]!, uin, configId } : null;
}
export const exportViewerRouter = router({
  pick: procedure
    .input(z.object({ directory: z.boolean(), deferScan: z.boolean().optional() }))
    .mutation(async ({ input }) => {
      const path = input.directory
        ? await getHost().pickDirectory({ title: '选择 WeQ 导出文件夹' })
        : await getHost().pickFile({
            title: '选择聊天 JSON / JSONL',
            extensions: ['json', 'jsonl'],
          });
      if (!path) return null;
      if (input.directory) {
        if (input.deferScan)
          return { sources: [], truncated: false, unreadable: 0, scanToken: scanToken(path) };
        const result = await discoverExportDirectories(path);
        if (!result.sources.length) {
          return { ...registerExports(result), scanToken: scanToken(path) };
        }
        return registerExports(result);
      }
      const source = await describeViewerFile(path);
      // 配套基线必须唯一且会话一致，不能仅凭文件名或最新时间猜测。
      const catalog = await discoverViewerSources(dirname(source.path)).catch(() => null);
      const matches =
        catalog?.sources.filter(
          (s) =>
            s.baselineDirectory &&
            s.conversation?.kind === source.conversation?.kind &&
            s.conversation?.conv === source.conversation?.conv,
        ) ?? [];
      if (!catalog?.truncated && matches.length === 1)
        source.baselineDirectory = matches[0]?.baselineDirectory;
      return {
        sources: [registerViewerSource(source)],
        truncated: false,
        scanToken: null,
        unreadable: 0,
      };
    }),
  scan: procedure
    .input(z.object({ token: z.string().uuid(), recursive: z.boolean() }))
    .mutation(async ({ input }) => {
      const pending = pendingScans.get(input.token);
      pendingScans.delete(input.token);
      if (!pending || pending.expires < Date.now()) throw new Error('目录选择已过期，请重新选择。');
      if (!input.recursive) return null;
      const result = await discoverExportDirectories(pending.path, true);
      if (!result.sources.length) throw new Error('递归扫描未找到可查看的导出。');
      return registerExports(result);
    }),
  scanProgress: procedure
    .input(z.object({ token: z.string().uuid(), recursive: z.boolean() }))
    .subscription(({ input }) =>
      observable<ViewerScanEvent>((emit) => {
        const controller = new AbortController(),
          registered: string[] = [];
        let finished = false;
        const pending = pendingScans.get(input.token);
        pendingScans.delete(input.token);
        void (async () => {
          if (!pending || pending.expires < Date.now())
            throw new Error('目录选择已过期，请重新选择。');
          const result = await discoverExportDirectories(pending.path, input.recursive, {
            signal: controller.signal,
            onSource: (source) => {
              controller.signal.throwIfAborted();
              const item = registerViewerSource(source);
              registered.push(item.id);
              emit.next({ kind: 'source', source: item });
            },
          });
          controller.signal.throwIfAborted();
          let token: string | null = null;
          if (!registered.length && !input.recursive) token = scanToken(pending.path);
          finished = true;
          emit.next({
            kind: 'done',
            truncated: result.truncated,
            unreadable: result.unreadable,
            scanToken: token,
          });
          emit.complete();
        })().catch((error: unknown) => {
          if (controller.signal.aborted) return;
          // 已发给界面的部分来源继续可读，界面负责关闭；异常不冒称扫描完成。
          finished = true;
          emit.error(error);
        });
        return () => {
          controller.abort();
          if (!finished) closeViewerSources(registered);
        };
      }),
    ),
  page: procedure
    .input(
      z.object({
        id: z.string().uuid(),
        offset: z.number().int().min(0).max(100000000),
        query: z.string().max(512).optional(),
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      }),
    )
    .query(({ input }) => readViewerPage(viewerSource(input.id), input, beginViewerRead(input.id))),
  local: procedure.input(z.object({ id: z.string().uuid() })).query(({ input }) => local(input.id)),
  jump: procedure
    .input(
      z.object({
        id: z.string().uuid(),
        msgId: z.string().regex(/^\d+$/).optional(),
        expectedUin: z.string(),
        expectedConfigId: z.string(),
      }),
    )
    .mutation(async ({ input }) => {
      const target = await local(input.id);
      if (!target || target.uin !== input.expectedUin || target.configId !== input.expectedConfigId)
        throw new Error('本机会话不可用或账号已切换。');
      const ctx = getAppContext();
      const services = ctx.services;
      if (
        !services ||
        ctx.account?.context.uin !== target.uin ||
        services.accountConfig.getRecord()?.configId !== target.configId
      )
        throw new Error('账号已切换，请重试。');
      let seq = '';
      if (input.msgId) {
        const row =
          target.kind === 'group'
            ? await services.msgs.getGroupMessageById(target.conv, BigInt(input.msgId))
            : await services.msgs.getC2cMessageById(target.conv, BigInt(input.msgId));
        if (!row) throw new Error('本机未找到这条消息，可以使用“打开会话”。');
        const rowConv = 'targetGroupCode' in row ? row.targetGroupCode : row.targetUid;
        if (rowConv !== target.conv) throw new Error('本机消息不属于这个会话，已取消定位。');
        seq = String(row.msgSeq);
        if (row.msgSeq <= 0n) throw new Error('这条消息没有可定位的序号，可以使用“打开会话”。');
      }
      if (getAppContext().services !== services) throw new Error('账号已切换，请重试。');
      pushConversationJump({ kind: target.kind, conv: target.conv, seq });
      return true;
    }),
  revealMedia: procedure
    .input(z.object({ id: z.string().uuid(), path: z.string().max(4096) }))
    .mutation(async ({ input }) => {
      const path = await viewerMedia(input.id, input.path);
      if (!path) throw new Error('导出目录内未找到此文件。');
      await getHost().revealInFolder(path);
    }),
  close: procedure
    .input(z.object({ ids: z.array(z.string().uuid()).max(64) }))
    .mutation(({ input }) => {
      closeViewerSources(input.ids);
      return true;
    }),
});
