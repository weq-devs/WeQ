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
 * 按平台的分支。幂等由 hook 自己负责：`ensure` 对已经读过的 pid 是空操作；`reset`
 * 忘掉某个 pid，好让失败后的下一次 `ensure` 重新读一遍（QQ 重启 / 换账号都会让
 * 上一轮的物料失效）。
 *
 * ⚠️ 自动 attach 关闭时（设置 → 账号基础）禁止读内存。所有会触发 attach 的调用方
 * 必须在调用前检查 `userConfig.getSettings().autoAttachQq`（或调用 app_context 的
 * `requireAttachEnabled`）。唯一豁免：登录时的数据库密钥提取（bootstrap 的
 * `fetchKeyFromInstance` / `prepareInstanceAttach`）—— 那是打开账号的前提。
 */

import type { NtHelperBinding, SessionMaterial } from '@weq/native';
import { getLogger } from '../common/logger';

export interface AttachHook {
  /**
   * 读 `pid` 的内存并返回该会话物料。平台差异（是否提权）由实现自己决定；
   * `uin` 只用于日志与归属，读取本身不需要它。
   * 幂等 —— 同一个 pid 已经读过就直接返回缓存。
   */
  attach(pid: number, uin: string): Promise<SessionMaterial>;
  /**
   * 同 {@link attach}（读内存没有独立的「等待就绪」半步）。
   */
  ensure(pid: number, uin: string): Promise<SessionMaterial>;
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
/** Account-scoped caching with exclusive reads per process and reset fencing. */
export function createCachedAttachHook(
  read: (pid: number, uin: string) => Promise<SessionMaterial>,
): AttachHook {
  const cached = new Map<number, { uin: string; generation: number; material: SessionMaterial }>();
  const generations = new Map<number, number>();
  const inflight = new Map<string, { generation: number; task: Promise<SessionMaterial> }>();
  const queues = new Map<number, Promise<void>>();
  const reset = (pid: number): void => {
    cached.delete(pid);
    generations.set(pid, (generations.get(pid) ?? 0) + 1);
  };
  const ensure = async (pid: number, uin: string): Promise<SessionMaterial> => {
    const hit = cached.get(pid);
    const generation = generations.get(pid) ?? 0;
    if (hit?.uin === uin && hit.generation === generation) return hit.material;
    if (hit && hit.uin !== uin) cached.delete(pid);
    const key = `${pid}:${uin}`;
    const pending = inflight.get(key);
    if (pending?.generation === generation) return pending.task;
    const task = (queues.get(pid) ?? Promise.resolve()).then(async () => {
      if ((generations.get(pid) ?? 0) !== generation)
        throw new Error('QQ 会话读取已失效，请重新读取。');
      const material = await read(pid, uin);
      if ((generations.get(pid) ?? 0) !== generation)
        throw new Error('QQ 会话读取已失效，请重新读取。');
      cached.set(pid, { uin, generation, material });
      return material;
    });
    const tail = task.then(
      () => {},
      () => {},
    );
    queues.set(pid, tail);
    const entry = { generation, task };
    inflight.set(key, entry);
    try {
      return await task;
    } finally {
      if (inflight.get(key) === entry) inflight.delete(key);
      if (queues.get(pid) === tail) queues.delete(pid);
    }
  };
  return { attach: ensure, ensure, reset };
}

export function createDirectAttachHook(nt: NtHelperBinding): AttachHook {
  const logger = getLogger().child({ scope: 'attach' });
  return createCachedAttachHook(async (pid, uin) => {
    const material = await nt.scanSessionMaterial(pid);
    logger.info('attached to qq process', {
      event: 'attach',
      pid,
      uin,
      hasA2: material.a2 !== undefined,
      hasD2: material.d2 !== undefined,
      hasD2Key: material.d2Key !== undefined,
    });
    return material;
  });
}
