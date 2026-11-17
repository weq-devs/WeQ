import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatPane } from '../../src/renderer/src/im-template/template/chatPane';
import { createTemplateDemoData } from '../support/templateDemoData';
import { muteQA } from './composer-mute.stub';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/mobile-web.css';

const demo = createTemplateDemoData();
const source = demo.conversations.find((row) => row.type === 'group')!;
const conversation = {
  ...source,
  id: '12345',
  group: { ...source.group, name: '合成禁言群', role: 'member' as const },
};
const sent: string[] = [];
Object.assign(window, { muteQA: { ...muteQA, sent } });
function Scene() {
  const [draft, setDraft] = useState('这段草稿在禁言期间仍然保留，可以继续编辑。');
  return (
    <main style={{ height: '100dvh' }}>
      <ChatPane
        user={demo.user}
        conversation={conversation}
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
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Scene />);
