import { createRoot } from 'react-dom/client';
import { useLayoutEffect, useRef, useState } from 'react';
import { useMsgDecoration } from '../../src/renderer/src/hooks/useMsgDecoration';
import { seedMessageBubbles } from '../../src/renderer/src/lib/messageBubbles';
import { bubble } from './decoration-readiness.stub';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/im-template/styles.css';

ensureThemeInitialized();
const started = performance.now();
const inline = new URLSearchParams(location.search).get('inline');
const fontHistory = new URLSearchParams(location.search).has('fontHistory');
if (inline) seedMessageBubbles([{ ...bubble, baseImage: inline }]);
declare global {
  interface Window {
    bubbleCommits: { bubbleId: number; fontId: number; visible: string; atMs: number }[];
    showFontHistory: (mode: 'first' | 'empty' | 'history') => void;
  }
}
window.bubbleCommits = [];
useThemeStore
  .getState()
  .setPreference(new URLSearchParams(location.search).get('theme') === 'dark' ? 'dark' : 'light');
function Message({ mine }: { mine: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const decoration = useMsgDecoration(
    { bubbleId: fontHistory ? 0 : 21009, fontId: 31009, widgetId: 0 },
    fontHistory ? ref : undefined,
  );
  useLayoutEffect(() => {
    window.bubbleCommits.push({
      bubbleId: decoration.bubbleId,
      fontId: decoration.fontId,
      visible: getComputedStyle(document.querySelector('.message-content')!).visibility,
      atMs: performance.now() - started,
    });
  });
  return (
    <div
      ref={ref}
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
function FontHistory() {
  const [mode, setMode] = useState<'first' | 'empty' | 'history'>('first');
  window.showFontHistory = setMode;
  return (
    <main className="im-template" style={{ paddingTop: mode === 'history' ? 1400 : 24 }}>
      {mode !== 'empty' && <Message key={mode} mine={false} />}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(
  <>
    <style>{`html,body,#root{margin:0;min-height:100%;height:auto}body{background:var(--weq-chat-bg);color:var(--foreground)}main{padding:24px 12px;max-width:760px;margin:auto}.message-line{margin:24px 0}`}</style>
    {fontHistory ? (
      <FontHistory />
    ) : (
      <main className="im-template">
        {Array.from(
          { length: Number(new URLSearchParams(location.search).get('rows')) || 2 },
          (_, index) => ({ id: index + 1, mine: index % 2 === 1 }),
        ).map((row) => (
          <Message key={row.id} mine={row.mine} />
        ))}
      </main>
    )}
  </>,
);
