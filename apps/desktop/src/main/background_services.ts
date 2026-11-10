/**
 * 「现在有哪些后台服务在跑」的唯一判据。
 *
 * 关窗确认（`index.ts` 的 `win.on('close')` 拦截）使用这里，
 * 避免两处各写一套、慢慢对不上。**退出本身不再经过确认**：Dock / Cmd+Q / 托盘
 * 「退出 WeQ」都是明确指令，直接退出，服务随 `will-quit` 释放。
 *
 * 只统计**真正在监听 / 推送**的服务：
 *   - MCP / OneBot / 公众号推送 —— 有监听端口；
 *   - Web / Remote —— 服务实例已启动；
 *   - SSE —— 有账号且已挂上推送目标（没有端口，只能这么判断）。
 *
 * 「已启用但等待账号」不算运行中：此刻退出并不会中断任何实际连接，
 * 拿它去提醒或拦退出只会让用户莫名其妙。
 *
 * 注意：本模块**不要** import `index.ts`（那里反向 import 了 `getAppContext`），
 * 否则形成模块循环。只依赖各 runtime 自己的状态函数。
 */

import { isSsePushActive } from './context/app_context';
import { isMcpRunning } from './mcp/server';
import { oneBotStatus } from './onebot/runtime';
import { remoteRuntime } from './remote/runtime';
import { desktopWebRuntime } from './web/runtime';
import { assistantResourceServer } from './weq_assistant/server';

export interface RunningService {
  /** 稳定 id，给测试和前端做 key，不展示。 */
  id: 'mcp' | 'onebot' | 'assistant' | 'web' | 'remote' | 'sse';
  /** 展示名，直接拼进退出确认的文案。 */
  label: string;
}

const LABELS: Record<RunningService['id'], string> = {
  mcp: 'MCP 服务器',
  onebot: 'OneBot 服务',
  assistant: 'QQ 公众号推送',
  web: '本机浏览器访问',
  remote: 'WeQ Remote',
  sse: 'SSE 消息推送',
};

/** 各服务是否正在运行。任何一项抛错都当作「没在跑」，不阻断退出。 */
function isRunning(id: RunningService['id']): boolean {
  try {
    switch (id) {
      case 'mcp':
        return isMcpRunning();
      case 'onebot':
        return oneBotStatus().running;
      case 'assistant':
        return assistantResourceServer.status().running;
      case 'web':
        return desktopWebRuntime.status().enabled;
      case 'remote':
        return remoteRuntime.status().enabled;
      case 'sse':
        return isSsePushActive();
    }
  } catch {
    return false;
  }
}

/** 按固定顺序列出当前运行中的后台服务；空数组表示没有。 */
export function backgroundServicesRunning(): RunningService[] {
  const ids: RunningService['id'][] = ['mcp', 'onebot', 'assistant', 'web', 'remote', 'sse'];
  return ids.filter(isRunning).map((id) => ({ id, label: LABELS[id] }));
}
