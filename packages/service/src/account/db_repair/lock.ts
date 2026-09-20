/**
 * 锁占用判定：谁能挡住我们替换 `nt_msg.db`，以及"是不是当前账号那个 QQ"。
 *
 * 依据是 native 的 `probeDbLock(dbPath)`（win32 走 Restart Manager、linux 走
 * `/proc` 的写锁持有者）——**事实层**是"有哪个 pid 持有这个文件"，进程名只是给用户看
 * 的标签。所以：
 *
 *   - 分类**只影响界面措辞**（"结束 QQ 进程" vs "先关闭 WeQ 里的这个账号"），
 *     不参与"能不能修"的判断 —— 那个判断永远只看"有没有持有者"。
 *   - 名称为空（拿不到 `/proc/<pid>/comm`、或 Restart Manager 没给 `strAppName`）时
 *     归到"其它"，宁可让用户看到一个 pid，也不要猜成 QQ。
 *   - 调用方如果知道当前账号的 QQ pid（`platform.resolveQqPid`），传进来即可让归属
 *     更准：那个 pid 一律算 QQ，不受名字猜测影响。
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
 * 只做**展示归类**：QQ NT 的主进程是 `QQ.exe`（linux 下是 `qq`），还有
 * `QQProtect` / `QQExternal` 之类的辅助进程；`WeQ` / Electron 主进程明确排除。
 * 判错的最坏后果只是按钮文案不对 —— 真正决定"能不能修"的仍是持有人列表本身。
 */
export function isQqProcessName(name: string): boolean {
  const base = normalizeProcessName(name);
  if (base === '') return false;
  if (base.includes('weq') || base.includes('electron')) return false;
  return base.startsWith('qq') || base === 'txplatform';
}

/**
 * 把一次锁探测归类成预检结论。
 *
 * @param probe       `probeDbLock` 的产出；`null` 表示调用方没有这个能力（老产物）。
 * @param qqPid       当前账号的 QQ pid（`platform.resolveQqPid`），可选。命中它一律算 QQ。
 */
export function classifyLock(
  probe: DbRepairLockProbe | null,
  qqPid: number | null = null,
): DbRepairLockClassification {
  if (!probe) {
    return { readiness: 'unknown-lock', holders: [], qqHolders: [], otherHolders: [] };
  }
  if (!probe.success) {
    // 探测失败（权限、平台不支持）**不等于没有锁**：不阻断修复，但如实标成未知，
    // 让替换前那道复核来做最后判断。
    return { readiness: 'unknown-lock', holders: probe.holders, qqHolders: [], otherHolders: [] };
  }

  const holders = probe.holders;
  if (holders.length === 0) {
    return { readiness: 'ready', holders: [], qqHolders: [], otherHolders: [] };
  }

  const qqHolders: DbRepairLockHolder[] = [];
  const otherHolders: DbRepairLockHolder[] = [];
  for (const holder of holders) {
    const isQq = (qqPid !== null && holder.pid === qqPid) || isQqProcessName(holder.name);
    (isQq ? qqHolders : otherHolders).push(holder);
  }

  // QQ 与其它进程同时持有（例如 QQ 和 WeQ 都开着）时按 QQ 报：结束 QQ 后还要关 WeQ 的
  // 账号，界面下一步的预检会把这件事暴露出来。
  const readiness: DbRepairReadiness = qqHolders.length > 0 ? 'blocked-by-qq' : 'blocked-by-other';
  return { readiness, holders, qqHolders, otherHolders };
}
