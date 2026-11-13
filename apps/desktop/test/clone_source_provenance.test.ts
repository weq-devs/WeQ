import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { AgentMessageContent } from '../src/renderer/src/views/agentlab/ChatBubble';

it('合并后的消息保留可检查的原会话及冲突前身份，不修改显示正文', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() =>
      root.render(
        h(AgentMessageContent, {
          text: '原始正文',
          sourceSession: { id: 'old-session', title: '旧标题', messageId: 'same-id' },
        }),
      ),
    );
    const message = host.querySelector<HTMLElement>('.message-content')!;
    expect(message.textContent).toBe('原始正文');
    expect(message.title).toContain('旧标题');
    expect(message.title).toContain('same-id');
    expect(message.dataset.sourceSessionId).toBe('old-session');
    expect(message.dataset.sourceMessageId).toBe('same-id');
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
