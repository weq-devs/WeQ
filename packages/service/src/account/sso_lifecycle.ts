/** Registration and cleanup share one queue for every native binding/PID. */
import type { SessionMaterial } from '@weq/native';

export interface ManagedRuntimeMaterial {
  identity: { uin: string; uid: string; guid: string };
  material: SessionMaterial;
}
export interface SsoWorkState {
  queue: Promise<void>;
  owner?: object;
  managedRuntime?: { read(): ManagedRuntimeMaterial | null };
}

/** 由真实进程监督器声明，直到该进程实际退出；租约未就绪也不得回退到外部扫描。 */
export function claimManagedQQProcess(
  binding: object,
  pid: number,
  read: () => ManagedRuntimeMaterial | null,
): () => void {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('托管进程 PID 无效');
  const state = ssoWorkState(binding, pid),
    marker = { read };
  if (state.managedRuntime) throw new Error('托管进程已被登记');
  state.managedRuntime = marker;
  return () => {
    if (state.managedRuntime === marker) delete state.managedRuntime;
  };
}

export async function readManagedRuntimeMaterial(
  binding: object,
  pid: number,
  uin: string,
  verify: () => Promise<boolean>,
  signal?: AbortSignal,
): Promise<ManagedRuntimeMaterial | null> {
  const state = ssoWorkState(binding, pid),
    marker = state.managedRuntime;
  if (!marker) return null;
  const before = marker.read();
  if (signal?.aborted || !before || before.identity.uin !== uin)
    throw new Error('托管 QQ 会话尚未就绪或账号不匹配');
  const present = await verify();
  const after = marker.read();
  if (
    !present ||
    signal?.aborted ||
    state.managedRuntime !== marker ||
    !after ||
    after.identity.uin !== uin ||
    after.identity.uid !== before.identity.uid ||
    after.identity.guid !== before.identity.guid
  )
    throw new Error('托管 QQ 会话已失效');
  return after;
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
