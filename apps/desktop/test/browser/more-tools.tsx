import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChatShell } from '../../src/renderer/src/im-template/template/chatShell';
import { WorkspaceContent, WorkspacePages } from '../../src/renderer/src/components/WorkspacePages';
import { WorkspaceTools } from '../../src/renderer/src/components/WorkspaceTools';
import { WorkspaceMenuButton } from '../../src/renderer/src/components/WorkspaceMenuButton';
import { PageSnapshots } from '../../src/renderer/src/components/PageSnapshots';
import { DialogHost } from '../../src/renderer/src/components/Dialog';
import { CompositionWorkspace } from '../../src/renderer/src/components/mergeForward/CompositionWorkspace';
import { useCompositionWindow } from '../../src/renderer/src/hooks/useCompositionWindow';
import { useViewState } from '../../src/renderer/src/state/view';
import { useWorkspaceMenu } from '../../src/renderer/src/state/workspaceMenu';
import { MailWorkspace } from '../../src/renderer/src/views/MailView';
import { ChannelView } from '../../src/renderer/src/views/ChannelView';
import { DressUpDialog } from '../../src/renderer/src/components/DressUpDialog';
import {
  useChatShellController,
  noopChatShellHistoryAdapter,
} from '../../src/renderer/src/im-template/template/shellController';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import type { MainView } from '../../src/renderer/src/im-template/template/types';
import { seedMobileSurfaceData } from './mobile-surfaces.stub';
import '../../src/renderer/src/styles/index.css';

const noop = () => {};
const user = {
  id: 'fixture',
  username: 'fixture',
  displayName: '合成昵称',
  identityValue: '10001',
  identityLabel: 'QQ',
  avatarUrl: null,
};
ensureThemeInitialized();
useViewState.setState({ openedUin: 'fixture' });
seedMobileSurfaceData({ 'bootstrap.getDevelopmentFeatures': { dressTools: true } });
const taskFixture = new URLSearchParams(location.search).has('tasks');
if (taskFixture) {
  useViewState.setState({ openedUin: '10001' });
  seedMobileSurfaceData({
    'bootstrap.getSettings': { exportSaveMode: 'before' },
    'account.listExportTasks': Array.from({ length: 18 }, (_, i) => ({
      id: `export-fixture-${i}`,
      name: `合成聊天 ${i}`,
      kind: 'c2c',
      format: 'txt',
      status: i < 2 ? 'running' : 'completed',
      progress: i < 2 ? 63 : 100,
      current: i < 2 ? 63 : 100,
      total: 100,
      canPause: i < 2,
      stages:
        i === 0
          ? [
              { key: 'dress', label: '合成已完步骤', status: 'completed', current: 1, total: 1 },
              { key: 'message', label: '合成当前步骤', status: 'running', current: 63, total: 100 },
            ]
          : [],
    })),
    'account.listSchedules': [
      {
        id: 'schedule-fixture',
        name: '合成定时计划',
        format: 'txt',
        conversations: [],
        schedule: { mode: 'daily', time: '02:30' },
        options: { range: { preset: 'all' } },
        enabled: true,
        nextRunAt: 1795521600000,
        history: [],
      },
    ],
  });
}

function Fixture() {
  const [dressUpOpen, setDressUpOpen] = useState(false);
  const [mainOpen, setMainOpen] = useState(false);
  const shell = useChatShellController({
    conversations: [],
    contacts: [],
    initialActiveConversationId: null,
    initialView: 'more',
    sidebarWidthStorageKey: 'fixture:more-width',
    history: noopChatShellHistoryAdapter,
  });
  const view: MainView = shell.view;
  const composition = useCompositionWindow();
  Object.assign(window, {
    moreToolsQa: {
      theme: (value: 'light' | 'dark') => useThemeStore.getState().setPreference(value),
      openChat: () => {
        shell.switchView('messages');
        setMainOpen(true);
      },
      openDressUp: () => setDressUpOpen(true),
      focusTask: (id: string) => useWorkspaceMenu.getState().focusTask(`export:${id}`),
    },
  });
  return (
    <WorkspacePages navigationKey={view}>
      <ChatShell
        user={user}
        view={view}
        contactTab="friends"
        activeNotice={null}
        mainOpen={mainOpen}
        sidebarWidth={320}
        query=""
        onQueryChange={noop}
        onViewChange={shell.switchView}
        messageBadgeCount={0}
        contactBadgeCount={0}
        friendNoticeCount={0}
        groupNoticeCount={0}
        onOpenSettings={noop}
        onOpenCollection={noop}
        onOpenDressUp={() => setDressUpOpen(true)}
        onOpenProfile={noop}
        onOpenAbout={noop}
        onOpenInvite={noop}
        onOpenWonderfulTools={noop}
        onOpenAntiRecall={noop}
        onOpenDbRepair={noop}
        onOpenQzoneAlbum={noop}
        onOpenFriendNotices={noop}
        onOpenGroupNotices={noop}
        onContactTabChange={noop}
        onSidebarWidthChange={noop}
        railFooterContent={() => <WorkspaceMenuButton />}
        sidebarContent={null}
        mainContent={
          <WorkspaceContent>
            <p data-secondary-page={view}>合成业务页</p>
            {view === 'mail' && <MailWorkspace active selfUin="10001" />}
            {(view === 'channel' || view === 'guild-direct') && (
              <ChannelView selfUser={user} initialDirectOpen={view === 'guild-direct'} />
            )}
          </WorkspaceContent>
        }
      />
      {dressUpOpen && <DressUpDialog onClose={() => setDressUpOpen(false)} />}
      <WorkspaceTools
        accountScope="fixture"
        footerControls={null}
        onOpenAnalysis={noop}
        onOpenComposition={composition.open}
      />
      <CompositionWorkspace
        popup={composition.popup}
        fallback={composition.fallback}
        onClose={composition.close}
        onPopOut={composition.open}
        self={{ uid: 'u_fixture', uin: '10001', name: '合成昵称' }}
        targets={[]}
        sendAvailable={false}
        onForward={async () => {}}
        onSend={async () => {}}
        onOpenTarget={noop}
      />
    </WorkspacePages>
  );
}
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient()}>
    <PageSnapshots scope={taskFixture ? 'task-navigation-fixture' : null}>
      <Fixture />
      {taskFixture ? <DialogHost /> : null}
    </PageSnapshots>
  </QueryClientProvider>,
);
