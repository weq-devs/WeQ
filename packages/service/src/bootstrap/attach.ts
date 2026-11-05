/**
 * `AttachHook` —— 把「一个正在跑的 QQ pid」变成「拿到该会话物料」的那条缝。
 *
 * 为什么是缝而不是一次调用：平台差异只在**提权方式**上 ——
 *   - **win32**：本进程有权限，直接读目标内存；
 *   - **linux/macOS**：读别的进程内存和 ptrace 本来就是同一件事（Linux 要 root
 *     或 CAP_SYS_PTRACE 且 yama 放行；macOS 要 root 且目标没开强化运行时），
 *     所以默认走 sudo 提权的子进程（见桌面端的 `attach_elevation`）；只有当宿主
 *     本来就能 attach 时，才进程内直接读、跳过密码框。
 *
 * 真正的读取由原生 `scanSessionMaterial(pid)` 一次做完：运行时 RTTI 自举，
 * 产出该会话的 a2 / d2 / d2key（设备 guid 不在这里 —— 它从 QQ 数据根路径
 * 离线算，见 `readDeviceGuid`）。
 *
 * 调用方（`AccountMonitorService`、bootstrap 路由）只依赖这个接口，因此不带任何
 * 按平台的分支。幂等由 hook 自己负责：`ensure` 复用同一账号与 pid 的完整物料；`reset`
 * 忘掉某个 pid，好让失败后的下一次 `ensure` 重新读一遍（QQ 重启 / 换账号都会让
 * 上一轮的物料失效）。
 *
 * 所有会触发 attach 的调用方必须先检查宿主当前来源的有效完整功能状态（例如
 * app_context 的 `requireAttachEnabled`）；自动偏好关闭时，显式手动请求仍可放行。
 * 不能直接用 `userConfig.getSettings().autoAttachQq` 代替来源/会话门控。
 * 独立入口：登录时的数据库密钥提取（bootstrap 的
 * `fetchKeyFromInstance` / `prepareInstanceAttach`）—— 那是打开账号的前提。
 */

import type { NtHelperBinding, SessionMaterial } from '@weq/native';
import { getLogger } from '../common/logger';
import { isCompleteSessionMaterial } from '../common/session_material';

/**
 * 读内存时能提供给原生侧的账号标识。
 *
 * 两者都不参与 a2/d2/d2key 的读取，只用来让 `SecToken` 的候选收敛：
 * Windows 的真 token 记录附近带 uid，macOS/Linux 带 uin。调用方手上有什么
 * 就给什么 —— 缺一个仍能工作，只是少一条消歧证据。
 */
export interface AttachIdentity {
  uin?: string | null;
  uid?: string | null;
}

export interface AttachHook {
  /**
   * 读 `pid` 的内存并返回该会话物料。平台差异（是否提权）由实现自己决定。
   * 幂等 —— 同一账号和 pid 已读到完整凭据时直接返回缓存，部分结果允许重读。
   * 缓存以 `uin` 为归属键（没有 uin 时退回 uid）。
   */
  attach(pid: number, identity: AttachIdentity, signal?: AbortSignal): Promise<SessionMaterial>;
  /**
   * 同 {@link attach}（读内存没有独立的「等待就绪」半步）。
   */
  ensure(pid: number, identity: AttachIdentity, signal?: AbortSignal): Promise<SessionMaterial>;
  /** 忘掉 `pid` 的缓存物料，下一次调用重新读。 */
  reset(pid: number): void;
}

/**
 * The user's answer to the linux attach-hint dialog (shown once, when the
 * first unprivileged attach is refused by the kernel):
 *   - `retry`     — user closed yama ptrace protection; try in-process again
 *   - `no-remind` — persist the suppression, then escalate via sudo
 *   - `skip`      — escalate via sudo this time, without remembering
 *   - `cancel`    — close the dialog; do not escalate (attach fails)
 */
export type AttachHintChoice = 'retry' | 'no-remind' | 'skip' | 'cancel';

/** The hint dialog's answer: the choice plus the password typed in it. */
export interface AttachHintAnswer {
  choice: AttachHintChoice;
  /** 提权路径用；用户没输入密码时为空字符串。 */
  password: string;
}

/**
 * The default hook: read the target process's memory in-process. Correct for
 * win32 (and used as the fallback whenever no platform-specific hook is
 * supplied). Not for linux/macOS — see {@link AttachHook}.
 */
/**
 * 缓存归属键：优先 uin（账号的主标识），没有时退回 uid。
 *
 * 两者都没有时会退化成空串 —— 调用方本来就拿不到账号身份，缓存只能按 pid
 * 认；这种情况只出现在诊断脚本里，不影响正常链路。
 */
function attachOwner(identity: AttachIdentity): string {
  return identity.uin || identity.uid || '';
}

