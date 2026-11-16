export type BackgroundTaskKind =
  | 'analysis'
  | 'calendar'
  | 'contacts'
  | 'model'
  | 'update'
  | 'database'
  | 'backup'
  | 'favorite-import'
  | 'forward'
  | 'album-upload'
  | 'resource';

export type BackgroundTaskStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'paused';

export interface BackgroundTaskScope {
  uin: string;
  configId?: string;
}

export interface BackgroundTask {
  id: string;
  kind: BackgroundTaskKind;
  name: string;
  scope?: BackgroundTaskScope;
  destination?: 'db-checkup' | 'enhancement-packs';
  status: BackgroundTaskStatus;
  statusLabel?: string;
  progress?: number;
  note?: string;
  details?: string[];
  logs?: BackgroundTaskLogLine[];
  subtasks?: Array<{ label: string; done: number; total: number; failed: number }>;
  download?: { url: string; name: string };
  reportId?: string;
  actions: { id: string; label: string }[];
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
}

export function backgroundTaskVisible(task: BackgroundTask, scope: BackgroundTaskScope | null) {
  return (
    !task.scope ||
    (task.scope.uin === scope?.uin &&
      (!task.scope.configId || task.scope.configId === scope.configId))
  );
}

export interface BackgroundTaskLogLine {
  ts: number;
  seq: number;
  stage: string;
  level: 'info' | 'warn' | 'error';
  text: string;
}

type TaskPatch = Partial<
  Pick<
    BackgroundTask,
    'progress' | 'note' | 'details' | 'statusLabel' | 'download' | 'subtasks' | 'logs' | 'reportId'
  >
>;
export type BackgroundTaskAction = {
  id: string;
  label: string;
  run: () => unknown;
};

/** 仅保存本次进程的轻量回执；任务记录不拥有业务文件，也不提供隐式重试。 */
export class BackgroundTaskRegistry {
  private tasks: BackgroundTask[] = [];
  private listeners = new Set<() => void>();
  private actions = new Map<string, BackgroundTaskAction[]>();
  private autoLogs = new Set<string>();
  private checkpoints = new Map<string, { progress?: number; at: number }>();

  constructor(private readonly historyLimit = 100) {}

  snapshot = (): readonly BackgroundTask[] => this.tasks;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  start(input: Pick<BackgroundTask, 'name' | 'kind' | 'scope' | 'destination'> & TaskPatch) {
    const now = Date.now();
    const task: BackgroundTask = {
      ...input,
      id: globalThis.crypto.randomUUID(),
      status: 'running',
      actions: [],
      startedAt: now,
      updatedAt: now,
    };
    if (!input.logs) {
      this.autoLogs.add(task.id);
      task.logs = [];
      this.appendLog(task, `开始：${task.name}${task.note ? ` · ${task.note}` : ''}`);
    }
    this.tasks = [...this.tasks, task];
    this.emit();
    return task.id;
  }

  update(id: string, patch: TaskPatch) {
    // 已结束记录不能被迟到的进度事件重新改写。
    this.change(id, (task) =>
      task.status === 'running' ? this.record(task, { ...task, ...patch }, patch.logs) : task,
    );
  }

  finish(id: string, status: Exclude<BackgroundTaskStatus, 'running'>, patch: TaskPatch = {}) {
    this.change(id, (task) =>
      task.status === 'running' || (task.status === 'paused' && status === 'cancelled')
        ? this.record(
            task,
            {
              ...task,
              progress: status === 'completed' ? 100 : task.progress,
              statusLabel: undefined,
              ...patch,
              status,
              finishedAt: Date.now(),
            },
            patch.logs,
          )
        : task,
    );
    this.prune();
  }

  setActions(id: string, actions: BackgroundTaskAction[]) {
    if (!this.tasks.some((task) => task.id === id)) return;
    this.actions.set(id, actions);
    this.change(id, (task) => ({
      ...task,
      actions: actions.map(({ id, label }) => ({ id, label })),
    }));
  }

