import { statfs } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { TRPCError } from '@trpc/server';
import { observable } from '@trpc/server/observable';
import { z } from 'zod';
import { describeExportOutput, exportOutputFileName, getHost } from '@weq/service';
import {
  MailFailure,
  exportMailMessages,
  exportAllMailMessages,
  previewMailExport,
  type MailEvent,
  type QQMailService,
} from '@weq/service/mail';
import { getAppContext } from '../../context/app_context';
import { procedure, router } from '../trpc';
import { rememberMail } from '../../search_content';
import { exportSavePolicyInput } from './export_save';

const account = z.object({ selfUin: z.string().regex(/^[1-9]\d{4,19}$/) });
const operation = account.extend({ requestId: z.string().uuid() });
const mailId = z.string().min(1).max(2048);
const mailExportFilterInput = z
  .object({
    startTime: z.number().int().nonnegative().optional(),
    endTime: z.number().int().nonnegative().optional(),
    sender: z.string().max(254).optional(),
    subject: z.string().max(1000).optional(),
  })
  .refine(
    (value) =>
      value.startTime === undefined ||
      value.endTime === undefined ||
      value.startTime < value.endTime,
    '结束时间必须晚于开始时间',
  );
const address = z.object({ email: z.string().min(3).max(254), name: z.string().max(256) });
const pending = new Map<string, { service: QQMailService; controller: AbortController }>();

function service(selfUin: string): QQMailService {
  const context = getAppContext();
  if (!context.services || String(context.account?.context.uin) !== selfUin)
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: '账号已切换，请重新打开邮箱。' });
  return context.services.mail;
}

function safeError(error: unknown): TRPCError {
  if (error instanceof TRPCError) return error;
  return new TRPCError({
    code: 'BAD_REQUEST',
    message: error instanceof MailFailure ? error.message : '邮箱操作失败，请稍后重试。',
  });
}

async function perform<T>(
  input: { selfUin: string; requestId: string },
  run: (mail: QQMailService, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const mail = service(input.selfUin);
  if (
    pending.has(input.requestId) ||
    [...pending.values()].filter((entry) => entry.service === mail).length >= 8
  )
    throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: '请等待当前邮箱请求完成。' });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15 * 60_000);
  timer.unref();
  pending.set(input.requestId, { service: mail, controller });
  try {
    const value = await run(mail, controller.signal);
    controller.signal.throwIfAborted();
    if (service(input.selfUin) !== mail) throw new MailFailure('auth', '邮箱账号状态已变化。');
    return value;
  } catch (error) {
    throw safeError(error);
  } finally {
    clearTimeout(timer);
    pending.delete(input.requestId);
  }
}

