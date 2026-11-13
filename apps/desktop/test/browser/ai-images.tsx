import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, Suspense } from 'react';
import {
  AiImagePreferenceSetting,
  DefaultVisionModelRow,
} from '../../src/renderer/src/components/settings/AiImageSettings';
import { ContentSelectionProvider } from '../../src/renderer/src/state/contentSelection';
import { useViewState } from '../../src/renderer/src/state/view';
import { imageRequests } from './ai-images.stub';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/im-template/styles.css';
import '../../src/renderer/src/styles/agentlab-workspace.css';
import '../../src/renderer/src/styles/assistant-conversation.css';

useViewState.setState({ openedUin: '10000' });
const CloneChatPanel = lazy(() =>
  import('../../src/renderer/src/views/agentlab/CloneChatPanel').then((module) => ({
    default: module.CloneChatPanel,
  })),
);
const GroupChatPanel = lazy(() =>
  import('../../src/renderer/src/views/agentlab/GroupChatPanel').then((module) => ({
    default: module.GroupChatPanel,
  })),
);
const AssistantPanel = lazy(() =>
  import('../../src/renderer/src/views/agentlab/AssistantPanel').then((module) => ({
    default: module.AssistantPanel,
  })),
);
Object.assign(window, { imageRequests: () => imageRequests });
const surface = new URLSearchParams(location.search).get('surface') ?? 'assistant';
const noop = () => {};
function Page() {
  if (surface === 'settings')
    return (
      <main className="weq-set" style={{ maxWidth: 800, padding: 16, margin: 'auto' }}>
        <DefaultVisionModelRow />
        {(
          ['assistant', 'cloneChat', 'cloneTraining', 'intent', 'suggestions', 'profile'] as const
        ).map((feature) => (
          <section key={feature} aria-label={feature}>
            <h3>{feature}</h3>
            <AiImagePreferenceSetting feature={feature} />
          </section>
        ))}
      </main>
    );
  return (
    <main
      className={surface === 'assistant' ? 'weq-assistant-main-conversation' : undefined}
      style={{ height: '100dvh', display: 'flex', flexDirection: 'column', minHeight: 0 }}
    >
      {surface === 'clone' ? (
        <CloneChatPanel
          personaId="p"
          persona={{
            id: 'p',
            name: '合成克隆',
            sourceId: 'peer',
            sourceTitle: '合成来源',
            models: { chat: { useDefault: true } },
          }}
          modelLabel="合成模型"
          selfUin="10000"
          onBack={noop}
          onOpenSettings={noop}
        />
      ) : surface === 'group' ? (
        <GroupChatPanel
          groupId="g"
          selfUin="10000"
          personaList={[{ id: 'p', name: '合成克隆', sourceId: 'peer' }]}
          profileByUid={new Map()}
          faceDescToId={new Map()}
          onBack={noop}
          onDeleted={noop}
        />
      ) : (
        <AssistantPanel
          sessionId="a"
          draftAccount="10000"
          workspaceTitle="WeQ 助手"
          chatModels={[
            {
              key: 'fixture',
              providerId: 'fixture',
              model: 'visual-fixture',
              label: '合成视觉模型',
            },
          ]}
          onSessionCreated={noop}
          onBack={noop}
        />
      )}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ContentSelectionProvider>
      <Suspense fallback={<span>加载中</span>}>
        <Page />
      </Suspense>
    </ContentSelectionProvider>
  </QueryClientProvider>,
);
