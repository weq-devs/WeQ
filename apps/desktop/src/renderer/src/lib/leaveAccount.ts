/**
 * 离开当前账号、回到首页。
 *
 * 「退出账号」在渲染层是三件事，顺序不能乱（原先只写在 `RailAccountFooter` 的退出
 * 按钮里，数据库修复也需要同一套，所以挪到这里）：
 *
 *   1. `bootstrap.closeAccount` —— 后端 `clearAccount` 会把会话里的每个 `Db` 关掉，
 *      顺带停掉 accountMonitor / dbWatch / SSE / MCP / 助手。
 *   2. `purgeAccountQueries` —— 用 `removeQueries`（不是 invalidate）把 React Query 里
 *      所有 `trpc.account.*` 的条目**彻底清掉**。否则首页回去的过程中，recent_contact /
 *      buddies / groups 会先闪一遍旧账号的数据。
 *   3. 最后才把 `openedUin` 清掉、切到 bootstrap。**清缓存必须在清 uin 之前**：中间
 *      那一小段 `openedUin === null` 的窗口里，任何仍在渲染的账号级 useQuery 都会拿到
 *      缓存里的旧账号数据。
 *
 * 为什么数据库修复要复用它：修复替换库文件之前会主动 `clearAccount()`（否则 Windows 上
 * `rename` 被占用挡住、Linux 上旧 inode 仍被读）。这时**主进程里账号已经关了，渲染层却
 * 还停在主界面** —— 表现就是「会话列表在、头像没有、点会话点不开消息」。所以修完必须
 * 把人送回首页重新打开，这个函数就是那一步。
 */

import type { QueryClient } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import { client, trpc } from '../trpc/client';
import { useViewState } from '../state/view';

/**
 * 丢掉所有账号级缓存条目（并取消在途请求 —— 否则它们会在清完之后落到新账号的 key 上）。
 */
export function purgeAccountQueries(queryClient: QueryClient): void {
  const accountKey = getQueryKey(trpc.account);
  void queryClient.cancelQueries({ queryKey: accountKey });
  queryClient.removeQueries({ queryKey: accountKey });
}

/** 关掉当前账号并回到首页（`openedUin` 清空 + 视图切到 bootstrap）。 */
export async function leaveAccountForBootstrap(queryClient: QueryClient): Promise<void> {
  // 主进程可能早就把它关掉了（例如数据库修复的 `releaseHandles`）；`clearAccount` 对
  // 空会话是无害的空操作，所以这里不需要先问"还开着吗"。
  await client.bootstrap.closeAccount.mutate();
  purgeAccountQueries(queryClient);
  const view = useViewState.getState();
  view.setOpenedUin(null);
  view.goTo('bootstrap');
}