/** Account-scoped caching with exclusive reads per process and reset fencing. */
export function createCachedAttachHook(
  read: (pid: number, identity: AttachIdentity, signal: AbortSignal) => Promise<SessionMaterial>,
): AttachHook {
  const cached = new Map<
    number,
    { owner: string; generation: number; material: SessionMaterial }
  >();
  const generations = new Map<number, number>();
  type ReadEntry = {
    generation: number;
    task: Promise<SessionMaterial>;
    controller: AbortController;
    users: number;
  };
  const inflight = new Map<string, ReadEntry>();
  const controllers = new Map<number, Set<AbortController>>();
  const queues = new Map<number, Promise<void>>();
  const reset = (pid: number): void => {
    cached.delete(pid);
    generations.set(pid, (generations.get(pid) ?? 0) + 1);
    for (const controller of controllers.get(pid) ?? [])
      controller.abort(new Error('QQ 会话读取已失效，请重新读取。'));
  };
  const subscribe = (entry: ReadEntry, signal?: AbortSignal): Promise<SessionMaterial> => {
    entry.users++;
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (success: boolean, value: unknown): void => {
        if (finished) return;
        finished = true;
        entry.users--;
        signal?.removeEventListener('abort', cancel);
        entry.controller.signal.removeEventListener('abort', invalidated);
        if (success) resolve(value as SessionMaterial);
        else reject(value);
      };
      const cancel = (): void => {
        finish(false, signal?.reason ?? new Error('读取已取消。'));
        if (entry.users === 0) entry.controller.abort(signal?.reason);
      };
      const invalidated = (): void =>
        finish(false, entry.controller.signal.reason ?? new Error('读取已取消。'));
      signal?.addEventListener('abort', cancel, { once: true });
      entry.controller.signal.addEventListener('abort', invalidated, { once: true });
      void entry.task.then(
        (value) => finish(true, value),
        (error) => finish(false, error),
      );
      if (signal?.aborted) cancel();
      else if (entry.controller.signal.aborted) invalidated();
    });
  };
  const ensure = async (
    pid: number,
    identity: AttachIdentity,
    signal?: AbortSignal,
  ): Promise<SessionMaterial> => {
    signal?.throwIfAborted();
    const owner = attachOwner(identity);
    const hit = cached.get(pid);
    const generation = generations.get(pid) ?? 0;
    if (hit?.owner === owner && hit.generation === generation) return hit.material;
    if (hit && hit.owner !== owner) cached.delete(pid);
    const key = `${pid}:${owner}`;
    const pending = inflight.get(key);
    if (pending?.generation === generation && !pending.controller.signal.aborted)
      return subscribe(pending, signal);
    const controller = new AbortController();
    const active = controllers.get(pid) ?? new Set<AbortController>();
    active.add(controller);
    controllers.set(pid, active);
    const task = (queues.get(pid) ?? Promise.resolve()).then(async () => {
      controller.signal.throwIfAborted();
      if ((generations.get(pid) ?? 0) !== generation)
        throw new Error('QQ 会话读取已失效，请重新读取。');
      const material = await read(pid, identity, controller.signal);
      controller.signal.throwIfAborted();
      if ((generations.get(pid) ?? 0) !== generation)
        throw new Error('QQ 会话读取已失效，请重新读取。');
      // 扫描成功也可能只拿到部分字段，不能让暂缺凭据一直命中缓存。
      if (isCompleteSessionMaterial(material)) cached.set(pid, { owner, generation, material });
      return material;
    });
    const entry: ReadEntry = { generation, task, controller, users: 0 };
    const tail = task.then(
      () => {},
      () => {},
    );
    queues.set(pid, tail);
    inflight.set(key, entry);
    void tail.then(() => {
      if (inflight.get(key) === entry) inflight.delete(key);
      if (queues.get(pid) === tail) queues.delete(pid);
      active.delete(controller);
      if (active.size === 0 && controllers.get(pid) === active) controllers.delete(pid);
    });
    return subscribe(entry, signal);
  };
  return { attach: ensure, ensure, reset };
}

export function createDirectAttachHook(
  nt: NtHelperBinding,
  fallback?: (pid: number, signal?: AbortSignal) => Promise<SessionMaterial | null>,
): AttachHook {
  const logger = getLogger().child({ scope: 'attach' });
  return createCachedAttachHook(async (pid, identity, signal) => {
    let material: SessionMaterial;
    try {
      // uin / uid 只用来给 SecToken 精筛（同一段内存记录里带其一）。
      material = await nt.scanSessionMaterial(
        pid,
        identity.uin || undefined,
        identity.uid || undefined,
      );
    } catch (error) {
      signal.throwIfAborted();
      const recovered = await fallback?.(pid, signal);
      if (!recovered) throw error;
      material = recovered;
    }
    logger.info('attached to qq process', {
      event: 'attach',
      pid,
      uin: identity.uin,
      hasA2: material.a2 !== undefined,
      hasD2: material.d2 !== undefined,
      hasD2Key: material.d2Key !== undefined,
      hasSecToken: material.secToken !== undefined,
    });
    return material;
  });
}
