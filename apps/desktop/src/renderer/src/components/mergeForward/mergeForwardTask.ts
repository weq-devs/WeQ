import {
  localBackgroundTasks,
  rememberWindowTask,
  recordForwardTask,
} from '../../state/backgroundTasks';
import {
  canContinueForward,
  deleteForwardPlan,
  forwardResumeAction,
  runNewForwardPlan,
  writeForwardPlan,
  type MergeForwardPlan,
} from '../../lib/forwardContinuation';
import { useToast } from '../Toast.shared';
import { notificationSource } from '../../lib/notificationNavigation.shared';
import type { ForwardedConversationTarget, MfDraft, MfTarget } from './model';
import type { CompositionBinding } from './workspaceModel';

export class MergeForwardRejected extends Error {}
export class MergeForwardUnconfirmed extends Error {}

export type SendMergeForward = (
  draft: MfDraft,
  target: MfTarget,
  binding?: CompositionBinding,
  taskFeedback?: boolean,
) => Promise<undefined | boolean | { seq?: string }>;

export async function runMergeForwardTask({
  draft,
  targets,
  binding,
  send,
  isCurrent,
  resume,
}: {
  draft: MfDraft;
  targets: MfTarget[];
  binding: CompositionBinding;
  send: SendMergeForward;
  isCurrent: () => boolean;
  resume?: { id: string; plan: MergeForwardPlan };
}) {
  const title = targets.length === 1 ? targets[0]!.name : `${targets.length} 个会话`;
  const scope = { uin: binding.expectedAccountUin, configId: binding.expectedAccountConfigId };
  const id =
    resume?.id ??
    localBackgroundTasks.start({
      kind: 'forward',
      name: title,
      scope,
      display: { action: '合并转发消息', subject: title },
    });
  const sent: ForwardedConversationTarget[] = [];
  const rejected: MfTarget[] = [];
  const unconfirmed: MfTarget[] = [];
  const reports: string[] = [];
  let plan = resume?.plan;
  if (!plan && navigator.locks) {
    try {
      const candidate: MergeForwardPlan = {
        version: 1,
        kind: 'merged',
        scope,
        draft,
        entries: targets.map(() => ({ state: 'pending' })),
        targets: targets.map(({ id, kind, conv, name }) => ({
          id,
          kind,
          conv,
          name,
          avatarUrl: null,
        })),
      };
      writeForwardPlan(id, candidate);
      plan = candidate;
    } catch {
      // 无法保留草稿时仍可完成本次转发。
    }
  }
  let stopped = 0;
  localBackgroundTasks.resume(id);
  localBackgroundTasks.setActions(id, []);
  rememberWindowTask(id);
  const execute = async () => {
    for (const [index, target] of targets.entries()) {
      const entry = plan?.entries[index];
      if (entry?.state === 'sent') {
        sent.push(entry.targetSeq ? { ...target, seq: entry.targetSeq } : target);
        reports.push(`${target.name}：已发送`);
        continue;
      }
      if (entry?.state === 'submitting' || entry?.state === 'unconfirmed') {
        unconfirmed.push(target);
        reports.push(`${target.name}：结果待核对，继续时已跳过`);
        continue;
      }
      if (entry?.state === 'skipped' || !isCurrent()) {
        reports.push(`${target.name}：未发送`);
        stopped++;
        continue;
      }
      if (plan && entry) {
        entry.state = 'submitting';
        try {
          writeForwardPlan(id, plan);
        } catch {
          entry.state = 'pending';
          reports.push('续作记录暂时无法保存，已停止后续转发。');
          break;
        }
      }
      localBackgroundTasks.update(id, { statusLabel: `正在转发到「${target.name}」` });
      try {
        const result = await send(draft, target, binding, true);
        if (result === false) {
          if (entry) entry.state = 'skipped';
          reports.push(`${target.name}：已跳过`);
          stopped++;
        } else {
          const seq = typeof result === 'object' ? result.seq : undefined;
          if (entry) {
            entry.state = 'sent';
            entry.targetSeq = seq;
          }
          reports.push(`${target.name}：已发送`);
          sent.push(seq ? { ...target, seq } : target);
        }
      } catch (error) {
        const explicit = error instanceof MergeForwardRejected;
        if (entry) entry.state = explicit ? 'pending' : 'unconfirmed';
        (explicit ? rejected : unconfirmed).push(target);
        reports.push(
          `${target.name}：${explicit ? '未发送' : '结果待核对'} · ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      localBackgroundTasks.update(id, {
        progress: ((index + 1) / targets.length) * 100,
        details: reports.slice(),
      });
      rememberWindowTask(id);
      if (plan) {
        try {
          writeForwardPlan(id, plan);
        } catch {
          reports.push('续作记录暂时无法保存，已停止后续转发。');
          break;
        }
      }
    }
  };
  await (plan && !resume ? runNewForwardPlan(id, execute) : execute());
  const canContinue = canContinueForward(plan);
  const problem = rejected.length || unconfirmed.length;
  const status = canContinue
    ? 'paused'
    : sent.length === targets.length
      ? 'completed'
      : problem || sent.length
        ? 'failed'
        : 'cancelled';
  const label =
    status === 'paused'
      ? '等待继续转发'
      : status === 'completed'
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
  if (canContinue) localBackgroundTasks.setActions(id, [forwardResumeAction(id, scope, 'merged')]);
  rememberWindowTask(id);
  if (!canContinue) {
    deleteForwardPlan(id);
    void recordForwardTask(id);
  }
  if ((status === 'failed' || (canContinue && problem)) && isCurrent())
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
  return { sent, rejected: canContinue ? [] : rejected, unconfirmed };
}
