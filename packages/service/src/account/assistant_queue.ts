import type { AiImageRef } from '@weq/agentlab';
import { JsonStore } from '../common/json_store';
import type { AssistantSendMode } from './assistant_config';

export interface AssistantSubmission {
  requestId: string;
  sessionId: string;
  text: string;
  images?: AiImageRef[];
  mode: AssistantSendMode;
}
export interface AssistantQueueItem extends AssistantSubmission {
  fingerprint?: string;
  status: 'pending' | 'supplement' | 'running' | 'done';
  messageId: string;
}
interface QueueState {
  paused: boolean;
  items: AssistantQueueItem[];
  error?: string;
}
interface QueueHost {
  busy?: (sessionId: string) => boolean;
  execute: (item: AssistantQueueItem, signal: AbortSignal, started: () => void) => Promise<void>;
  supplement: (item: AssistantQueueItem) => boolean;
  changed: (sessionId: string) => void;
}

/** 队列归宿主及会话所有；重开只恢复待办，不自行恢复执行。 */
export class AssistantQueue {
  private readonly store: JsonStore<Record<string, QueueState>>;
  private readonly active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private readonly stopped = new Set<string>();
  private readonly errors = new Map<string, string>();
  constructor(
    path: string,
    private readonly host: QueueHost,
  ) {
    this.store = new JsonStore(path, () => ({}), {
      strict: true,
      pretty: true,
      normalize: (raw) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw))
          throw new Error('助手队列格式无效');
        const restored = raw as Record<string, QueueState>;
        return Object.fromEntries(
          Object.entries(restored).map(([id, state]) => [
            id,
            {
              ...state,
              paused: true,
              items: state.items.map((item) =>
                item.status === 'running' ? { ...item, status: 'done' as const } : item,
              ),
            },
          ]),
        );
      },
    });
  }
  private state(id: string): QueueState {
    const state = this.store.data[id] ?? { paused: false, items: [] };
    return {
      ...state,
      paused: this.stopped.has(id) || state.paused,
      error: this.errors.get(id) ?? state.error,
    };
  }
  private notify(id: string) {
    try {
      this.host.changed(id);
    } catch {
      /* 订阅断开不影响队列。 */
    }
  }
  private fail(id: string, reason: unknown) {
    this.stopped.add(id);
    this.errors.set(id, reason instanceof Error ? reason.message : String(reason));
    try {
      this.save(id, this.state(id));
    } catch {
      /* 保留内存暂停状态，不自动重试写入或运行。 */
    }
    this.notify(id);
  }
  private save(id: string, state: QueueState) {
    const done = state.items.filter((item) => item.status === 'done').slice(-1024);
    this.store.replace({
      ...this.store.data,
      [id]: { ...state, items: [...done, ...state.items.filter((item) => item.status !== 'done')] },
    });
    this.notify(id);
  }
  get(id: string) {
    const state = this.state(id);
    return {
      paused: state.paused,
      running: this.active.has(id),
      error: state.error,
      items: state.items.filter((item) => item.status !== 'done').map((item) => ({ ...item })),
    };
  }
  submissionMode(sessionId: string, requestId: string) {
    return this.state(sessionId).items.find((item) => item.requestId === requestId)?.mode;
  }
  submit(input: AssistantSubmission) {
    const state = this.state(input.sessionId);
    const prior = state.items.find((item) => item.requestId === input.requestId);
    if (prior) {
      if (
        (prior.fingerprint ?? JSON.stringify([prior.text, prior.images ?? [], prior.mode])) !==
        JSON.stringify([input.text, input.images ?? [], input.mode])
      )
        throw new Error('重复请求的消息内容不一致');
      return { messageId: prior.messageId, status: prior.status };
    }
    const item: AssistantQueueItem = {
      ...structuredClone(input),
      messageId: input.requestId,
      status: 'pending',
      fingerprint: JSON.stringify([input.text, input.images ?? [], input.mode]),
    };
    const paused = state.paused && state.items.some((row) => row.status !== 'done');
    this.save(input.sessionId, {
      ...state,
      paused,
      error: undefined,
      items: [...state.items, item],
    });
    this.errors.delete(input.sessionId);
    if (!paused) this.stopped.delete(input.sessionId);
    if (this.active.has(input.sessionId) && input.mode !== 'queue') {
      const supplement: AssistantQueueItem = { ...item, status: 'supplement' };
      this.save(input.sessionId, {
        ...this.state(input.sessionId),
        items: this.state(input.sessionId).items.map((row) =>
          row.requestId === item.requestId ? supplement : row,
        ),
      });
      this.host.supplement(supplement);
    } else if (
      !this.active.has(input.sessionId) &&
      !this.host.busy?.(input.sessionId) &&
      input.mode !== 'queue'
    )
      this.runItem(item);
    else if (!paused) this.pump(input.sessionId);
    return {
      messageId: item.messageId,
      status:
        this.state(input.sessionId).items.find((row) => row.requestId === item.requestId)?.status ??
        'done',
    };
  }
  delivered(sessionId: string, requestId: string) {
    const state = this.state(sessionId);
    this.save(sessionId, {
      ...state,
      items: state.items.map((item) =>
        item.requestId === requestId ? { ...item, status: 'done' } : item,
      ),
    });
  }
  pending(sessionId: string, requestId: string) {
    return this.state(sessionId).items.some(
      (item) => item.requestId === requestId && item.status !== 'done',
    );
  }
  edit(
    sessionId: string,
    requestId: string,
    patch: { text?: string; beforeId?: string; cancel?: boolean },
  ) {
    const state = this.state(sessionId);
    const original = state.items.find((row) => row.requestId === requestId);
    if (patch.cancel && (!original || original.status === 'done')) return;
    const item = original && { ...original };
    if (!item || item.status === 'running' || item.status === 'done')
      throw new Error('这条消息已开始执行，不能再编辑');
    const items = state.items.filter((row) => row.requestId !== requestId);
    if (!patch.cancel) {
      if (patch.text !== undefined) {
        if (!patch.text.trim() && !item.images?.length) throw new Error('消息不能为空');
        item.text = patch.text;
      }
      const index = patch.beforeId
        ? items.findIndex((row) => row.requestId === patch.beforeId)
        : state.items.indexOf(original!);
      items.splice(index < 0 ? items.length : index, 0, item);
    } else items.push({ ...item, status: 'done' });
    this.save(sessionId, { ...state, items });
  }
  pause(sessionId: string) {
    this.stopped.add(sessionId);
    try {
      this.save(sessionId, { ...this.state(sessionId), paused: true });
    } catch (reason) {
      this.errors.set(sessionId, reason instanceof Error ? reason.message : String(reason));
      throw reason;
    } finally {
      this.active.get(sessionId)?.controller.abort();
    }
  }
  resume(sessionId: string) {
    const state = this.state(sessionId);
    this.save(sessionId, {
      ...state,
      items: state.items.map((item) =>
        item.status === 'running' ? { ...item, status: 'done' } : item,
      ),
      paused: false,
      error: undefined,
    });
    this.stopped.delete(sessionId);
    this.errors.delete(sessionId);
    this.kick(sessionId);
  }
  recover(sessionId: string, run: (signal: AbortSignal) => Promise<void>) {
    if (this.active.has(sessionId)) throw new Error('这段会话已有正在生成的回答');
    const state = this.state(sessionId);
    this.save(sessionId, {
      ...state,
      items: state.items.map((item) =>
        item.status === 'running' ? { ...item, status: 'done' } : item,
      ),
      paused: false,
      error: undefined,
    });
    this.stopped.delete(sessionId);
    this.errors.delete(sessionId);
    this.launch(sessionId, run);
  }
  private pump(sessionId: string) {
    if (this.active.has(sessionId) || this.host.busy?.(sessionId) || this.state(sessionId).paused)
      return;
    const item = this.state(sessionId).items.find((row) => row.status !== 'done');
    if (!item) return;
    this.runItem(item);
  }
  kick(sessionId: string) {
    try {
      this.pump(sessionId);
    } catch (reason) {
      this.fail(sessionId, reason);
    }
  }
  private runItem(item: AssistantQueueItem) {
    const sessionId = item.sessionId;
    const running: AssistantQueueItem = { ...item, status: 'running' };
    this.save(sessionId, {
      ...this.state(sessionId),
      items: this.state(sessionId).items.map((row) =>
        row.requestId === item.requestId ? running : row,
      ),
    });
    this.launch(sessionId, async (signal) => {
      let started = false;
      try {
        await this.host.execute(running, signal, () => {
          started = true;
        });
      } finally {
        if (started) this.delivered(sessionId, item.requestId);
        else
          this.save(sessionId, {
            ...this.state(sessionId),
            items: this.state(sessionId).items.map((row) =>
              row.requestId === item.requestId ? { ...row, status: 'pending' } : row,
            ),
          });
      }
    });
  }
  private launch(sessionId: string, run: (signal: AbortSignal) => Promise<void>) {
    const controller = new AbortController();
    const done = Promise.resolve()
      .then(() => run(controller.signal))
      .catch((reason) => {
        this.fail(sessionId, reason);
      })
      .finally(() => {
        this.active.delete(sessionId);
        if (controller.signal.aborted) {
          this.stopped.add(sessionId);
          try {
            this.save(sessionId, this.state(sessionId));
          } catch (reason) {
            this.fail(sessionId, reason);
          }
        } else this.kick(sessionId);
        this.notify(sessionId);
      });
    this.active.set(sessionId, { controller, done });
    this.notify(sessionId);
  }
  async clear(sessionId: string) {
    this.pause(sessionId);
    await this.active.get(sessionId)?.done;
    const next = { ...this.store.data };
    delete next[sessionId];
    this.store.replace(next);
    this.stopped.delete(sessionId);
    this.errors.delete(sessionId);
    this.notify(sessionId);
  }
}
