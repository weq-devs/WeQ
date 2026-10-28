import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { qqMessageRenderer } from '../../src/renderer/src/components/QqMessageContent';
import { TextMarkdownContext } from '../../src/renderer/src/state/textMarkdown';
import { MessageContextMenu } from '../../src/renderer/src/im-template/template/messageContextMenu';
import { createTemplateDemoData } from '../../src/renderer/src/im-template/template/demoData';
import type { Message } from '../../src/renderer/src/im-template/template/types';
import {
  useThemeStore,
  type ThemePreference,
  type ThemeBackground,
} from '../../src/renderer/src/state/theme';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/im-template/styles/chat.css';

declare global {
  interface Window {
    markdownFixture: (theme: ThemePreference, accent: string, background: ThemeBackground) => void;
  }
}
window.markdownFixture = (theme, accent, background) => {
  const store = useThemeStore.getState();
  store.setAccent(accent);
  store.setBackground(background);
  store.setPreference(theme);
};
const demo = createTemplateDemoData();
const conversation = demo.conversations.find((row) => row.type === 'direct')!;
const message: Message = {
  id: 'markdown-fixture',
  conversationId: conversation.id,
  senderId: demo.user.id,
  createdAt: '2026-10-29T01:00:00Z',
  body: '# 合成消息\n**粗体内容**\n- 第一项\n- 第二项',
  qqElements: [
    { type: 'text', data: { textContent: '# 合成消息\n**粗体内容**\n- 第一项\n- 第二项' } },
  ],
};
function Fixture() {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  return (
    <main
      style={{
        padding: 24,
        minHeight: '100vh',
        background: 'var(--weq-chat-bg)',
        color: 'var(--foreground)',
      }}
    >
      <div
        id="message"
        style={{ maxWidth: 520, whiteSpace: 'pre-wrap' }}
        onContextMenu={(event) => {
          event.preventDefault();
          setMenu({ x: event.clientX, y: event.clientY });
        }}
      >
        {qqMessageRenderer.render({ message, conversation, mine: false })}
      </div>
      {menu ? (
        <MessageContextMenu
          state={{ message, ...menu }}
          onClose={() => setMenu(null)}
          onCopy={() => setMenu(null)}
        />
      ) : null}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(
  <TextMarkdownContext.Provider value={false}>
    <Fixture />
  </TextMarkdownContext.Provider>,
);
