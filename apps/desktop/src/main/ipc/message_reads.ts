import { withDatabasePriority, type DatabasePriority } from '@weq/db';
import type { MessageReadWindow } from '../../shared/message_read';

interface WindowState {
  generation: number;
  controller: AbortController;
  pending: number;
  touchedAt: number;
}

/** 每个渲染窗口独立换代，取消记录也保留，处理 HTTP 取消先于查询到达的情况。 */
export class MessageReadWindows {
  private readonly windows = new Map<string, WindowState>();

  private state(window: MessageReadWindow): WindowState {
    const now = Date.now();
    for (const [owner, state] of this.windows) {
      if (!state.pending && now - state.touchedAt > 30 * 60_000) this.windows.delete(owner);
    }
    let state = this.windows.get(window.owner);
    if (state && window.generation < state.generation)
      throw new DOMException('消息窗口已切换', 'AbortError');
    if (!state || window.generation > state.generation) {
      if (!state && this.windows.size >= 256) throw new Error('消息读取窗口过多，请稍后重试');
      state?.controller.abort();
      state = {
        generation: window.generation,
        controller: new AbortController(),
        pending: 0,
        touchedAt: now,
      };
      this.windows.set(window.owner, state);
    }
    state.touchedAt = now;
    return state;
  }

  cancel(window: MessageReadWindow): void {
    const previous = this.windows.get(window.owner);
    if (previous && previous.generation > window.generation) return;
    this.state(window).controller.abort();
  }

  async run<T>(
    window: MessageReadWindow,
    read: () => Promise<T>,
    priority: DatabasePriority = 'interactive',
  ): Promise<T> {
    const state = this.state(window);
    const signal = state.controller.signal;
    signal.throwIfAborted();
    state.pending++;
    try {
      const result = await withDatabasePriority(priority, read, signal);
      signal.throwIfAborted();
      return result;
    } finally {
      state.pending--;
      state.touchedAt = Date.now();
    }
  }
}
