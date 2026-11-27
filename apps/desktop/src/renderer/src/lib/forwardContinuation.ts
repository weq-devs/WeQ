import type { BackgroundTaskScope } from '../../../shared/background_task';
import type { MfDraft, MfTarget } from '../components/mergeForward/model';
import type { Message } from '../im-template/template/types';
import type { ForwardOptions } from './sequentialForward';
import type { ForwardChatKind, ForwardReceipt } from './sequentialForwardReply';

type Entry = {
  state: 'pending' | 'submitting' | 'sent' | 'unconfirmed' | 'skipped';
  receipt?: ForwardReceipt;
  targetSeq?: string;
};
export class ForwardNotSubmitted extends Error {}

export interface SequentialForwardPlan {
  version: 1;
  kind: 'sequential';
  scope: BackgroundTaskScope;
  target: MfTarget;
  messages: Message[];
  entries: Entry[];
  options: ForwardOptions;
  sourceKind?: ForwardChatKind;
  includeExcerpt: boolean;
}
export interface MergeForwardPlan {
  version: 1;
  kind: 'merged';
  scope: BackgroundTaskScope;
  draft: MfDraft;
  targets: MfTarget[];
  entries: Entry[];
}
export type ForwardPlan = SequentialForwardPlan | MergeForwardPlan;

const key = (id: string) => `weq-forward-continuation-v1:${id}`;
const scopeKey = ({ uin, configId }: BackgroundTaskScope) => JSON.stringify([uin, configId]);
const handlers = new Map<string, (id: string, plan: ForwardPlan) => Promise<void>>();

export function writeForwardPlan(id: string, plan: ForwardPlan) {
  localStorage.setItem(key(id), JSON.stringify(plan));
}

export function readForwardPlan(
  id: string,
  scope: BackgroundTaskScope,
  storage: Pick<Storage, 'getItem'> = localStorage,
): ForwardPlan | undefined {
  try {
    const plan = JSON.parse(storage.getItem(key(id)) ?? 'null') as ForwardPlan | null;
    if (
      plan?.version === 1 &&
      scopeKey(plan.scope) === scopeKey(scope) &&
      ((plan.kind === 'sequential' && plan.messages.length === plan.entries.length) ||
        (plan.kind === 'merged' && plan.targets.length === plan.entries.length)) &&
      plan.entries.every(({ state }) =>
        ['pending', 'submitting', 'sent', 'unconfirmed', 'skipped'].includes(state),
      )
    )
      return plan;
  } catch {
    /* 单条旧计划不可用时仍可查看任务回执。 */
  }
}

export function deleteForwardPlan(id: string) {
  try {
    localStorage.removeItem(key(id));
  } catch {
    /* 下次仍只读取已经记为未提交的条目。 */
  }
}

export function canContinueForward(plan?: ForwardPlan) {
  return Boolean(plan?.entries.some(({ state }) => state === 'pending'));
}

export function registerForwardResumeHandler(
  scope: BackgroundTaskScope,
  run: (id: string, plan: ForwardPlan) => Promise<void>,
) {
  const key = scopeKey(scope);
  handlers.set(key, run);
  return () => {
    if (handlers.get(key) === run) handlers.delete(key);
  };
}

export function forwardResumeAction(
  id: string,
  scope: BackgroundTaskScope,
  kind: ForwardPlan['kind'] = 'sequential',
) {
  return {
    id: 'continue',
    label: kind === 'merged' ? '继续转发剩余会话' : '继续未发送消息',
    run: async () => {
      if (!navigator.locks) throw new Error('当前窗口不支持安全接续，请在原设备上继续。');
      const started = Promise.withResolvers<void>();
      void navigator.locks
        .request(key(id), { ifAvailable: true }, async (lock) => {
          if (!lock) throw new Error('此任务正在另一窗口执行。');
          const plan = readForwardPlan(id, scope);
          const run = handlers.get(scopeKey(scope));
          if (!run) throw new Error('请回到原账号和数据源继续。');
          if (!plan || !canContinueForward(plan)) throw new Error('此任务已没有可继续的消息。');
          const done = run(id, plan);
          started.resolve();
          await done;
        })
        .catch(started.reject);
      await started.promise;
    },
  };
}

export function runNewForwardPlan<T>(id: string, run: () => Promise<T>) {
  return navigator.locks ? navigator.locks.request(key(id), run) : run();
}
