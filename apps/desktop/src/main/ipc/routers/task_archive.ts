import { observable } from '@trpc/server/observable';
import { z } from 'zod/v3';
import { backgroundTasks } from '../../background_tasks';
import { getAppContext, requirePlatform } from '../../context/app_context';
import { taskArchiveStore } from '../../task_archive';
import { backgroundTaskVisible, type BackgroundTask } from '../../../shared/background_task';
import { exportTaskResult } from '../../../shared/export_task_result';
import {
  backgroundArchivePolicy,
  backgroundResumeAction,
  backgroundResult,
  exportArchivePolicy,
  flashArchivePolicy,
  flashResult,
  isTaskArchived,
  roamingArchivePolicy,
  roamingResult,
  type TaskArchiveChange,
  type TaskArchiveEntry,
} from '../../../shared/task_archive';
import { procedure, router } from '../trpc';
import { clientAccountBinding } from './client_state';
import { removeHostBackgroundTask } from './background_tasks';

const key = z
  .string()
  .regex(/^(export|roaming|flash|clone|background:(host|window)):(?:send:)?[\w.-]{1,200}$/);
const receipt = z.object({
  id: z.string().min(1).max(200),
  kind: z.enum(['forward', 'album-upload', 'clone', 'send-media']),
  name: z.string().max(400),
  display: z
    .object({
      action: z.string().max(120),
      subject: z.string().max(400).optional(),
      context: z.string().max(400).optional(),
    })
    .optional(),
  status: z.enum(['completed', 'failed', 'cancelled', 'paused']),
  progress: z.number().finite().optional(),
  statusLabel: z.string().max(400).optional(),
  needsConfirmation: z.boolean().optional(),
  note: z.string().max(4000).optional(),
  details: z.array(z.string().max(4000)).max(2000).optional(),
  logs: z
    .array(
      z.object({
        ts: z.number(),
        seq: z.number(),
        stage: z.string(),
        level: z.enum(['info', 'warn', 'error']),
        text: z.string().max(4000),
      }),
    )
    .max(200)
    .optional(),
  forwardTargets: z
    .array(
      z.object({
        id: z.string().max(200),
        name: z.string().max(400),
        kind: z.enum(['c2c', 'group']),
        conv: z.string().max(200),
        seq: z
          .string()
          .regex(/^[1-9]\d{0,9}$/)
          .optional(),
      }),
    )
    .max(200)
    .optional(),
  messageTarget: z
    .object({
      conversationKind: z.enum(['c2c', 'group', 'dataline']),
      conv: z.string().max(200),
      msgId: z.string().max(200),
    })
    .optional(),
  clonePersonaId: z.string().max(200).optional(),
  groupAlbum: z.object({ groupCode: z.string(), albumId: z.string() }).optional(),
  startedAt: z.number().finite(),
  updatedAt: z.number().finite(),
  finishedAt: z.number().finite().optional(),
});
const taskRef = z.object({
  id: key,
  result: z.string().min(1).max(256),
  receipt: receipt.optional(),
});
type TaskRef = z.infer<typeof taskRef>;
type Binding = z.infer<typeof clientAccountBinding>;

function scopedArchive(input: Binding) {
  const { services, account } = getAppContext();
  if (
    !services ||
    account?.context.uin !== input.expectedAccountUin ||
    services.accountConfig.getRecord()?.configId !== input.expectedAccountConfigId
  )
    throw new Error('账号或数据源已切换，请返回原账号后重试');
  return {
    services,
    scope: { uin: input.expectedAccountUin, configId: input.expectedAccountConfigId },
    store: taskArchiveStore(requirePlatform().appDataRoot(), input.expectedAccountConfigId),
  };
}

function windowSnapshot(ref: TaskRef, scope: ReturnType<typeof scopedArchive>['scope']) {
  const row = ref.receipt;
  if (!row) return undefined;
  const prefix = row.kind === 'clone' ? 'clone:' : 'background:window:';
  if (ref.id !== prefix + row.id || backgroundResult(row) !== ref.result) return undefined;
  return { ...row, scope, actions: [] } satisfies BackgroundTask;
}

interface ArchiveTarget {
  result: string;
  manual: boolean;
  auto?: boolean;
  canConfirmDelivery?: boolean;
  needsConfirmation?: boolean;
  snapshot?: BackgroundTask;
  resume?: () => boolean | Promise<boolean>;
  remove?: () => boolean | Promise<boolean>;
}

