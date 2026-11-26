import {
  localBackgroundTasks,
  rememberWindowTask,
  recordForwardTask,
} from '../../state/backgroundTasks';
import { useToast } from '../Toast.shared';
import { notificationSource } from '../../lib/notificationNavigation.shared';
import type { MfDraft, MfTarget } from './model';
import type { CompositionBinding } from './workspaceModel';

export class MergeForwardRejected extends Error {}
export class MergeForwardUnconfirmed extends Error {}

export type SendMergeForward = (
  draft: MfDraft,
  target: MfTarget,
  binding?: CompositionBinding,
  taskFeedback?: boolean,
) => Promise<undefined | boolean>;

export async function runMergeForwardTask({
  draft,
  targets,
  binding,
  send,
  isCurrent,
}: {
  draft: MfDraft;
  targets: MfTarget[];
  binding: CompositionBinding;
  send: SendMergeForward;
  isCurrent: () => boolean;
}) {
  const title = targets.length === 1 ? targets[0]!.name : `${targets.length} 个会话`;
  const scope = { uin: binding.expectedAccountUin, configId: binding.expectedAccountConfigId };
  const id = localBackgroundTasks.start({
    kind: 'forward',
    name: title,
    scope,
    display: { action: '合并转发消息', subject: title },
  });
  const sent: MfTarget[] = [];
  const rejected: MfTarget[] = [];
  const unconfirmed: MfTarget[] = [];
  const reports: string[] = [];
  let stopped = 0;
  rememberWindowTask(id);
  for (const target of targets) {
    if (!isCurrent()) {
      reports.push(`${target.name}：未发送`);
      stopped++;
      continue;
    }
    localBackgroundTasks.update(id, { statusLabel: `正在转发到「${target.name}」` });
    try {
      if ((await send(draft, target, binding, true)) === false) {
        reports.push(`${target.name}：已跳过`);
        stopped++;
      } else {
        reports.push(`${target.name}：已发送`);
        sent.push(target);
      }
    } catch (error) {
      const explicit = error instanceof MergeForwardRejected;
      (explicit ? rejected : unconfirmed).push(target);
      reports.push(
        `${target.name}：${explicit ? '未发送' : '结果待核对'} · ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    localBackgroundTasks.update(id, {
      progress: (reports.length / targets.length) * 100,
      details: reports.slice(),
    });
    rememberWindowTask(id);
  }
  const problem = rejected.length || unconfirmed.length;
  const status =
    sent.length === targets.length ? 'completed' : problem || sent.length ? 'failed' : 'cancelled';
  const label =
    status === 'completed'
      ? '转发完成'
      : sent.length
        ? '部分完成'
        : unconfirmed.length
          ? '结果待核对'
          : status === 'cancelled'
            ? '已停止转发'
            : '转发失败';
  localBackgroundTasks.finish(id, status, {
    statusLabel: label,
    needsConfirmation: unconfirmed.length > 0,
    note: `成功 ${sent.length} · 未发送 ${rejected.length + stopped} · 待核对 ${unconfirmed.length}`,
    forwardTargets: [...sent, ...unconfirmed],
    details: reports,
  });
  rememberWindowTask(id);
  void recordForwardTask(id);
  if (status === 'failed' && isCurrent())
    useToast.getState().push({
      taskId: `background:window:${id}`,
      event: 'taskFailure',
      tone: 'warning',
      title: `${label}：${title}`,
      source: notificationSource(
        { kind: 'task', id: `background:window:${id}` },
        '查看任务',
        binding,
      ),
    });
  return { sent, rejected, unconfirmed };
}
