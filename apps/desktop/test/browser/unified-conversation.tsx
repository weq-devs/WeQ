import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AssistantPanel } from '../../src/renderer/src/views/agentlab/AssistantPanel';
import { OfficialConversationPane } from '../../src/renderer/src/components/OfficialConversationPane';
import { GuildDirectDialog } from '../../src/renderer/src/components/GuildDirectDialog';
import { ChatPane } from '../../src/renderer/src/im-template/template/chatPane';
import { ContentSelectionProvider } from '../../src/renderer/src/state/contentSelection';
import { PageSnapshots } from '../../src/renderer/src/components/PageSnapshots';
import { DialogHost } from '../../src/renderer/src/components/Dialog';
import { OverlayAnchorProvider } from '../../src/renderer/src/lib/overlayAnchor';
import { useThemeStore } from '../../src/renderer/src/state/theme';
import { createTemplateDemoData } from '../support/templateDemoData';
import { requests } from './unified-conversation.stub';
import { DATALINE_UID_TO_DEVICE } from '@weq/codec';
import { deviceAvatarDataUri } from '../../src/renderer/src/lib/deviceAvatar';
import type { Conversation } from '../../src/renderer/src/im-template/template/types';
import '../../src/renderer/src/styles/index.css';

const demo = createTemplateDemoData();
const noop = () => {};
const kind = new URLSearchParams(location.search).get('kind') ?? 'assistant';
Object.assign(window, {
  unifiedRequests: () => requests,
  unifiedTheme: (theme: 'light' | 'dark') => useThemeStore.getState().setPreference(theme),
});
const direct = demo.conversations.find((row) => row.type === 'direct')!;
const group = demo.conversations.find((row) => row.type === 'group')!;
const deviceId = Object.entries(DATALINE_UID_TO_DEVICE).find(
  ([, device]) => device === 'phone',
)![0];
const device: Conversation = {
  ...direct,
  type: 'direct',
  id: deviceId,
  chatType: 8,
  group: null,
  members: [],
  otherUser: {
    ...direct.otherUser!,
    id: deviceId,
    username: deviceId,
    displayName: '我的手机',
    identityLabel: '设备',
    identityValue: deviceId,
    avatarUrl: deviceAvatarDataUri(deviceId),
  },
};
const nativeConversation = kind === 'group' ? group : kind === 'dataline' ? device : direct;
const nativeMessages = demo.messages
  .filter((row) => row.conversationId === (kind === 'group' ? group.id : direct.id))
  .map((row) =>
    kind === 'dataline' && device.type === 'direct'
      ? {
          ...row,
          conversationId: device.id,
          senderId: row.senderId === demo.user.id ? demo.user.id : device.otherUser.id,
          sender: row.senderId === demo.user.id ? demo.user : device.otherUser,
        }
      : row,
  );
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <OverlayAnchorProvider>
      <PageSnapshots scope="unified-fixture">
        <ContentSelectionProvider>
          <style>
            {
              'html,body,#root{height:100%;margin:0}#root{display:flex;min-width:0}#root>.chat-pane{width:100%}'
            }
          </style>
          <DialogHost />
          {kind === 'assistant' ? (
            <AssistantPanel
              sessionId="session"
              chatModels={[]}
              onBack={noop}
              onSessionCreated={noop}
              draftAccount="synthetic"
              workspaceTitle="合成助手会话"
            />
          ) : kind === 'official' || kind === 'service' ? (
            <OfficialConversationPane
              user={demo.user}
              conversationId={kind === 'service' ? 'service:77' : 'u_official'}
              title={kind === 'service' ? '合成服务号' : '合成公众号'}
              onBack={noop}
            />
          ) : kind === 'guild' ? (
            <GuildDirectDialog
              open
              embedded
              chatOnly
              selfUser={demo.user}
              onClose={noop}
              searchTarget={{ nodeId: '77', msgId: '', msgSeq: '', revision: '1' }}
            />
          ) : (
            <ChatPane
              user={demo.user}
              conversation={nativeConversation}
              messages={nativeMessages}
              loading={false}
              preference={undefined}
              draft=""
              onDraftChange={noop}
              onDraftClear={noop}
              onSend={async () => {}}
              onBack={noop}
              sendAvailable={false}
            />
          )}
        </ContentSelectionProvider>
      </PageSnapshots>
    </OverlayAnchorProvider>
  </QueryClientProvider>,
);
