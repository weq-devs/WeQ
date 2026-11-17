import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ContentSelectionProvider } from '../../src/renderer/src/state/contentSelection';
import { AssistantPanel } from '../../src/renderer/src/views/agentlab/AssistantPanel';
import { assistantFixture } from './assistant-resume.stub';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/im-template/styles.css';
import '../../src/renderer/src/styles/assistant-conversation.css';

Object.assign(window, { assistantFixture });
const noop = () => {};
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient()}>
    <ContentSelectionProvider>
      <main className="weq-assistant-main-conversation" style={{ height: '100dvh' }}>
        <AssistantPanel
          sessionId="fixture"
          workspaceTitle="WeQ 助手"
          chatModels={[]}
          onBack={noop}
          onSessionCreated={noop}
        />
      </main>
    </ContentSelectionProvider>
  </QueryClientProvider>,
);
