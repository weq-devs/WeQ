import { OperationError } from '@weq/service';
import { z } from 'zod';
import {
  createCalendarSources,
  generatedMessages,
} from '@weq/service/conversation-calendar-sources';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { CalendarCheckpointStore } from '@weq/service/conversation-calendar-store';
import type { AccountSession } from '@weq/account';
import { type CalendarMetadataDb, withDatabasePriority, withDatabaseReadBudget } from '@weq/db';
import {
  CALENDAR_CACHE_BYTES,
  ConversationCalendarJob,
  calendarMonthDays,
  calendarToday,
  calendarTargetKey,
  CALENDAR_SOURCE_ORDER,
  type CalendarTarget,
  type CalendarKind,
} from '@weq/service/conversation-calendar';
import {
  getAppContext,
  accountEventBus,
  accountRuntimeCacheRoot,
  type AccountServices,
} from '../../context/app_context';
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
    'assistant',
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
  loaded: boolean;
  ready?: Promise<void>;
  store?: CalendarCheckpointStore;
  key: string;
  taskId?: string;
  day?: string;
  job: ConversationCalendarJob;
  session: AccountSession;
  services: AccountServices;
  readers: Map<CalendarKind, CalendarMetadataDb>;
  targets: CalendarTarget[];
}
const sessions = new WeakMap<AccountSession, Map<string, Entry>>();
export async function flushConversationCalendarResults(): Promise<void> {
  const session = getAppContext().account;
  if (!session) return;
  const values = [...(sessions.get(session)?.values() ?? [])];
  for (const value of values) value.job.cancel();
  await Promise.all(
    values.map(async (value) => {
      await value.ready;
      await value.store?.flush();
    }),
  );
}
function retire(value: Entry | undefined) {
  if (!value) return;
  value.job.cancel();
  if (value.loaded) void value.store?.flush().catch(() => {});
  else void value.ready?.then(() => value.store?.flush()).catch(() => {});
}
const kindsInput = z.array(targetInput.shape.kind).max(CALENDAR_SOURCE_ORDER.length).optional();
function runJob(value: Entry, day = value.day, retry = false) {
  withDatabasePriority(
    'background',
    () =>
      withDatabaseReadBudget(
        10,
        () => value.job.keepAlive(day, retry),
        (ms) => value.job.observeRead(ms),
        () => value.job.noteWaiting(),
        (state) => value.job.observeState(state),
      ),
    value.job.controller.signal,
  );
}
accountEventBus.on('closing', (session: AccountSession | null) => {
  if (session)
    for (const value of sessions.get(session)?.values() ?? []) {
      retire(value);
    }
});

