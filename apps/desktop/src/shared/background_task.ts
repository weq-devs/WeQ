export type BackgroundTaskKind =
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
  status: BackgroundTaskStatus;
  statusLabel?: string;
  progress?: number;
  note?: string;
  details?: string[];
  download?: { url: string; name: string };
  actions: { id: string; label: string }[];
  startedAt: number;
  updatedAt: number;
}

export function backgroundTaskVisible(task: BackgroundTask, scope: BackgroundTaskScope | null) {
  return (
    !task.scope ||
    (task.scope.uin === scope?.uin &&
      (!task.scope.configId || task.scope.configId === scope.configId))
  );
}

type TaskPatch = Partial<
  Pick<BackgroundTask, 'progress' | 'note' | 'details' | 'statusLabel' | 'download'>
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

  constructor(private readonly historyLimit = 100) {}

  snapshot = (): readonly BackgroundTask[] => this.tasks;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  start(input: Pick<BackgroundTask, 'name' | 'kind' | 'scope'> & TaskPatch) {
    const now = Date.now();
    const task: BackgroundTask = {
      ...input,
      id: globalThis.crypto.randomUUID(),
      status: 'running',
      actions: [],
      startedAt: now,
      updatedAt: now,
    };
    this.tasks = [...this.tasks, task];
    this.emit();
    return task.id;
  }

  update(id: string, patch: TaskPatch) {
    // 已结束记录不能被迟到的进度事件重新改写。
    this.change(id, (task) => (task.status === 'running' ? { ...task, ...patch } : task));
  }

  finish(id: string, status: Exclude<BackgroundTaskStatus, 'running'>, patch: TaskPatch = {}) {
    this.change(id, (task) =>
      task.status === 'running'
        ? {
            ...task,
            progress: status === 'completed' ? 100 : task.progress,
            statusLabel: undefined,
            ...patch,
            status,
          }
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

  private prune() {
    const ended = this.tasks.filter((task) => task.status !== 'running');
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
