/**
 * 克隆任务的模块级 store（脱离 AgentLabView 组件生命周期）。
 *
 * 为什么不放组件里：AgentLabView 在切到别的视图时会卸载，若构建态/进度订阅挂在组件上，
 * 切出去再回来任务就丢了（bug2）。这里把任务列表、构建调用、进度订阅都抬到模块级单例，
 * 用 useSyncExternalStore 让组件订阅。构建用 vanilla client 发起，promise 生命周期与组件无关；
 * 进度订阅按「是否还有 running 任务」懒启/懒停。
 *
 * 注意：整页刷新（reload）会重置本 store，那是另一回事——本修复只针对应用内视图切换。
 */

import { client } from '../../trpc/client';
import type { StartCloneArgs, CloneMode } from './NewCloneModal';

export type CloneTaskStatus = 'running' | 'done' | 'error';

export interface CloneTask {
  personaId: string;
  /** 展示名（克隆体名称或好友昵称）。 */
  name: string;
  /** 好友 uin，用于头像。 */
  uin: string;
  mode: CloneMode;
  phase: string;
  percent: number;
  status: CloneTaskStatus;
  error?: string;
}

let tasks: CloneTask[] = [];
const listeners = new Set<() => void>();
let progressUnsub: (() => void) | null = null;

function setTasks(next: CloneTask[]): void {
  tasks = next;
  for (const listener of listeners) listener();
}

/** useSyncExternalStore 订阅入口。 */
export function subscribeCloneTasks(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** useSyncExternalStore 快照（引用稳定，只在 setTasks 时变）。 */
export function getCloneTasks(): CloneTask[] {
  return tasks;
}

/** 仅在有 running 任务时保持一条进度订阅；全部收尾后断开。 */
function ensureProgressSub(): void {
  if (progressUnsub) return;
  const sub = client.account.onAgentLabBuildProgress.subscribe(undefined, {
    onData: (p: { personaId: string; phase: string; percent: number; error?: string }) => {
      if (p.error) return;
      setTasks(
        tasks.map((t) =>
          t.personaId === p.personaId && t.status === 'running'
            ? { ...t, phase: p.phase, percent: p.percent }
            : t,
        ),
      );
    },
    onError: () => {
      /* 订阅断开时静默——任务收尾会重建 */
    },
  });
  progressUnsub = () => sub.unsubscribe();
}

function maybeStopProgressSub(): void {
  if (progressUnsub && !tasks.some((t) => t.status === 'running')) {
    progressUnsub();
    progressUnsub = null;
  }
}

/**
 * 发起一次克隆构建：登记 running 任务 → 后台跑构建（promise 不绑定组件）→ 收尾改 done/error。
 * 同一 personaId 再发起会替换旧任务。
 */
export async function startCloneTask(args: StartCloneArgs): Promise<void> {
  const { params, meta } = args;
  setTasks([
    ...tasks.filter((t) => t.personaId !== params.personaId),
    {
      personaId: params.personaId,
      name: meta.name,
      uin: meta.uin,
      mode: meta.mode,
      phase: '准备中',
      percent: 1,
      status: 'running',
    },
  ]);
  ensureProgressSub();
  try {
    await client.account.buildAgentLabFromC2c.mutate(params);
    setTasks(
      tasks.map((t) =>
        t.personaId === params.personaId ? { ...t, status: 'done', phase: '完成', percent: 100 } : t,
      ),
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    setTasks(tasks.map((t) => (t.personaId === params.personaId ? { ...t, status: 'error', error: msg } : t)));
  } finally {
    maybeStopProgressSub();
  }
}

/** 从任务列表移除（done/error 后用户点关闭）。 */
export function dismissCloneTask(personaId: string): void {
  setTasks(tasks.filter((t) => t.personaId !== personaId));
  maybeStopProgressSub();
}
