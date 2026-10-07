/**
 * macOS 系统完整性保护（SIP）状态 —— `csrutil status` 的只读解读。
 *
 * 为什么发包链路要在**开始之前**先问这一句：macOS 上读别的进程内存走
 * `task_for_pid`，而 QQ 带强化运行时（hardened runtime）+ 库校验，root 也照样被
 * 拒 —— 唯一的开关是关 SIP。不先问，用户会先被要一次密码、再等到读失败，才知道
 * 「其实需要重启关 SIP」；先问就能直接跳过内存扫描、走 ninebird（本地快速登录）
 * 那条不需要读内存的路。
 *
 * `csrutil status` 不需要 root，也不改任何东西，输出形如：
 *
 * ```text
 * System Integrity Protection status: enabled.
 * ```
 *
 * 或 `… status: disabled.`；个别引导配置下会是别的词（`unknown` / 多段明细），
 * 那种情况一律返回 `null` —— 调用方必须把 `null` 当成「不知道」，而不是「关着」。
 *
 * 结果**进程内缓存一次**：SIP 只有在重启后才可能变，而这是每个会话都会问的。
 */

import { execFileSync } from 'node:child_process';

const CSRUTIL = '/usr/bin/csrutil';

let cached: boolean | null | undefined;

/**
 * SIP 是否开启。`true` = 开着（读内存一定失败），`false` = 已关闭，
 * `null` = 问不出来（非 macOS / 没有 csrutil / 输出不认识）。
 */
export function readSipEnabled(): boolean | null {
  if (cached === undefined) cached = probeSipEnabled();
  return cached;
}

/** 清掉缓存（测试与「用户改完 SIP 重试」用）。 */
export function resetSipCache(): void {
  cached = undefined;
}

function probeSipEnabled(): boolean | null {
  try {
    const out = execFileSync(CSRUTIL, ['status'], {
      encoding: 'utf8',
      timeout: 5000,
      // 只读探测：不挂 stdio，避免污染宿主 console。
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseSipStatus(out);
  } catch {
    return null;
  }
}

/**
 * 从 `csrutil status` 的输出里读 SIP 状态。纯函数，便于测试。
 *
 * 只认那一行汇总（`System Integrity Protection status: <word>`）：输出里还有
 * `Filesystem Protections: enabled` 之类的分队明细，按它们猜会把「整体关着但某项
 * 开着」判反。
 */
export function parseSipStatus(output: string): boolean | null {
  const match = /System Integrity Protection status:\s*([A-Za-z]+)/i.exec(output);
  if (!match) return null;
  const word = match[1]?.toLowerCase();
  if (word === 'enabled') return true;
  if (word === 'disabled') return false;
  return null;
}