function resolveTarget(
  context: ReturnType<typeof scopedArchive>,
  ref: TaskRef,
  web: boolean,
): ArchiveTarget | undefined {
  const { services, scope, store } = context;
  const [kind, ...identity] = ref.id.split(':');
  const id = identity.join(':');
  if (kind === 'export') {
    const manager = services.exportManager;
    const task = manager.getTask(id);
    return task
      ? {
          result: exportTaskResult(task).result,
          ...exportArchivePolicy({ ...task, isFinalizing: manager.isTaskFinalizing(id) }),
          resume: task.status === 'paused' ? () => manager.resumeTask(id) : undefined,
          remove: () => manager.deleteTask(id),
        }
      : undefined;
  }
  if (kind === 'roaming') {
    const job = services.roamingBackfill.list().find((row) => row.id === id);
    return (
      job && {
        result: roamingResult(job),
        manual: roamingArchivePolicy(job.status),
        resume:
          job.status === 'paused'
            ? () => {
                services.roamingBackfill.start(id);
                return true;
              }
            : undefined,
        remove: () => {
          services.roamingBackfill.remove(id);
          return true;
        },
      }
    );
  }
  if (kind === 'flash') {
    const downloads = services.flashTransferFiles.downloads;
    const task = downloads.list(undefined, false).find((row) => row.id === id);
    if (!task) return undefined;
    const policy = flashArchivePolicy(task);
    const needsDevice = (web || task.browserOutput) && task.status === 'done';
    return {
      result: flashResult(task),
      manual: policy.manual,
      auto: policy.auto && !needsDevice,
      canConfirmDelivery: policy.manual && needsDevice,
      resume:
        task.interrupted && task.canRetry
          ? () => downloads.retry(id, { background: true })
          : undefined,
      remove: async () => (await downloads.clearFinishedSelection([id])) > 0,
    };
  }
  const saved = store.get(ref.id)?.snapshot;
  if (ref.id.startsWith('background:host:')) {
    const task = backgroundTasks.snapshot().find((row) => row.id === identity[1]);
    if (task) {
      if ((task.kind === 'update' && web) || task.foreground || !backgroundTaskVisible(task, scope))
        return undefined;
      const resume = backgroundResumeAction(task);
      return {
        result: backgroundResult(task),
        ...backgroundArchivePolicy(task),
        snapshot: task,
        needsConfirmation: task.needsConfirmation,
        resume: resume
          ? async () => {
              await backgroundTasks.act(task.id, resume.id);
              return true;
            }
          : undefined,
        remove: () => removeHostBackgroundTask(task, web),
      };
    }
  }
  const task =
    saved && backgroundResult(saved) === ref.result ? saved : (windowSnapshot(ref, scope) ?? saved);
  if (!task || !backgroundTaskVisible(task, scope) || (task.kind === 'update' && web))
    return undefined;
  return {
    result: backgroundResult(task),
    ...backgroundArchivePolicy(task),
    snapshot: task,
    needsConfirmation: task.needsConfirmation,
  };
}

function storedSnapshot(task: BackgroundTask | undefined): BackgroundTask | undefined {
  return (
    task && {
      ...task,
      actions: [],
      // 下载票据和临时窗口标识没有跨重启用途。
      download: undefined,
      ownerId: undefined,
      logs: task.logs?.slice(-200),
      details: task.details?.slice(0, 2000),
    }
  );
}

async function prepare(input: Binding, refs: readonly TaskRef[]) {
  const context = scopedArchive(input);
  if (refs.some((ref) => ref.id.startsWith('flash:'))) {
    await context.services.flashTransferFiles.downloads.load();
    if (scopedArchive(input).services !== context.services) throw new Error('数据源已切换');
  }
  return context;
}

