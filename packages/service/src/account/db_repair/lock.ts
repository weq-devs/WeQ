/**
 * 锁占用判定：谁能挡住我们替换 `nt_msg.db`，以及"是不是当前账号那个 QQ / 是不是
 * WeQ 自己"。
 *
 * 依据是 native 的 `probeDbLock(dbPath)`（win32 走 Restart Manager、linux 走
 * `fcntl` 写锁）——**事实层**是"有哪个 pid 持有这个文件"，进程名只是给用户看的标签。
 * 两个平台的口径不同，这里必须同时容纳：
 *
 *   - Windows（Restart Manager）枚举的是**谁把这个文件打开着**：WeQ 只要开着这个账号，
 *     就一定在列表里（我们读消息时就握着这个库的连接）。
 *   - Linux/macOS（`fcntl(F_GETLK)`）问的是**谁持着冲突写锁**：只读连接平时不持锁，
 *     所以 WeQ 一般根本不出现 —— 这也是同一个 bug 只在 Windows 上炸的原因。
 *
 * 于是分类要回答三层问题，而且**结论会参与"能不能修"的判断**：
 *
 *   - `blocked-by-qq`：QQ 在写。边写边读会读出撕裂的页，必须先结束它；
 *   - `blocked-by-other`：第三方进程占着。我们关不掉它，只能让用户自己处理；
 *   - `self-hold`：**只有 WeQ 自己**。那是我们自己的句柄，替换前 `releaseHandles()`
 *     会关掉它，所以不该拦 —— 拦下去的后果是一句自相矛盾的"请先关闭该账号"，而修复
 *     面板恰恰只能在账号已打开时进入，等于死路。
 *
 * 名称为空（拿不到 `/proc/<pid>/comm`、或 Restart Manager 没给 `strAppName`）时归到
 * "其它"，宁可让用户看到一个 pid，也不要猜成 QQ —— 除非 pid 命中 WeQ 自己（那是不依赖
 * 名字的权威归属）。调用方如果知道当前账号的 QQ pid（`platform.resolveQqPid`），传进来
 * 即可让归属更准：那个 pid 一律算 QQ，不受名字猜测影响。
 */

import type { DbRepairLockHolder, DbRepairReadiness } from './types';

/** `probeDbLock` 的产出（native 结构的一个子集）。 */
export interface DbRepairLockProbe {
  /** 探测本身是否成功；`false` 表示"未知"，不代表"没锁"。 */
  success: boolean;
  holders: DbRepairLockHolder[];
}

export interface DbRepairLockClassification {
  readiness: DbRepairReadiness;
  holders: DbRepairLockHolder[];
  qqHolders: DbRepairLockHolder[];
  /** WeQ 自己持有的（替换前会释放，不构成阻断）。 */
  selfHolders: DbRepairLockHolder[];
  /** 既不是 QQ、也不是 WeQ 的第三方持有者（真阻断）。 */
  otherHolders: DbRepairLockHolder[];
}

/** 归一化进程名：去空白、转小写、去掉 `.exe`。 */
function normalizeProcessName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\.exe$/, '');
}

/**
 * 这个名字看起来像 QQ 吗？
 *
 * QQ NT 的主进程是 `QQ.exe`（linux 下是 `qq`），还有 `QQProtect` / `QQExternal` 之类的
 * 辅助进程；`WeQ` / Electron 主进程明确排除（它们归 {@link isSelfProcessName}）。
 */
export function isQqProcessName(name: string): boolean {
  const base = normalizeProcessName(name);
  if (base === '') return false;
  if (base.includes('weq') || base.includes('electron')) return false;
  return base.startsWith('qq') || base === 'txplatform';
}

/**
 * 这个名字看起来像 WeQ 自己吗？
 *
 * 只作为 pid 之外的**兜底**：正常情况下 WeQ 主进程的 pid 就是 `process.pid`，native
 * 探测会如实报回来，不依赖名字。但名字匹配仍值得留着 —— Linux 的 `/proc/<pid>/comm`
 * 可能被截断，Windows 的 `strAppName` 也不保证是文件名，而"只有一个 WeQ 主进程"这件事
 * （`app.requestSingleInstanceLock()`）让名字判断的误伤面几乎为零。
 */
export function isSelfProcessName(name: string): boolean {
  const base = normalizeProcessName(name);
  if (base === '') return false;
  return base.includes('weq') || base.includes('electron');
}

/**
 * 把一次锁探测归类成预检结论。
 *
 * @param probe       `probeDbLock` 的产出；`null` 表示调用方没有这个能力（老产物）。
 * @param qqPid       当前账号的 QQ pid（`platform.resolveQqPid`），可选。命中它一律算 QQ。
 * @param selfPid     WeQ 自己（主进程 `process.pid`）的 pid，可选。命中它一律算"自己"。
 */
export function classifyLock(
  probe: DbRepairLockProbe | null,
  qqPid: number | null = null,
  selfPid: number | null = null,
): DbRepairLockClassification {
  const empty = {
    holders: [] as DbRepairLockHolder[],
    qqHolders: [] as DbRepairLockHolder[],
    selfHolders: [] as DbRepairLockHolder[],
    otherHolders: [] as DbRepairLockHolder[],
  };
  if (!probe) {
    return { readiness: 'unknown-lock', ...empty };
  }
  if (!probe.success) {
    // 探测失败（权限、平台不支持）**不等于没有锁**：不阻断修复，但如实标成未知，
    // 让替换前那道复核来做最后判断。
    return { readiness: 'unknown-lock', ...empty, holders: probe.holders };
  }

  const holders = probe.holders;
  if (holders.length === 0) {
    return { readiness: 'ready', ...empty };
  }

  const qqHolders: DbRepairLockHolder[] = [];
  const selfHolders: DbRepairLockHolder[] = [];
  const otherHolders: DbRepairLockHolder[] = [];
  for (const holder of holders) {
    // 顺序有意义：QQ 的 pid 是调用方给的权威归属，比名字可信；"自己"的判断优先于名字
    // 猜测，避免 pid 命中却因名字拿不到而被误判成第三方。
    if ((qqPid !== null && holder.pid === qqPid) || isQqProcessName(holder.name)) {
      qqHolders.push(holder);
    } else if ((selfPid !== null && holder.pid === selfPid) || isSelfProcessName(holder.name)) {
      selfHolders.push(holder);
    } else {
      otherHolders.push(holder);
    }
  }

  // 优先级：QQ（它在写，边写边读会读出撕裂的页）> 第三方（我们关不掉它）>
  // WeQ 自己（替换前会释放，不拦）。
  let readiness: DbRepairReadiness;
  if (qqHolders.length > 0) readiness = 'blocked-by-qq';
  else if (otherHolders.length > 0) readiness = 'blocked-by-other';
  else readiness = 'self-hold';
  return { readiness, holders, qqHolders, selfHolders, otherHolders };
}
