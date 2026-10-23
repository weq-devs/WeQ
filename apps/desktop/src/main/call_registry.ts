/**
 * `CallManager` 的按 pid 缓存。
 *
 * 通话是「一路一次」的资源，但管理器要跨请求复用（发起在 mutation 里，挂断、
 * 推音频、订阅在另外几个调用里），所以按 pid 记住实例。pid 变了说明 QQ 重启过，
 * 旧实例已经没有意义，顺手丢掉。
 *
 * 放独立文件是为了让 `routers/call.ts` 不直接依赖 `call.ts` 里的重型导入
 * （dgram / native 编解码），也让「哪个 pid 对应哪个管理器」这条规则只有一个
 * 出处。
 */

import type { Platform } from '@weq/platform';
import { CallManager } from './call';

const managers = new Map<number, CallManager>();

/** 拿到 `pid` 对应的管理器；不存在就建一个。 */
export function callManagerFor(platform: Platform, pid: number): CallManager {
  const existing = managers.get(pid);
  if (existing) return existing;

  // pid 变了：旧实例的 socket 与编解码器都属于上一个 QQ 进程，直接丢。
  for (const [oldPid, manager] of managers) {
    if (oldPid !== pid) {
      manager.dispose();
      managers.delete(oldPid);
    }
  }

  const manager = new CallManager(platform.native.ntHelper, platform);
  managers.set(pid, manager);
  return manager;
}

/** 账号切换 / 退出时调用。 */
export function disposeCallManagers(): void {
  for (const manager of managers.values()) manager.dispose();
  managers.clear();
}