export const taskArchiveRouter = router({
  list: procedure
    .input(clientAccountBinding)
    .query(({ input }) => scopedArchive(input).store.snapshot()),
  summaries: procedure
    .input(clientAccountBinding)
    .query(({ input }) => scopedArchive(input).store.summaries()),
  detail: procedure
    .input(clientAccountBinding.extend({ id: key, result: z.string().min(1) }))
    .query(({ input }) => {
      const { store, scope } = scopedArchive(input);
      const entry = store.get(input.id);
      return entry?.result === input.result &&
        entry.snapshot &&
        backgroundTaskVisible(entry.snapshot, scope)
        ? entry.snapshot
        : null;
    }),
  changes: procedure.input(clientAccountBinding).subscription(({ input }) => {
    const { store } = scopedArchive(input);
    return observable<TaskArchiveChange>((emit) => {
      const version = store.version();
      const unsubscribe = store.subscribe((change) => emit.next(change));
      emit.next(version);
      return unsubscribe;
    });
  }),
  changed: procedure.input(clientAccountBinding).subscription(({ input }) => {
    const { store } = scopedArchive(input);
    return observable<boolean>((emit) => store.subscribe(() => emit.next(true)));
  }),
  change: procedure
    .input(
      clientAccountBinding.extend({
        tasks: z.array(taskRef).min(1).max(500),
        action: z.enum(['archive', 'auto', 'restore', 'deliver', 'record', 'verify']),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const context = await prepare(input, input.tasks);
      const { store, scope } = context;
      const web = Boolean(ctx.authorize);
      const patch: Record<string, TaskArchiveEntry> = {};
      for (const ref of input.tasks) {
        if (store.busy.has(ref.id)) continue;
        const previous = store.get(ref.id);
        const sameResult = previous?.result === ref.result;
        if (input.action === 'restore') {
          if (previous && isTaskArchived(previous, ref.result))
            patch[ref.id] = { ...previous, archivedAt: undefined, restored: true };
          continue;
        }
        if (input.action === 'record') {
          const snapshot = windowSnapshot(ref, scope);
          if (
            snapshot?.kind !== 'forward' ||
            sameResult ||
            (previous?.snapshot && previous.snapshot.updatedAt >= snapshot.updatedAt)
          )
            continue;
          patch[ref.id] = { result: ref.result, snapshot: storedSnapshot(snapshot) };
          continue;
        }
        const target = resolveTarget(context, ref, web);
        if (
          !target ||
          target.result !== ref.result ||
          isTaskArchived(previous, ref.result) ||
          (sameResult && previous.deleted)
        )
          continue;
        if (input.action === 'verify') {
          if (target.needsConfirmation && !(sameResult && previous.verified))
            patch[ref.id] = {
              ...(sameResult ? previous : {}),
              result: ref.result,
              verified: true,
              snapshot: storedSnapshot(target.snapshot),
            };
          continue;
        }
        if (input.action === 'deliver') {
          if (target.canConfirmDelivery && !(sameResult && previous.delivered))
            patch[ref.id] = { result: ref.result, delivered: true };
          continue;
        }
        if (input.action === 'auto' && (!target.auto || (sameResult && previous.restored)))
          continue;
        if (!target.manual) continue;
        patch[ref.id] = {
          ...(sameResult ? previous : {}),
          result: ref.result,
          archivedAt: Date.now(),
          seen: input.action === 'auto' || (sameResult ? previous.seen : undefined),
          restored: undefined,
          snapshot: storedSnapshot(target.snapshot),
        };
      }
      const delta = store.update(patch);
      return { changed: Object.keys(patch).length, delta };
    }),
  resume: procedure
    .input(clientAccountBinding.extend({ task: taskRef }))
    .mutation(async ({ input, ctx }) => {
      const ref = input.task;
      const context = await prepare(input, [ref]);
      const { store } = context;
      if (store.busy.has(ref.id) || !isTaskArchived(store.get(ref.id), ref.result))
        return { resumed: false };
      const target = resolveTarget(context, ref, Boolean(ctx.authorize));
      if (!target?.manual || target.result !== ref.result || !target.resume)
        return { resumed: false };
      // 续作成功后才移除归档；等待业务接受续作时，防止同时恢复或删除同一条记录。
      store.busy.add(ref.id);
      try {
        if (!(await target.resume())) return { resumed: false };
        return { resumed: true, delta: store.update({ [ref.id]: null }) };
      } finally {
        store.busy.delete(ref.id);
      }
    }),
  remove: procedure
    .input(clientAccountBinding.extend({ task: taskRef }))
    .mutation(async ({ input, ctx }) => {
      const ref = input.task;
      const context = await prepare(input, [ref]);
      const { store } = context;
      const previous = store.get(ref.id);
      if (
        !isTaskArchived(previous, ref.result) ||
        store.busy.has(ref.id) ||
        (ctx.authorize && previous?.snapshot?.kind === 'update')
      )
        return false;
      const target = resolveTarget(context, ref, Boolean(ctx.authorize));
      if (target && (!target.manual || target.result !== ref.result)) return false;
      // 同一条记录的恢复、归档、续作和删除不能交错。
      store.busy.add(ref.id);
      try {
        if (target?.remove && !(await target.remove())) return false;
        store.update({
          [ref.id]:
            ref.id.startsWith('background:window:') || ref.id.startsWith('clone:')
              ? { result: ref.result, deleted: true }
              : null,
        });
        return true;
      } finally {
        store.busy.delete(ref.id);
      }
    }),
});
