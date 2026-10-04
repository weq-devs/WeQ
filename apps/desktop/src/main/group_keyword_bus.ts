/**
 * 群关键词提醒里**与 Electron 无关**的那一小块：待处理的「打开会话并跳转」队列。
 *
 * 为什么单独一个文件：`accounts/bootstrap` 路由（被 web 端复用）要暴露
 * `consumeGroupKeywordJump`，而它**不能**顺着 import 走到 `electron`
 * （见 apps/web/scripts/check-electron-free.ts）。真正弹通知、抓群头像那部分在
 * `group_keyword_notify.ts`（Electron-only），两边共用这里的队列 + 事件总线。
 */

import { accountEventBus } from './context/app_context';

export interface GroupKeywordJump {
  groupCode: string;
  msgSeq: string;
}

/** 待渲染层消费的跳转请求（FIFO）。主进程只往这里塞，渲染层来领。 */
const pending: GroupKeywordJump[] = [];

/** 记下一条跳转并唤醒订阅者。 */
export function pushGroupKeywordJump(jump: GroupKeywordJump): void {
  pending.push(jump);
  accountEventBus.emit('groupKeywordJump', { at: Date.now() });
}

/** 领走一条待处理的跳转（无则返回 null）。 */
export function takePendingGroupJump(): GroupKeywordJump | null {
  return pending.shift() ?? null;
}
