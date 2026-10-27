import type { AgentLabModelOutput } from '@weq/agentlab';

export const CLONE_LOG_REQUEST_LIMIT = 64;
export const CLONE_LOG_TEXT_LIMIT = 32_000;
export interface CloneModelLog extends AgentLabModelOutput {
  content: string;
  reasoning: string;
  truncated?: boolean;
}

/** 仅保存各请求尾部，限制长训练的内存占用，不将模型输出写入浏览器存储。 */
export function appendCloneOutput(
  logs: CloneModelLog[],
  event: AgentLabModelOutput,
): CloneModelLog[] {
  const previous = logs.find((log) => log.requestId === event.requestId);
  const next: CloneModelLog = {
    ...previous,
    ...event,
    content: previous?.content ?? '',
    reasoning: previous?.reasoning ?? '',
  };
  if (event.channel && event.text) {
    const text = next[event.channel] + event.text;
    next[event.channel] = text.slice(-CLONE_LOG_TEXT_LIMIT);
    next.truncated ||= text.length > CLONE_LOG_TEXT_LIMIT;
  }
  delete next.text;
  return (
    previous ? logs.map((log) => (log.requestId === event.requestId ? next : log)) : [...logs, next]
  ).slice(-CLONE_LOG_REQUEST_LIMIT);
}
