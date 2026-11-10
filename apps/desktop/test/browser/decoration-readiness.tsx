import { createRoot } from 'react-dom/client';
import { useMsgDecoration } from '../../src/renderer/src/hooks/useMsgDecoration';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/im-template/styles.css';

ensureThemeInitialized();
useThemeStore
  .getState()
  .setPreference(new URLSearchParams(location.search).get('theme') === 'dark' ? 'dark' : 'light');
function Message({ mine }: { mine: boolean }) {
  const decoration = useMsgDecoration({ bubbleId: 21009, fontId: 31009, widgetId: 0 });
  return (
    <div
      className={`message-line ${mine ? 'mine' : 'theirs'}`}
      data-bubble={decoration.bubbleId || undefined}
      data-font={decoration.fontId || undefined}
    >
      <div className="message-bubble">
        <div className="message-content">消息仍然清楚可读，Hello WeQ。</div>
      </div>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(
  <>
    <style>{`html,body,#root{margin:0;min-height:100%;height:auto}body{background:var(--weq-chat-bg);color:var(--foreground)}main{padding:24px 12px;max-width:760px;margin:auto}.message-line{margin:24px 0}`}</style>
    <main className="im-template">
      <Message mine={false} />
      <Message mine />
    </main>
  </>,
);