export const mailRouter = router({
  previewExport: procedure
    .input(
      operation.extend({
        ids: z.array(mailId).min(1).max(100).nullable(),
        filter: mailExportFilterInput,
        expectedAccountConfigId: z.string().min(1),
      }),
    )
    .mutation(({ input }) =>
      perform(input, async (mail, signal) => {
        const services = getAppContext().services!;
        const check = () => {
          if (
            service(input.selfUin) !== mail ||
            getAppContext().services !== services ||
            services.accountConfig.getRecord()?.configId !== input.expectedAccountConfigId
          )
            throw new MailFailure('auth', '账号或数据源已切换，请重新查询待导出邮件。');
        };
        return previewMailExport(mail, input.ids, input.filter, signal, check);
      }),
    ),
  exportMessages: procedure
    .input(
      account.extend({
        ids: z.array(mailId).min(1).max(100000).nullable(),
        filter: mailExportFilterInput.optional(),
        expandThreads: z.boolean().default(true),
        expectedAccountConfigId: z.string().min(1),
        savePolicy: exportSavePolicyInput,
      }),
    )
    .mutation(({ input }) => {
      const mail = service(input.selfUin);
      const services = getAppContext().services!;
      const check = () => {
        if (
          service(input.selfUin) !== mail ||
          getAppContext().services !== services ||
          services.accountConfig.getRecord()?.configId !== input.expectedAccountConfigId
        )
          throw new MailFailure('auth', '账号或数据源已切换，请重新选择邮件。');
      };
      check();
      return services.exportManager.startResourceExport({
        kind: 'mail-messages',
        name: input.ids === null ? '所有邮件' : `邮件导出-${input.ids.length}封`,
        savePolicy: input.savePolicy,
        run: (context) =>
          input.ids === null
            ? exportAllMailMessages(mail, context, check, input.filter)
            : exportMailMessages(
                mail,
                input.ids,
                context,
                check,
                input.filter,
                input.expandThreads,
              ),
      });
    }),
  saveAttachment: procedure
    .input(
      account.extend({
        id: z.string().uuid(),
        expectedAccountConfigId: z.string().min(1),
        savePolicy: exportSavePolicyInput,
      }),
    )
    .mutation(({ input }) => {
      const mail = service(input.selfUin);
      const services = getAppContext().services!;
      const check = () => {
        if (
          service(input.selfUin) !== mail ||
          getAppContext().services !== services ||
          services.accountConfig.getRecord()?.configId !== input.expectedAccountConfigId
        )
          throw new MailFailure('auth', '账号或数据源已切换，请重新选择附件。');
      };
      check();
      const attachment = mail.attachments.get(input.id);
      const name = basename(attachment.name.replace(/\\/g, '/')) || '附件';
      const output = describeExportOutput(
        { kind: 'file', name, fileName: name },
        { avatar: false, transcribe: false, ocr: false, dress: false },
      );
      if (output.kind !== 'file') throw new MailFailure('business', '附件保存形态无效。');
      const fileName = exportOutputFileName(output);
      return services.exportManager.startResourceExport({
        kind: 'mail-attachment',
        name,
        output,
        savePolicy: input.savePolicy,
        run: async ({ directory, signal }) => {
          check();
          signal.throwIfAborted();
          if (mail.attachments.get(input.id) !== attachment)
            throw new MailFailure('business', '附件已变化，请重新选择。');
          const space = await statfs(directory);
          if (space.bavail * space.bsize < attachment.size + 64 * 1024 * 1024)
            throw new MailFailure('business', '目标磁盘空间不足。');
          try {
            await mail.download(input.id, join(directory, fileName), signal);
          } catch (error) {
            throw safeError(error);
          }
          check();
          signal.throwIfAborted();
          return { total: 1, ok: 1, failed: [], fileName };
        },
      });
    }),
  preferences: procedure.input(account).query(({ input }) => {
    service(input.selfUin);
    const record = getAppContext().services?.accountConfig.getRecord();
    return {
      showUnread: record?.mailShowUnread ?? true,
      notifications: record?.mailNotifications ?? false,
    };
  }),
  setShowUnread: procedure.input(account.extend({ enabled: z.boolean() })).mutation(({ input }) => {
    const mail = service(input.selfUin);
    getAppContext().services?.accountConfig.setMailShowUnread(input.enabled);
    mail.setShowUnread(input.enabled);
    return input.enabled;
  }),
  status: procedure.input(account).query(({ input }) => service(input.selfUin).status()),
  connect: procedure
    .input(operation)
    .mutation(({ input }) => perform(input, (mail, signal) => mail.connect(signal))),
  disconnect: procedure.input(account).mutation(({ input }) => {
    const mail = service(input.selfUin);
    getAppContext().services?.accountConfig.setMailNotifications(false);
    mail.disconnect();
    return null;
  }),
  folders: procedure
    .input(operation)
    .query(({ input }) => perform(input, (mail, signal) => mail.folders(signal))),
  list: procedure
    .input(
      operation.extend({
        folderId: z.number().int().min(0).max(100000),
        page: z.number().int().min(0).max(100000),
        unreadOnly: z.boolean().default(false),
        keyword: z.string().max(200).optional(),
      }),
    )
    .query(async ({ input }) => {
      const contentSearch = getAppContext().services?.contentSearch;
      const page = await perform(input, (mail, signal) => mail.list(input, signal));
      rememberMail(contentSearch, page.items);
      return page;
    }),
  read: procedure.input(operation.extend({ id: mailId })).mutation(async ({ input }) => {
    const contentSearch = getAppContext().services?.contentSearch;
    const detail = await perform(input, (mail, signal) => mail.read(input.id, signal));
    rememberMail(contentSearch, [detail, ...(detail.thread ?? [])]);
    return detail;
  }),
  image: procedure
    .input(operation.extend({ id: z.string().uuid() }))
    .query(({ input }) => perform(input, (mail, signal) => mail.image(input.id, signal))),
  action: procedure
    .input(
      operation.extend({
        ids: z.array(mailId).min(1).max(100),
        action: z.enum(['read', 'unread', 'star', 'unstar', 'trash']),
      }),
    )
    .mutation(async ({ input }) => {
      const contentSearch = getAppContext().services?.contentSearch;
      const result = await perform(input, (mail, signal) =>
        mail.action(input.ids, input.action, signal),
      );
      if (input.action === 'trash')
        for (const id of input.ids) contentSearch?.remove({ kind: 'mailMessage', id, folderId: 0 });
      return result;
    }),
  send: procedure
    .input(
      operation.extend({
        draft: z.boolean().default(false),
        message: z.object({
          subject: z.string().max(1000),
          content: z.string().max(2_000_000),
          plainText: z.boolean(),
          to: z.array(address).max(100),
          cc: z.array(address).max(100),
          bcc: z.array(address).max(100),
          attachments: z.array(z.string().uuid()).max(100),
          replyId: mailId.optional(),
          forwardId: mailId.optional(),
          draftId: mailId.optional(),
        }),
      }),
    )
    .mutation(async ({ input }) => {
      // 已知业务拒绝与传输结果未知分开返回；客户端连接丢失同样必须按未知处理。
      const mail = service(input.selfUin);
      try {
        const result = await perform(input, async (current, signal) => {
          try {
            return {
              state: 'accepted' as const,
              ...(await current.send(input.message, input.draft, signal)),
            };
          } catch (error) {
            if (error instanceof MailFailure)
              return {
                state:
                  error.kind === 'unknown-send' || error.kind === 'network'
                    ? ('unknown' as const)
                    : ('rejected' as const),
                message: error.message,
              };
            throw error;
          }
        });
        if (service(input.selfUin) !== mail)
          return { state: 'unknown' as const, message: '提交期间账号已变化，请先核对邮箱结果。' };
        return result;
      } catch (error) {
        if (error instanceof TRPCError && error.code === 'TOO_MANY_REQUESTS')
          return { state: 'rejected' as const, message: error.message };
        return {
          state: 'unknown' as const,
          message: '提交结果未知，请先检查草稿箱或已发送，不要直接重试。',
        };
      }
    }),
  notifications: procedure.input(operation.extend({ enabled: z.boolean() })).mutation(({ input }) =>
    perform(input, (mail) => {
      getAppContext().services?.accountConfig.setMailNotifications(input.enabled);
      return mail.setNotifications(input.enabled);
    }),
  ),
  upload: procedure.input(operation).mutation(({ input }) =>
    perform(input, async (mail, signal) => {
      const path = await getHost().pickFile({ title: '选择邮件附件' });
      signal.throwIfAborted();
      return path ? mail.upload(path, signal) : null;
    }),
  ),
  download: procedure.input(operation.extend({ id: z.string().uuid() })).mutation(({ input }) =>
    perform(input, async (mail, signal) => {
      const attachment = mail.attachments.get(input.id);
      const name = basename(attachment.name.replace(/\\/g, '/')) || '附件';
      const target = await getHost().pickSaveTarget({
        defaultName: name,
        locationKey: 'mail-attachment',
      });
      if (!target) return null;
      signal.throwIfAborted();
      const space = await statfs(dirname(target.path));
      if (space.bavail * space.bsize < attachment.size + 64 * 1024 * 1024)
        throw new MailFailure('business', '目标磁盘空间不足。');
      await mail.download(input.id, target.path, signal);
      return { downloadId: target.downloadId };
    }),
  ),
  cancel: procedure.input(operation).mutation(({ input }) => {
    const mail = service(input.selfUin),
      entry = pending.get(input.requestId);
    if (entry?.service === mail) entry.controller.abort();
    return null;
  }),
  events: procedure.input(account).subscription(({ input }) => {
    const mail = service(input.selfUin);
    return observable<MailEvent>((observer) => {
      const listener = (event: MailEvent): void => {
        try {
          if (service(input.selfUin) === mail) observer.next(event);
        } catch {
          observer.complete();
        }
      };
      mail.events.on('change', listener);
      observer.next({ type: 'status', status: mail.status() });
      return () => {
        mail.events.off('change', listener);
      };
    });
  }),
});
