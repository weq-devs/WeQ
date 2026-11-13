import { useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IntentSenseProvider } from '../../src/renderer/src/components/intentSense/context';
import {
  MessageIntentSense,
  IntentChips,
} from '../../src/renderer/src/components/intentSense/MessageIntentSense';
import { IntentSuggestionBar } from '../../src/renderer/src/components/intentSense/IntentSuggestionBar';
import { AffinityPill } from '../../src/renderer/src/components/intentSense/AffinityPill';
import { IntentProfileDialog } from '../../src/renderer/src/components/intentSense/IntentProfileDialog';
import { ContactWorkspaceNavigationContext } from '../../src/renderer/src/lib/profileNavigation';
import {
  setMode,
  setHistory,
  getHistory,
  result,
  publishResult,
  publishProgress,
  releaseCache,
} from './intent-loading.stub';
import '../../src/renderer/src/styles/index.css';

const qa = {
  setMode,
  setHistory,
  getHistory,
  publishResult,
  publishProgress,
  releaseCache,
  located: null as unknown,
  portraitOpened: false,
  setMessages: (_ids: string[]) => {},
  setManualPendingMessages: (_ids: string[]) => {},
  frames: [] as Array<{ id: string; pills: number; height: number; visible: boolean }>,
};
Object.assign(window, { intentQa: qa });
function Bubble({ msgId }: { msgId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const bubble = ref.current!;
    const chips = bubble.querySelector<HTMLElement>('.weq-intent-chips')!;
    qa.frames.push({
      id: msgId,
      pills: chips?.querySelectorAll('.weq-intent-pill').length ?? 0,
      height: bubble.getBoundingClientRect().height,
      visible: chips ? getComputedStyle(chips.firstElementChild!).opacity === '1' : false,
    });
  });
  return (
    <div className="message-line">
      <div className="message-bubble" data-message-id={msgId} ref={ref}>
        <span className="message-text">复古（）</span>
        <MessageIntentSense msgId={msgId} bubbleRef={ref} analyzable />
      </div>
    </div>
  );
}
function Fixture() {
  const [draft, setDraft] = useState('');
  const [ids, setIds] = useState(['message']);
  const [manualPendingMessageIds, setManualPendingMessageIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  qa.setMessages = setIds;
  qa.setManualPendingMessages = (ids) => setManualPendingMessageIds(new Set(ids));
  return (
    <>
      <style>{`
      body { margin: 0; background: var(--weq-bg-surface); color: var(--weq-fg-primary); }
      .intent-qa { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 20px; padding: 20px; }
      .intent-qa .chat-pane { height: 640px; --chat-header-height: 48px; --composer-height: 120px; }
      .intent-qa .chat-header { display: flex; justify-content: space-between; padding: 8px; }
      .intent-qa .message-scroll { padding: 60px 20px 20px; }
      .intent-qa .message-line { display: block; }
      .intent-qa .message-bubble { display: grid; gap: 4px; width: max-content; max-width: 100%; }
      .intent-qa .message-text { padding: 10px 12px; background: var(--weq-bg-surface); border-radius: 8px; }
      .intent-qa .composer { padding: 12px; }
      .intent-qa textarea { width: 100%; height: 60px; }
      .intent-qa .weq-int-dialog { width: 100%; }
      .intent-qa .group-keyword-body { max-height: 540px; overflow: auto; }
      .intent-palette { display: flex; flex-wrap: wrap; gap: 8px; padding: 20px; }
      @media(max-width:720px) { .intent-qa { grid-template-columns: minmax(0, 1fr); padding: 12px; } }
    `}</style>
      <main className="intent-qa">
        <section className="chat-pane">
          <header className="chat-header">
            <span>合成会话</span>
            <ContactWorkspaceNavigationContext.Provider
              value={() => {
                qa.portraitOpened = true;
              }}
            >
              <AffinityPill peerUid="fixture" />
            </ContactWorkspaceNavigationContext.Provider>
          </header>
          <IntentSenseProvider
            kind="c2c"
            conv="fixture"
            latestPeerMsgId={ids.at(-1)!}
            roamingMessageKey={ids.filter((id) => id.startsWith('roaming:')).join('|')}
            manualPendingMessageIds={manualPendingMessageIds}
            manualSingleMessageId={
              manualPendingMessageIds.size === 1 ? [...manualPendingMessageIds][0] : undefined
            }
          >
            <div className="message-scroll">
              {ids.map((msgId) => (
                <Bubble key={msgId} msgId={msgId} />
              ))}
            </div>
          </IntentSenseProvider>
          <IntentSuggestionBar
            kind="c2c"
            conv="fixture"
            replyTargetId="message"
            latestMessageId="message"
            onInsert={setDraft}
            onLocate={(target) => {
              qa.located = target;
            }}
          />
          <div className="composer">
            <textarea
              aria-label="草稿"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
          </div>
        </section>
        <IntentProfileDialog peerUid="fixture" peerName="合成用户" embedded onClose={() => {}} />
      </main>
      <div className="intent-palette">
        {[
          'joy',
          'excitement',
          'admiration',
          'neutral',
          'sadness',
          'anger',
          'anxiety',
          'affection',
          'fatigue',
          'curiosity',
          'shock',
          'aggrieved',
          'irony',
          'anticipation',
          'embarrassed',
        ].map((emotion) => (
          <IntentChips key={emotion} result={{ ...result, emotion }} />
        ))}
        {[0, 1, 2, 3, 4].map((tier) => (
          <AffinityPill key={tier} peerUid={`tier-${tier}`} />
        ))}
      </div>
    </>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
