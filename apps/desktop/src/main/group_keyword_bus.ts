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

/**
 * 一条通用的「打开会话并跳到某 seq」请求（群 / 私聊都支持）。防撤回通知用它 ——
 * 撤回可能发生在群聊或私聊，群关键词那套只带群号，不够用。
 */
export interface ConversationJump {
  kind: 'c2c' | 'group';
  conv: string;
  seq: string;
}

/** 待渲染层消费的跳转请求（FIFO）。主进程只往这里塞，渲染层来领。 */
const pending: GroupKeywordJump[] = [];

/** 待渲染层消费的通用会话跳转（FIFO）。 */
const pendingConv: ConversationJump[] = [];

/** 记下一条跳转并唤醒订阅者。 */
export function pushGroupKeywordJump(jump: GroupKeywordJump): void {
  pending.push(jump);
  accountEventBus.emit('groupKeywordJump', { at: Date.now() });
}

/** 领走一条待处理的跳转（无则返回 null）。 */
export function takePendingGroupJump(): GroupKeywordJump | null {
  return pending.shift() ?? null;
}

/** 记下一条通用会话跳转（防撤回通知点击）并唤醒订阅者。 */
export function pushConversationJump(jump: ConversationJump): void {
  pendingConv.push(jump);
  accountEventBus.emit('conversationJump', { at: Date.now() });
}

/** 领走一条待处理的通用会话跳转（无则返回 null）。 */
export function takePendingConversationJump(): ConversationJump | null {
  return pendingConv.shift() ?? null;
}
