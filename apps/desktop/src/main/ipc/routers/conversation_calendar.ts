import { z } from 'zod';
import {
  createCalendarSources,
  generatedMessages,
} from '@weq/service/conversation-calendar-sources';
import { randomUUID } from 'node:crypto';
import type { AccountSession } from '@weq/account';
import { type CalendarMetadataDb, withDatabasePriority, withDatabaseReadBudget } from '@weq/db';
import {
  CALENDAR_CACHE_BYTES,
  ConversationCalendarJob,
  calendarMonthDays,
  calendarTargetKey,
  type CalendarTarget,
  type CalendarKind,
} from '@weq/service/conversation-calendar';
import { getAppContext, type AccountServices } from '../../context/app_context';
import { procedure, router } from '../trpc';
import { exportAccountBindingInput } from './export_save';
import { c2cMsgToWire, groupMsgToWire, type ChatMsgWire } from '../serde';
import { roamingMsgToWire } from '../roaming_message_wire';
import { timelineRowKey } from '@weq/service/roaming-timeline';
import { backgroundTasks } from '../../background_tasks';

const targetInput = z.object({
  kind: z.enum([
    'c2c',
    'group',
    'dataline',
    'official',
    'service',
    'guild',
    'persona',
    'cloneGroup',
  ]),
  conv: z.string().min(1).max(256),
  name: z.string().max(512),
  avatar: z.string().max(2048).nullable(),
  ancestors: z.array(z.string().max(128)).max(8),
  hiddenIds: z.record(z.string().max(256), z.array(z.string().max(256)).max(1000)).optional(),
  searchText: z.string().max(4096).optional(),
  listingSearchText: z.string().max(4096).optional(),
});
const requestInput = exportAccountBindingInput.extend({ id: z.string().uuid() });
const dayInput = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional();
interface Entry {
  taskId: string;
  day?: string;
  job: ConversationCalendarJob;
  session: AccountSession;
  services: AccountServices;
  readers: Map<CalendarKind, CalendarMetadataDb>;
  targets: CalendarTarget[];
}
const sessions = new WeakMap<AccountSession, Map<string, Entry>>();

function syncTask(value: Entry) {
  const snapshot = value.job.snapshot(value.day, 0, true);
  const { completedSources: done, totalSources: total, failedSources: failed } = snapshot.progress;
  const complete = done === total && snapshot.complete;
  const status = complete
    ? 'completed'
    : snapshot.cancelled
      ? 'cancelled'
      : failed && done + failed === total
        ? 'paused'
        : 'running';
  const previous = backgroundTasks.snapshot().find((task) => task.id === value.taskId);
  if (!previous) return;
  if (previous.status !== 'running' && status === 'running') backgroundTasks.resume(value.taskId);
  const patch = {
    progress: total ? (done / total) * 100 : 100,
    note: `已完成 ${done}/${total} 个日期来源${failed ? `，${failed} 个暂停` : ''}`,
    logs: snapshot.logs,
    subtasks: [
      { label: '本月日期来源', done, total, failed },
      ...(snapshot.dayProgress
        ? [
            {
              label: `${value.day} 来源`,
              done: snapshot.dayProgress.completedSources,
              total: snapshot.dayProgress.totalSources,
              failed: 0,
            },
          ]
        : []),
    ],
  };
  if (status === 'running') backgroundTasks.update(value.taskId, patch);
  else backgroundTasks.finish(value.taskId, status, patch);
  if ((status === 'running') !== previous.actions.some((action) => action.id === 'stop'))
    backgroundTasks.setActions(
      value.taskId,
      status === 'running'
        ? [{ id: 'stop', label: '停止统计', run: () => value.job.cancel() }]
        : [],
    );
}

