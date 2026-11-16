import { createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ChatPane } from '../../src/renderer/src/im-template/template/chatPane';
import { createTemplateDemoData } from '../support/templateDemoData';
import { useOverlayLayer } from '../../src/renderer/src/lib/overlayStack';
import { acceptPreferences } from '../../src/renderer/src/lib/clientPreferences';
import { SlashEmojiSettings } from '../../src/renderer/src/components/settings/SlashEmojiSettings';
import { Card } from '../../src/renderer/src/components/settings/controls';
import { patchPreferences } from './slash-emoji.stub';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/mobile-web.css';

const demo = createTemplateDemoData();
const conversation = demo.conversations.find((item) => item.type === 'direct')!;
const sent: string[] = [];
function Probe({ active }: { active: boolean }) {
  const layer = useOverlayLayer(active);
  return active ? (
    <div
      data-qa-overlay
      style={{ position: 'fixed', inset: 0, background: '#2d7043', zIndex: layer }}
    />
  ) : null;
}
function Scene() {
  const [draft, setDraft] = useState('');
  const [revision, setRevision] = useState(0);
  Object.assign(window, {
    slashQA: {
      sent,
      preferences: (slashEmojiEnabled: boolean, slashEmojiAutoReplace: boolean) =>
        acceptPreferences(patchPreferences({ slashEmojiEnabled, slashEmojiAutoReplace })),
      switchConversation: () => {
        setDraft('');
        setRevision((value) => value + 1);
      },
      stress: () => {
        const toast = document.querySelector<HTMLElement>('[data-qa-toast]');
        if (toast) toast.style.display = 'block';
        const host = document.createElement('div');
        document.body.append(host);
        const root = createRoot(host);
        for (let index = 0; index < 3000; index++) {
          flushSync(() => root.render(createElement(Probe, { active: true })));
          flushSync(() => root.render(createElement(Probe, { active: false })));
        }
        flushSync(() => root.render(createElement(Probe, { active: true })));
      },
    },
  });
  if (new URLSearchParams(location.search).has('settings'))
    return (
      <main className="weq-set" style={{ padding: 16 }}>
        <Card title="表情输入">
          <SlashEmojiSettings />
        </Card>
      </main>
    );
  return (
    <main style={{ height: '100dvh' }}>
      <ChatPane
        user={demo.user}
        conversation={{ ...conversation, id: `${conversation.id}:${revision}` }}
        messages={[]}
        loading={false}
        draft={draft}
        onDraftChange={(_id, body) => setDraft(body)}
        onDraftClear={() => setDraft('')}
        onSend={async (_conversation, body) => {
          sent.push(body);
        }}
        onBack={() => {}}
      />
      <button
        className="weq-toast-host"
        data-qa-toast
        style={{
          position: 'fixed',
          top: 16,
          bottom: 'auto',
          right: 16,
          height: 32,
          width: 120,
          display: 'none',
          pointerEvents: 'auto',
        }}
      >
        合成通知
      </button>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Scene />);
