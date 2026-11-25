import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import type { AccountSession } from '@weq/account';

const current = new AsyncLocalStorage<AccountRuntime>();
const accountLifecycle = new EventEmitter();

export function onAccountClosing(listener: (session: AccountSession | null) => void): void {
  accountLifecycle.on('closing', listener);
}

export function emitAccountClosing(session: AccountSession | null): void {
  accountLifecycle.emit('closing', session);
}

/** 桌面窗口与其后台工作共用一个账号运行作用域。独立 Web 使用默认作用域。 */
export class AccountRuntime {
  run<T>(operation: () => T): T {
    return current.run(this, operation);
  }

  bind<T extends unknown[], R>(operation: (...args: T) => R): (...args: T) => R {
    return (...args) => this.run(() => operation(...args));
  }
}

export const primaryAccountRuntime = new AccountRuntime();

export function currentAccountRuntime(): AccountRuntime {
  return current.getStore() ?? primaryAccountRuntime;
}

export function accountRuntimeState<T extends object>(create: () => T): () => T {
  const states = new WeakMap<AccountRuntime, T>();
  return () => {
    const runtime = currentAccountRuntime();
    const existing = states.get(runtime);
    if (existing) return existing;
    const state = create();
    states.set(runtime, state);
    return state;
  };
}

export function accountRuntimeEvents(maxListeners = EventEmitter.defaultMaxListeners) {
  const emitter = accountRuntimeState(() => new EventEmitter().setMaxListeners(maxListeners));
  return {
    on(...args: Parameters<EventEmitter['on']>) {
      emitter().on(...args);
    },
    off(...args: Parameters<EventEmitter['off']>) {
      emitter().off(...args);
    },
    emit(...args: Parameters<EventEmitter['emit']>) {
      return emitter().emit(...args);
    },
    listenerCount(...args: Parameters<EventEmitter['listenerCount']>) {
      return emitter().listenerCount(...args);
    },
  };
}
