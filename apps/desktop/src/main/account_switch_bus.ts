/**
 * 外部 MCP 发起的「切换到某个账号」请求队列。
 *
 * 为什么不在主进程直接切：切号在渲染层是一整套有序动作（确认邮件草稿 → 遮罩 →
 * closeAccount → 清 React Query 缓存 → setOpenedUin(null) → openAccount → 二次清缓存
 * → 预热 → setOpenedUin(新)），唯一实现在 `renderer/lib/switchAccount.ts`。主进程直接
 * 调 `setAccount` 会绕过缓存清理与 MainView 重挂载，界面会挂在旧账号上对着空会话打
 * 查询。所以这里只**投递请求**，由渲染层领走并走同一套流程 —— 和
 * `group_keyword_bus.ts` 的「主进程唤起、渲染层执行」是同一个套路。
 *
 * 订阅者计数用于回答「现在有没有界面能接这个请求」。没有界面（纯后端 / Web 端没开
 * 页面）时投递出去只会石沉大海，调用方必须当场知道，不能假装成功。
 */

import { accountEventBus } from './context/app_context';

export interface AccountSwitchRequest {
  /** 目标账号记录的 configId（uin + dataDir 哈希）。同 uin 可能有在线/静态两条。 */
  configId: string;
  /** 目标 uin，仅用于回显与错误信息。 */
  uin: string;
  /** 触发来源，写日志用。 */
  source: 'mcp';
  /** 投递时间（unix ms）。 */
  at: number;
}

/**
 * 待渲染层消费的切号请求（FIFO）。
 *
 * 有上界：切号过渡期间界面被遮罩盖住、订阅可能暂时没人领，无人消费时不能让队列
 * 无限增长。超出的部分丢掉最旧的 —— 切号是「最终状态」语义，过时的目标没有意义。
 */
const pending: AccountSwitchRequest[] = [];
const QUEUE_LIMIT = 8;

let subscribers = 0;

/** 记下一条切号请求并唤醒订阅者。 */
export function pushAccountSwitchRequest(request: AccountSwitchRequest): void {
  pending.push(request);
  if (pending.length > QUEUE_LIMIT) pending.splice(0, pending.length - QUEUE_LIMIT);
  accountEventBus.emit('accountSwitchRequested', { at: request.at });
}

/** 领走一条待处理的切号请求（无则返回 null）。 */
export function takeAccountSwitchRequest(): AccountSwitchRequest | null {
  return pending.shift() ?? null;
}

/** 渲染层订阅建立 / 取消时调用，用来判断「当前有没有界面能接请求」。 */
export function accountSwitchSubscriberOpened(): void {
  subscribers += 1;
}

export function accountSwitchSubscriberClosed(): void {
  subscribers = Math.max(0, subscribers - 1);
}

export function hasAccountSwitchSubscriber(): boolean {
  return subscribers > 0;
}

/** 测试用：清空队列与订阅计数。 */
export function resetAccountSwitchBus(): void {
  pending.length = 0;
  subscribers = 0;
}
