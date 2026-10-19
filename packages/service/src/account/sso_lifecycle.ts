/** Registration and cleanup share one queue for every native binding/PID. */

export interface SsoWorkState {
  queue: Promise<void>;
  owner?: object;
}

const work = new WeakMap<object, Map<number, SsoWorkState>>();

export function ssoWorkState(binding: object, pid: number): SsoWorkState {
  let entries = work.get(binding);
  if (!entries) {
    entries = new Map();
    work.set(binding, entries);
  }
  let state = entries.get(pid);
  if (!state) {
    state = { queue: Promise.resolve() };
    entries.set(pid, state);
  }
  return state;
}

export function queueSsoWork<T>(binding: object, pid: number, task: () => Promise<T>): Promise<T> {
  const state = ssoWorkState(binding, pid);
  const next = state.queue.then(task);
  state.queue = next.then(
    () => {},
    () => {},
  );
  return next;
}
