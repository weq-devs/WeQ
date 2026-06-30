/**
 * In-process event bus for WeQ 助手 的流式过程推送。
 *
 * `chatWithAssistant` 启动一轮任务（非阻塞），把每一步通过这里广播；
 * `onAssistantEvent` subscription 桥接成 observable 推给渲染端。镜像
 * `update/updater.ts` 的 `updateBus` 范式。事件带 `runId` 供前端按当前轮过滤。
 */

import { EventEmitter } from 'node:events';
import type { AssistantStep } from '@weq/service';

export interface AssistantStreamEvent {
  runId: string;
  step: AssistantStep;
}

export const assistantBus = new EventEmitter();
/** 提升监听上限：理论上同一时刻只有一个订阅，但保险起见放宽。 */
assistantBus.setMaxListeners(50);