function current(input: { expectedAccountUin?: string; expectedAccountConfigId?: string }) {
  const ctx = getAppContext();
  if (!ctx.account || !ctx.services || !ctx.platform) throw new Error('账号尚未打开');
  if (
    (input.expectedAccountUin && input.expectedAccountUin !== ctx.account.context.uin) ||
    (input.expectedAccountConfigId &&
      input.expectedAccountConfigId !== ctx.services.accountConfig.getRecord()?.configId)
  )
    throw new Error('账号或数据源已切换');
  return { session: ctx.account, services: ctx.services, native: ctx.platform.native.ntHelper };
}
function entry(input: z.infer<typeof requestInput>): Entry {
  const { session } = current(input);
  const value = sessions.get(session)?.get(input.id);
  if (!value) throw new Error('日历任务已结束，请重新打开日历');
  const cache = sessions.get(session)!;
  cache.delete(input.id);
  cache.set(input.id, value);
  while (
    cache.size > 1 &&
    [...cache.values()].reduce((sum, item) => sum + item.job.memoryBytes, 0) > CALENDAR_CACHE_BYTES
  ) {
    const first = cache.keys().next().value!;
    cache.get(first)?.job.cancel();
    cache.delete(first);
  }
  return value;
}

export const conversationCalendarRouter = router({
  start: procedure
    .input(
      exportAccountBindingInput.extend({
        month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
        targets: z.array(targetInput).max(12000),
        day: dayInput,
      }),
    )
    .mutation(({ input }) => {
      const { session, services, native } = current(input);
      if (input.day && !calendarMonthDays(input.month).some((value) => value.day === input.day))
        throw new Error('日期不属于当前月份');
      let cache = sessions.get(session);
      if (!cache) {
        cache = new Map();
        sessions.set(session, cache);
      }
      const unique = [
        ...new Map(input.targets.map((target) => [calendarTargetKey(target), target])).values(),
      ];
      if (
        unique.some((target) => target.kind !== 'persona' && target.kind !== 'cloneGroup') &&
        !native.executeSqlBudgeted
      )
        throw new Error('会话日历需要支持短预算读取的原生组件，请更新原生组件后重试');
      const value = {
        session,
        services,
        targets: unique,
        readers: new Map<CalendarKind, CalendarMetadataDb>(),
      };
      const sources = createCalendarSources(value, native, () => {
        if (getAppContext().account !== value.session)
          throw new DOMException('账号已切换', 'AbortError');
      });
      const id = randomUUID();
      const pool = cache;
      const reserve = (bytes: number) => {
        while (
          [...pool.values()].reduce((sum, item) => sum + item.job.memoryBytes, 0) + bytes >
          CALENDAR_CACHE_BYTES
        ) {
          const victim = [...pool.keys()].find((key) => key !== id);
          if (!victim) return false;
          pool.get(victim)?.job.cancel();
          pool.delete(victim);
        }
        return true;
      };
      const job = new ConversationCalendarJob(input.month, unique, sources, reserve);
      const taskId = backgroundTasks.start({
        name: `会话日历 · ${input.month}`,
        kind: 'calendar',
        scope: { uin: session.context.uin, configId: services.accountConfig.getRecord()?.configId },
      });
      const tracked: Entry = { ...value, job, taskId, day: input.day };
      cache.set(id, tracked);
      job.controller.signal.addEventListener('abort', () => syncTask(tracked), { once: true });
      while (cache.size > 12) {
        const first = cache.keys().next().value!;
        cache.get(first)?.job.cancel();
        cache.delete(first);
      }
      withDatabasePriority(
        'background',
        () =>
          withDatabaseReadBudget(
            10,
            () => job.keepAlive(input.day),
            (ms) => job.observeRead(ms),
            () => job.noteWaiting(),
          ),
        job.controller.signal,
      );
      syncTask(tracked);
      void job.settled().then(() => syncTask(tracked));
      return { id, taskId };
    }),
  poll: procedure
    .input(
      requestInput.extend({
        day: dayInput,
        offset: z.number().int().min(0).default(0),
        retry: z.boolean().default(false),
        includeLogs: z.boolean().default(false),
      }),
    )
    .query(({ input }) => {
      const value = entry(input);
      if (input.day && !input.day.startsWith(`${value.job.month}-`))
        throw new Error('日期不属于当前月份');
      const changed = value.day !== input.day || input.retry;
      value.day = input.day;
      withDatabasePriority(
        'background',
        () =>
          withDatabaseReadBudget(
            10,
            () => value.job.keepAlive(input.day, input.retry),
            (ms) => value.job.observeRead(ms),
            () => value.job.noteWaiting(),
          ),
        value.job.controller.signal,
      );
      syncTask(value);
      if (changed) void value.job.settled().then(() => syncTask(value));
      return value.job.snapshot(input.day, input.offset, input.includeLogs);
    }),
  stop: procedure.input(requestInput).mutation(({ input }) => {
    entry(input).job.cancel();
    return true;
  }),
  locate: procedure
    .input(
      requestInput.extend({
        target: targetInput,
        anchor: z.object({
          id: z.string().min(1).max(256),
          seq: z.string().max(64),
          time: z.number(),
          sessionId: z.string().nullable().optional(),
        }),
      }),
    )
    .mutation(async ({ input }) => {
      const value = entry(input);
      const target = value.targets.find(
        (candidate) => calendarTargetKey(candidate) === calendarTargetKey(input.target),
      );
      if (!target) throw new Error('该会话已不在日历范围内');
      const anchor = value.job.anchor(target, input.anchor.id);
      if (!anchor) throw new Error('该消息不是当前日历的定位目标，请刷新当天统计');
      const cachedMessage =
        anchor.id.startsWith('roaming:') &&
        (target.kind === 'c2c' || target.kind === 'group' || target.kind === 'dataline')
          ? (
              await value.services.gapHistory.cachedTimeline(
                target.kind === 'group' ? 'group' : 'c2c',
                target.conv,
                Number(anchor.seq),
                Number(anchor.seq),
                256,
                false,
              )
            ).find((message) => timelineRowKey({ ...message, source: 'roaming' }) === anchor.id)
          : undefined;
      const exists =
        target.kind === 'persona' || target.kind === 'cloneGroup'
          ? generatedMessages(value.services, target, anchor.sessionId ?? null).some(
              (message) => message.id === anchor.id && message.ts / 1000 === anchor.time,
            )
          : anchor.id.startsWith('roaming:') &&
              (target.kind === 'c2c' || target.kind === 'group' || target.kind === 'dataline')
            ? Boolean(cachedMessage)
            : await withDatabasePriority('interactive', () =>
                withDatabaseReadBudget(10, () =>
                  value.readers.get(target.kind)!.exists(anchor.id, target.conv, anchor.time),
                ),
              );
      current(input);
      if (!exists) throw new Error('该消息已不存在，请刷新当天统计');
      if (
        (target.kind === 'c2c' || target.kind === 'group' || target.kind === 'dataline') &&
        value.services.msgs
          .getHiddenDeletedMsgIds(target.kind === 'group' ? 'group' : 'c2c', target.conv)
          .includes(anchor.id)
      )
        throw new Error('该消息已隐藏，请刷新当天统计');
      let record: ChatMsgWire | undefined = cachedMessage
        ? roamingMsgToWire(cachedMessage)
        : undefined;
      if (target.kind === 'group' && !anchor.id.startsWith('roaming:')) {
        const message = await value.services.msgs.getGroupMessageById(
          target.conv,
          BigInt(anchor.id),
        );
        if (!message) throw new Error('该消息已不存在，请刷新当天统计');
        record = groupMsgToWire(message);
      } else if (
        (target.kind === 'c2c' || target.kind === 'dataline') &&
        !anchor.id.startsWith('roaming:')
      ) {
        const message = await value.services.msgs.getC2cMessageById(target.conv, BigInt(anchor.id));
        if (!message) throw new Error('该消息已不存在，请刷新当天统计');
        record = c2cMsgToWire(message);
      }
      current(input);
      return { target, anchor, record };
    }),
});