function syncTask(value: Entry) {
  if (!value.taskId) return;
  const snapshot = value.job.snapshot(value.day, 0, true);
  const { completedSources: done, totalSources: total, failedSources: failed } = snapshot.progress;
  const complete = done === total && snapshot.complete && !snapshot.hasPending;
  const status = complete
    ? 'completed'
    : snapshot.cancelled
      ? 'cancelled'
      : !snapshot.canRun || snapshot.controls.month.state === 'empty'
        ? 'paused'
        : 'running';
  const previous = backgroundTasks.snapshot().find((task) => task.id === value.taskId);
  if (!previous) return;
  if (previous.status !== 'running' && status === 'running') backgroundTasks.resume(value.taskId);
  const patch = {
    progress: total ? (done / total) * 100 : 0,
    note:
      snapshot.emptyReason ??
      `已完成 ${done}/${total} 个日期来源${failed ? `，${failed} 个暂停` : ''}`,
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
    retire(cache.get(first));
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
        kinds: kindsInput,
        refresh: z.boolean().default(false),
      }),
    )
    .mutation(async ({ input }) => {
      const { session, services, native } = current(input);
      if (input.day && !calendarMonthDays(input.month).some((value) => value.day === input.day))
        throw new OperationError('日期不属于当前月份', 'expected');
      let cache = sessions.get(session);
      if (!cache) {
        cache = new Map();
        sessions.set(session, cache);
      }
      const unique = [
        ...new Map(input.targets.map((target) => [calendarTargetKey(target), target])).values(),
      ];
      const key = JSON.stringify([
        input.month,
        unique
          .map((target) => [
            calendarTargetKey(target),
            Object.entries(target.hiddenIds ?? {})
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, ids]) => [key, [...ids].sort()]),
          ])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      ]);
      const existing = [...cache].find(([, value]) => value.key === key);
      if (existing) {
        const [id, value] = existing;
        await value.ready;
        if (current(input).session !== session) throw new Error('账号或数据源已切换');
        if (input.refresh) value.job.cancel();
        if (value.job.controller.signal.aborted) {
          await value.job.settled();
          current(input);
          value.job.resume();
          value.job.controller.signal.addEventListener('abort', () => syncTask(value), {
            once: true,
          });
        }
        if (input.refresh) value.job.invalidate();
        value.job.setKinds(input.kinds ?? [...CALENDAR_SOURCE_ORDER]);
        runJob(value, value.day);
        syncTask(value);
        return { id, day: value.day, background: value.job.inBackground };
      }
      if (
        unique.some(
          (target) =>
            target.kind !== 'persona' &&
            target.kind !== 'cloneGroup' &&
            target.kind !== 'assistant',
        ) &&
        !native.executeSqlBudgeted
      )
        throw new OperationError(
          '会话日历需要支持短预算读取的原生组件，请更新原生组件后重试',
          'expected',
        );
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
          retire(pool.get(victim));
          pool.delete(victim);
        }
        return true;
      };
      let tracked: Entry | undefined;
      let lastSync = 0;
      const job = new ConversationCalendarJob(input.month, unique, sources, reserve, () => {
        if (tracked?.loaded) tracked.store?.schedule();
        if (tracked?.taskId && Date.now() - lastSync >= 500) {
          lastSync = Date.now();
          syncTask(tracked);
        }
      });
      tracked = { ...value, key, job, day: input.day, loaded: true };
      cache.set(id, tracked);
      const entry = tracked;
      const root = accountRuntimeCacheRoot(getAppContext());
      if (root) {
        entry.loaded = false;
        const store = new CalendarCheckpointStore(
          root,
          JSON.stringify([
            session.context.uin,
            services.accountConfig.getRecord()?.configId,
            resolve(session.msgDbPath),
            key,
          ]),
          () => job.checkpoint(),
          (message) => {
            job.persistenceError = message;
          },
        );
        entry.store = store;
        entry.ready = (async () => {
          const saved = await store.load();
          if (saved !== undefined && !job.restore(saved))
            store.block('统计结果格式无效，原文件已保留');
          entry.day = job.day ?? input.day;
          entry.loaded = true;
        })();
        await entry.ready;
        if (current(input).session !== session) throw new Error('账号或数据源已切换');
        if (cache.get(id) !== entry) throw new Error('日历缓存已变更，请重新打开');
      }
      job.controller.signal.addEventListener(
        'abort',
        () => {
          syncTask(entry);
        },
        { once: true },
      );
      while (cache.size > 12) {
        const first = cache.keys().next().value!;
        retire(cache.get(first));
        cache.delete(first);
      }
      job.setKinds(input.kinds ?? [...CALENDAR_SOURCE_ORDER]);
      runJob(tracked);
      entry.store?.schedule();
      return { id, day: tracked.day, background: false };
    }),
  background: procedure.input(requestInput).mutation(({ input }) => {
    const value = entry(input);
    if (value.job.controller.signal.aborted) throw new Error('日历任务已停止，请重新打开日历');
    if (!value.taskId || !backgroundTasks.snapshot().some((task) => task.id === value.taskId))
      value.taskId = backgroundTasks.start({
        name: `会话日历 · ${value.job.month}`,
        kind: 'calendar',
        scope: {
          uin: value.session.context.uin,
          configId: value.services.accountConfig.getRecord()?.configId,
        },
      });
    withDatabasePriority(
      'background',
      () =>
        withDatabaseReadBudget(
          10,
          () => value.job.continueInBackground(),
          (ms) => value.job.observeRead(ms),
          () => value.job.noteWaiting(),
          (state) => value.job.observeState(state),
        ),
      value.job.controller.signal,
    );
    syncTask(value);
    void value.job.settled().then(() => {
      syncTask(value);
    });
    return { taskId: value.taskId };
  }),
  poll: procedure
    .input(
      requestInput.extend({
        day: dayInput,
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(12000).default(50),
        retry: z.boolean().default(false),
        includeLogs: z.boolean().default(false),
        kinds: kindsInput,
      }),
    )
    .query(({ input }) => {
      const value = entry(input);
      if (input.day && !input.day.startsWith(`${value.job.month}-`))
        throw new OperationError('日期不属于当前月份', 'expected');
      const changed = value.day !== input.day || input.retry;
      value.day = input.day;
      if (input.kinds) value.job.setKinds(input.kinds);
      runJob(value, input.day, input.retry);
      syncTask(value);
      if (changed) void value.job.settled().then(() => syncTask(value));
      return value.job.snapshot(input.day, input.offset, input.includeLogs, input.limit);
    }),
  task: procedure
    .input(
      exportAccountBindingInput.extend({
        taskId: z.string().uuid(),
        day: dayInput,
        kinds: kindsInput,
        limit: z.number().int().min(1).max(12000).default(50),
        includeLogs: z.boolean().default(false),
      }),
    )
    .query(({ input }) => {
      const { session } = current(input);
      const found = [...(sessions.get(session) ?? [])].find(
        ([, value]) => value.taskId === input.taskId,
      );
      if (!found || !backgroundTasks.snapshot().some((task) => task.id === input.taskId))
        throw new Error('日历任务已结束');
      const [id, value] = found;
      if (input.day && !calendarMonthDays(value.job.month).some(({ day }) => day === input.day))
        throw new OperationError('日期不属于当前月份', 'expected');
      value.day =
        input.day ??
        value.day ??
        (value.job.month === calendarToday().slice(0, 7)
          ? calendarToday()
          : `${value.job.month}-01`);
      if (input.kinds) value.job.setKinds(input.kinds);
      runJob(value);
      syncTask(value);
      return {
        id,
        month: value.job.month,
        day: value.day,
        snapshot: value.job.snapshot(value.day, 0, input.includeLogs, input.limit),
      };
    }),
  stop: procedure.input(requestInput).mutation(({ input }) => {
    const value = entry(input);
    value.job.cancel();
    return value.store?.flush().then(() => true) ?? true;
  }),
  control: procedure
    .input(
      requestInput.extend({
        scope: z.enum(['month', 'day']),
        action: z.enum(['pause', 'continue', 'retry']),
        day: dayInput,
      }),
    )
    .mutation(async ({ input }) => {
      const value = entry(input);
      if (value.job.controller.signal.aborted && input.action !== 'pause') {
        await value.job.settled();
        if (current(input).session !== value.session) throw new Error('账号或数据源已切换');
        value.job.resume();
        value.job.controller.signal.addEventListener('abort', () => syncTask(value), {
          once: true,
        });
      }
      value.job.control(input.scope, input.action, input.day);
      runJob(value);
      syncTask(value);
      void value.job.settled().then(() => syncTask(value));
      await value.store?.flush();
      return value.job.snapshot(value.day);
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
        target.kind === 'persona' || target.kind === 'cloneGroup' || target.kind === 'assistant'
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
