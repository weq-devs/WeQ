/**
 * In-process event bus for 克隆体群聊 的流式消息推送。
 *
 * `sendGroupMessage` 启动一轮群聊（非阻塞），把每一条产出的群消息（用户那条 +
 * 每个克隆体的每一条回复）通过这里广播；`onGroupChatEvent` subscription 桥接成
 * observable 推给渲染端。镜像 `assistant_bus.ts` 的 `assistantBus` 范式。
 * 事件带 `groupRunId` 供前端按当前轮过滤，`kind` 区分消息/收尾/出错。
 */

import { EventEmitter } from 'node:events';
import type { AgentLabGroupMessage } from '@weq/agentlab';

export type GroupChatStreamEvent =
  | { groupRunId: string; groupId: string; kind: 'message'; message: AgentLabGroupMessage }
  | { groupRunId: string; groupId: string; kind: 'done' }
  | { groupRunId: string; groupId: string; kind: 'error'; message: string };

export const groupChatBus = new EventEmitter();
/** 放宽监听上限：理论上同一时刻只有一个订阅，保险起见。 */
groupChatBus.setMaxListeners(50);