  /** 业务自身持久化的任务恢复原身份和时间，避免重启后重复提醒已读结果。 */
  project(task: BackgroundTask, actions: BackgroundTaskAction[]) {
    this.autoLogs.delete(task.id);
    this.checkpoints.delete(task.id);
    this.actions.set(task.id, actions);
    const next = { ...task, actions: actions.map(({ id, label }) => ({ id, label })) };
    const index = this.tasks.findIndex((entry) => entry.id === task.id);
    this.tasks =
      index < 0
        ? [...this.tasks, next]
        : this.tasks.map((entry, at) => (at === index ? next : entry));
    this.prune();
    this.emit();
  }

  resume(id: string) {
    this.change(id, (task) =>
      task.status === 'running'
        ? task
        : this.record(task, {
            ...task,
            status: 'running',
            statusLabel: undefined,
            finishedAt: undefined,
          }),
    );
  }

  async act(id: string, actionId: string) {
    const action = this.actions.get(id)?.find((item) => item.id === actionId);
    if (!action) throw new Error('此任务操作已失效，请刷新任务列表');
    await action.run();
  }

  remove(id: string, expected?: BackgroundTask) {
    const task = this.tasks.find((item) => item.id === id);
    if (!task || task.status === 'running' || (expected && task !== expected)) return false;
    this.tasks = this.tasks.filter((item) => item !== task);
    this.actions.delete(id);
    this.autoLogs.delete(id);
    this.checkpoints.delete(id);
    this.emit();
    return true;
  }

  private change(id: string, update: (task: BackgroundTask) => BackgroundTask) {
    let changed = false;
    const tasks = this.tasks.map((task) => {
      if (task.id !== id) return task;
      const next = update(task);
      if (next === task) return task;
      changed = true;
      return { ...next, updatedAt: Math.max(Date.now(), task.updatedAt + 1) };
    });
    if (changed) {
      this.tasks = tasks;
      this.emit();
    }
  }

  private record(
    previous: BackgroundTask,
    next: BackgroundTask,
    explicitLogs?: BackgroundTaskLogLine[],
  ): BackgroundTask {
    if (explicitLogs) {
      this.autoLogs.delete(next.id);
      this.checkpoints.delete(next.id);
    }
    if (!this.autoLogs.has(next.id)) return next;
    const statusChanged = previous.status !== next.status;
    const stageChanged = previous.statusLabel !== next.statusLabel;
    const checkpoint = this.checkpoints.get(next.id);
    const progress = Number.isFinite(next.progress) ? next.progress : undefined;
    // 下载字节等高频状态只采样检查点，阶段切换及结束结果始终记录。
    const sampled =
      (next.note !== previous.note || next.progress !== previous.progress) &&
      (!checkpoint ||
        (Boolean(next.note) && !previous.note) ||
        (progress !== undefined &&
          Math.floor(progress / 10) !== Math.floor((checkpoint.progress ?? 0) / 10)) ||
        Date.now() - checkpoint.at >= 15_000);
    if (!statusChanged && !stageChanged && !sampled) return next;
    const statusText = {
      running: '继续执行',
      paused: '已暂停',
      completed: '已完成',
      failed: '失败',
      cancelled: '已取消',
    }[next.status];
    const text = [
      statusChanged ? (next.statusLabel ?? statusText) : next.statusLabel,
      progress !== undefined ? `${Math.round(Math.max(0, Math.min(100, progress)))}%` : '',
      next.note,
    ]
      .filter(Boolean)
      .join(' · ');
    if (text) this.appendLog(next, text);
    return next;
  }

  private appendLog(task: BackgroundTask, text: string) {
    const now = Date.now();
    const logs = task.logs ?? [];
    task.logs = [
      ...logs.slice(-299),
      {
        ts: now,
        seq: (logs.at(-1)?.seq ?? 0) + 1,
        stage: 'task',
        level: task.status === 'failed' ? 'error' : task.status === 'paused' ? 'warn' : 'info',
        text: text.slice(0, 4000),
      } satisfies BackgroundTaskLogLine,
    ];
    this.checkpoints.set(task.id, { progress: task.progress, at: now });
  }

  private prune() {
    const ended = this.tasks.filter(
      (task) => task.status !== 'running' && task.status !== 'paused',
    );
    for (const task of ended.slice(0, Math.max(0, ended.length - this.historyLimit)))
      this.remove(task.id);
  }

  private emit() {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // 展示订阅失败不能阻断业务任务或其他订阅者。
      }
    }
  }
}
