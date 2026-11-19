import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { JsonStore } from '@weq/service/json-store';
import { parseCustomFaceId } from '@weq/protocol';
import type {
  BackgroundTask,
  BackgroundTaskAction,
  BackgroundTaskScope,
} from '../shared/background_task';
import { accountRuntimeCacheRoot, getAppContext } from './context/app_context';
import { backgroundTasks } from './background_tasks';
import { downloadTaskReceipt, downloadTaskSnapshot } from './download_task_receipt';

const receiptSchema = downloadTaskReceipt.extend({
  kind: z.enum(['clone', 'favorite-import', 'resource']),
  name: z.string(),
  display: z
    .object({
      action: z.string(),
      subject: z.string().optional(),
      context: z.string().optional(),
      category: z.string().optional(),
      fileName: z.boolean().optional(),
    })
    .optional(),
  details: z.array(z.string()).optional(),
  clonePersonaId: z.string().optional(),
  request: z.unknown().optional(),
});
type Receipt = z.infer<typeof receiptSchema>;
const stores = new Map<string, JsonStore<Receipt[]>>();
const restored = new WeakMap<object, Set<string>>();

function storeFor(scope?: BackgroundTaskScope | null) {
  const ctx = getAppContext();
  const record = ctx.services?.accountConfig?.getRecord();
  if (
    !scope?.configId ||
    record?.uin !== scope.uin ||
    record.configId !== scope.configId ||
    !ctx.account?.msgDbPath
  )
    return;
  const root = accountRuntimeCacheRoot(ctx);
  if (!root) return;
  const key = createHash('sha256')
    .update(JSON.stringify([scope.uin, scope.configId, ctx.account.msgDbPath]))
    .digest('hex');
  const path = join(root, 'task-receipts', `${key}.json`);
  let store = stores.get(path);
  if (!store) {
    store = new JsonStore<Receipt[]>(path, () => [], {
      normalize: (value) => z.array(receiptSchema).parse(value),
    });
    stores.set(path, store);
  }
  return { store, session: ctx.account };
}

export function recordAccountTask(taskId: string, scope?: BackgroundTaskScope, request?: unknown) {
  const owner = storeFor(scope);
  return (snapshot?: unknown) => {
    const task = backgroundTasks.snapshot().find((entry) => entry.id === taskId);
    if (
      !task ||
      !owner ||
      (task.kind !== 'clone' && task.kind !== 'favorite-import' && task.kind !== 'resource')
    )
      return;
    const { store, session } = owner;
    const receipt: Receipt = {
      ...downloadTaskSnapshot(task),
      kind: task.kind,
      name: task.name,
      display: task.display,
      details: task.details?.slice(0, 1000),
      clonePersonaId: task.clonePersonaId,
      request: snapshot ?? request ?? store.data.find((item) => item.id === taskId)?.request,
    };
    const next = [...store.data.filter((item) => item.id !== taskId), receipt];
    const running = next.filter((item) => item.status === 'running' || item.status === 'paused');
    store.replace([...next.filter((item) => !running.includes(item)).slice(-60), ...running], true);
    const ids = restored.get(session) ?? new Set<string>();
    ids.add(taskId);
    restored.set(session, ids);
  };
}

const favoriteReceipt = z
  .array(z.object({ index: z.number().int().positive(), md5: z.string().regex(/^[a-f0-9]{32}$/i) }))
  .max(1000);

function verifiedClone(receipt: Receipt) {
  if (
    !receipt.clonePersonaId ||
    receipt.status !== 'running' ||
    typeof receipt.request !== 'object' ||
    !receipt.request ||
    !('type' in receipt.request) ||
    receipt.request.type !== 'create'
  )
    return false;
  try {
    const persona = getAppContext().services?.agentLab.getPersona(receipt.clonePersonaId);
    return typeof persona?.trainedAt === 'number' && persona.trainedAt >= receipt.startedAt;
  } catch {
    return false;
  }
}

