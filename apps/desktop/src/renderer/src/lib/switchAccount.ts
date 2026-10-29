/**
 * 切换账号的完整流程（从主界面切到另一个已保存的账号）。
 *
 * 原先这段代码长在 `RailAccountFooter` 的 `switchTo()` 里，只有「点左上角头像」
 * 一个入口。现在外部 MCP 也能发起切号（主进程投递请求，渲染层领走），所以抽到这里：
 * **两个入口必须走同一套动作**，否则 MCP 切过去会漏掉清缓存 / 重挂载 / 预热，
 * 界面挂在旧账号上对着已关闭的会话打查询。
 *
 * 顺序不能乱：
 *
 *   1. `beginSwitch()` —— 从这一刻起 App 渲染载入页、不渲染 MainView（见
 *      `state/accountSwitch`）。过渡期间 MainView 完全不挂载，后面 `setOpenedUin(null)`
 *      才不会在「后端账号已关闭」的窗口里白挂载一次。
 *   2. `closeAccount` → 清缓存 → `setOpenedUin(null)`：**清缓存必须在清 uin 之前**，
 *      中间那一小段 `openedUin === null` 的窗口里，仍在渲染的账号级 useQuery 会拿到
 *      旧账号的缓存数据。
 *   3. 打开目标账号，**再清一次缓存**：第一次 purge 与 openAccount 完成之间，in-flight
 *      的查询会打到已关闭的后端并可能把旧结果写回缓存。
 *   4. 预热必须在第二次 purge 之后，否则刚灌进去的新账号数据会被一起清掉。
 */

import type { QueryClient } from '@tanstack/react-query';
import type { DatabaseAlgorithms } from '@weq/native';
import { client, type trpc } from '../trpc/client';
import { useViewState } from '../state/view';
import { useAccountSwitch } from '../state/accountSwitch';
import { confirmMailAccountLeave } from '../state/mailDraft';
import { purgeAccountQueries } from './leaveAccount';
import { runAccountWarmup } from './accountWarmup';

type Utils = ReturnType<typeof trpc.useUtils>;

/** 切号目标：一条已保存的账号记录（`AccountConfig` 的子集）。 */
export interface SwitchTarget {
  configId: string;
  uin: string;
  uid?: string;
  dbKey: string;
  algos?: Record<string, DatabaseAlgorithms> | null;
  displayName?: string;
  avatarUrl?: string | null;
  dataDir?: string;
  static?: boolean;
  mobile?: boolean;
}

export interface SwitchAccountOptions {
  queryClient: QueryClient;
  utils: Utils;
  target: SwitchTarget;
  /** 当前账号的 configId；null 表示还没取到（退回按 uin 判断）。 */
  currentConfigId: string | null;
  /** 当前账号的 uin，仅在 `currentConfigId` 为 null 时用于判断「点的是不是自己」。 */
  currentUin: string;
  /**
   * 切号失败时是否把用户送回首页。点界面切号时是「是」（会话已经关了，留在主界面
   * 只会看到空壳）；外部 MCP 触发时也是「是」——同样是会话已关，没有别的去处。
   */
  onError?: (error: unknown) => void;
}

export interface SwitchAccountResult {
  /** true 表示确实执行了切换；false 表示目标就是当前账号 / 用户取消 / 已有切号在进行。 */
  switched: boolean;
  /** `switched === false` 时的原因，供调用方决定是否提示。 */
  reason?: 'same-account' | 'cancelled' | 'busy' | 'failed';
}

/**
 * 执行一次切号。**调用方负责串行化**（界面侧用组件内的 `busy` 标志，MCP 侧靠
 * `useAccountSwitch().active`）—— 这里只看全局过渡状态，过渡中直接拒绝。
 */
export async function switchAccount(options: SwitchAccountOptions): Promise<SwitchAccountResult> {
  const { queryClient, utils, target, currentConfigId, currentUin, onError } = options;
  const switchState = useAccountSwitch.getState();
  if (switchState.active) return { switched: false, reason: 'busy' };

  // 按 configId 判「点的是不是当前账号」—— 同一个 QQ 号可以同时有在线账号和静态
  // 账号两条记录，只比 uin 会把另一条也当成自己，于是永远切不过去。
  if (currentConfigId ? target.configId === currentConfigId : target.uin === currentUin) {
    return { switched: false, reason: 'same-account' };
  }

  if (!(await confirmMailAccountLeave())) return { switched: false, reason: 'cancelled' };

  const view = useViewState.getState();
  switchState.begin(`正在打开 ${target.displayName || target.uin}…`);
  try {
    await client.bootstrap.closeAccount.mutate();
    purgeAccountQueries(queryClient);
    view.setOpenedUin(null);
    // 让 React 把「已清空」的这一帧提交掉，再开新账号。
    await new Promise((resolve) => setTimeout(resolve, 0));

    if (target.static) {
      // 静态（离线）账号没有实时密钥这一关，直接从它保存的数据库目录重开。
      if (!target.dataDir) throw new Error('该静态账号缺少数据库目录，请重新导入。');
      await client.bootstrap.openStaticAccount.mutate({
        dirPath: target.dataDir,
        preview: {
          uin: target.uin,
          uid: target.uid ?? '',
          displayName: target.displayName ?? '',
          avatarUrl: target.avatarUrl ?? '',
        },
        ...(target.dbKey ? { dbKey: target.dbKey } : {}),
        ...(target.algos?.['nt_msg.db'] ? { algo: target.algos['nt_msg.db'] } : {}),
        ...(target.mobile ? { mobile: true } : {}),
      });
    } else {
      await client.bootstrap.openAccount.mutate({
        uin: target.uin,
        dbKey: target.dbKey,
        ...(target.algos?.['nt_msg.db'] ? { algo: target.algos['nt_msg.db'] } : {}),
        ...(target.displayName ? { displayName: target.displayName } : {}),
        ...(target.avatarUrl ? { avatarUrl: target.avatarUrl } : {}),
        ...(target.dataDir ? { dataDir: target.dataDir } : {}),
      });
    }

    // 第二次 purge：第一次 purge 与 openAccount 完成之间，in-flight 的查询会打到
    // 已关闭的后端，可能把旧结果写回缓存。再清一遍，让新挂载的 MainView 从干净状态
    // 起步。预热必须排在这之后。
    purgeAccountQueries(queryClient);
    useAccountSwitch.getState().setHint(`正在载入 ${target.displayName || target.uin}…`);
    await runAccountWarmup(utils, useAccountSwitch.getState().setProgress);
    view.setOpenedUin(target.uin);
    return { switched: true };
  } catch (error) {
    // 会话已经关了，留在主界面只会看到空壳 —— 回首页让用户重新进入。
    purgeAccountQueries(queryClient);
    view.setOpenedUin(null);
    view.goTo('bootstrap');
    onError?.(error);
    return { switched: false, reason: 'failed' };
  } finally {
    useAccountSwitch.getState().end();
  }
}
