/**
 * In-process event bus for WeQ 助手 的流式过程推送。
 *
 * `chatWithAssistant` 启动一轮任务（非阻塞），把每一步通过这里广播；
 * `onAssistantEvent` subscription 桥接成 observable 推给渲染端。镜像
 * `update/updater.ts` 的 `updateBus` 范式。事件带 `runId` 供前端按当前轮过滤。
 */

import { accountRuntimeEvents, accountRuntimeState } from '../context/account_runtime';
import type { AssistantStep } from '@weq/service';

export interface AssistantStreamEvent {
  accountConfigId?: string;
  sessionId?: string;
  messageId?: string;
  taskId?: string;
  runId: string;
  step: AssistantStep;
}

export const assistantBus = accountRuntimeEvents(50);

export const activeAssistantRuns = accountRuntimeState(() => new Map<string, AbortController>());

export function cancelAssistantRuns(): void {
  for (const controller of activeAssistantRuns().values()) controller.abort();
  activeAssistantRuns().clear();
}