export function restoreRecordedTasks(
  scope: BackgroundTaskScope,
  retryClone: (id: string, scope: BackgroundTaskScope, request: unknown) => Promise<void>,
) {
  const owner = storeFor(scope);
  if (!owner) return;
  const { store, session } = owner;
  const ids = restored.get(session) ?? new Set<string>();
  restored.set(session, ids);
  for (const receipt of store.data) {
    if (ids.has(receipt.id)) continue;
    ids.add(receipt.id);
    const { request, ...saved } = receipt;
    const committed = saved.kind === 'clone' && verifiedClone(receipt);
    const abandoned = saved.status === 'running' && !committed;
    const uncertain = abandoned && saved.kind === 'favorite-import';
    const status = committed
      ? 'completed'
      : abandoned
        ? uncertain
          ? 'paused'
          : 'failed'
        : saved.status;
    const note = abandoned
      ? saved.kind === 'clone'
        ? '上次构建已中断，可手动重新执行。'
        : uncertain
          ? '上次导入已中断，请刷新 QQ 收藏核对可能已提交的项目。'
          : '上次清理已中断，请重新扫描剩余资源，再选择清理范围。'
      : committed
        ? '已在原数据源找到保存完成的克隆体。'
        : saved.note;
    const actions: BackgroundTaskAction[] = [];
    if (saved.kind === 'clone' && (status === 'failed' || status === 'cancelled') && request)
      actions.push({
        id: 'retry',
        label: '重新执行',
        run: () => {
          if (getAppContext().account !== session) throw new Error('请回到原账号和数据源继续');
          return retryClone(saved.id, scope, request);
        },
      });
    if (saved.kind === 'clone' && status === 'completed')
      actions.push({ id: 'view-clone', label: '查看克隆体', run: () => undefined });
    if (saved.kind === 'favorite-import' && status !== 'completed') {
      const candidates = favoriteReceipt.safeParse(request);
      if (candidates.success && candidates.data.length)
        actions.push({
          id: 'verify',
          label: '核对收藏结果',
          run: async () => {
            const current = () => {
              const ctx = getAppContext();
              if (ctx.account !== session || !ctx.services)
                throw new Error('账号已切换，请回到原账号和数据源核对');
              return ctx.services;
            };
            const received = await current().emoji.fetchOnlineFavoriteIds();
            current();
            const present = new Set(received.map((id) => parseCustomFaceId(id).md5.toLowerCase()));
            const task = backgroundTasks.snapshot().find((item) => item.id === saved.id);
            if (!task) return;
            const checked = candidates.data.filter((item) => present.has(item.md5.toLowerCase()));
            const details = [
              ...(saved.details ?? []),
              ...candidates.data.map(
                (item) =>
                  `第 ${item.index} 项核对：${present.has(item.md5.toLowerCase()) ? 'QQ 收藏中已存在同图' : '本次未读到同图'}`,
              ),
            ];
            backgroundTasks.project(
              {
                ...task,
                updatedAt: Math.max(Date.now(), task.updatedAt + 1),
                note: `核对 ${candidates.data.length} 项，当前有 ${checked.length} 项同图。未核对备注和顺序，不会再次导入。`,
                details,
              },
              actions,
            );
            recordAccountTask(saved.id, scope)();
          },
        });
    }
    backgroundTasks.project(
      {
        ...saved,
        scope,
        status,
        note,
        statusLabel: uncertain ? '结果待核对' : abandoned ? '已中断' : saved.statusLabel,
        actions: [],
      },
      actions,
    );
  }
}

export function forgetRecordedTask(task: BackgroundTask) {
  const owner = storeFor(task.scope);
  if (!owner?.store.data.some((item) => item.id === task.id)) return;
  owner.store.replace(
    owner.store.data.filter((item) => item.id !== task.id),
    true,
  );
}
