import { createRoot } from 'react-dom/client';
import { useLayoutEffect } from 'react';
import { useMsgDecoration } from '../../src/renderer/src/hooks/useMsgDecoration';
import { seedMessageBubbles } from '../../src/renderer/src/lib/messageBubbles';
import { bubble } from './decoration-readiness.stub';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/im-template/styles.css';

ensureThemeInitialized();
const started = performance.now();
const inline = new URLSearchParams(location.search).get('inline');
if (inline) seedMessageBubbles([{ ...bubble, baseImage: inline }]);
declare global {
  interface Window {
    bubbleCommits: { bubbleId: number; visible: string; atMs: number }[];
  }
}
window.bubbleCommits = [];
useThemeStore
  .getState()
  .setPreference(new URLSearchParams(location.search).get('theme') === 'dark' ? 'dark' : 'light');
function Message({ mine }: { mine: boolean }) {
  const decoration = useMsgDecoration({ bubbleId: 21009, fontId: 31009, widgetId: 0 });
  useLayoutEffect(() => {
    window.bubbleCommits.push({
      bubbleId: decoration.bubbleId,
      visible: getComputedStyle(document.querySelector('.message-content')!).visibility,
      atMs: performance.now() - started,
    });
  });
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
      {Array.from(
        { length: Number(new URLSearchParams(location.search).get('rows')) || 2 },
        (_, index) => ({ id: index + 1, mine: index % 2 === 1 }),
      ).map((row) => (
        <Message key={row.id} mine={row.mine} />
      ))}
    </main>
  </>,
);
