import { createRoot } from 'react-dom/client';
import { VersionSection } from '../../src/renderer/src/components/settings/VersionSection';
import { EnhancementPacksSection } from '../../src/renderer/src/components/settings/EnhancementPacksSection';
import { MailSettingsSection } from '../../src/renderer/src/components/settings/MailSettingsSection';
import { SidebarHeader } from '../../src/renderer/src/im-template/template/sidebarHeader';
import { CurrentTaskList } from '../../src/renderer/src/components/tasks/CurrentTaskList';
import type { UiTask } from '../../src/renderer/src/views/export/TaskList';
import { SettingsNavigateContext } from '../../src/renderer/src/components/settings/controls.shared';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import { useViewState } from '../../src/renderer/src/state/view';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/im-template/styles/sidebar.css';
import '../../src/renderer/src/styles/workspace-menu.css';

ensureThemeInitialized();
useViewState.setState({ openedUin: '10001' });
const navigations: Array<{ section: string; settingId?: string }> = [];
const tasks: UiTask[] = [
  {
    id: 'completed',
    kind: 'group',
    name: '合成已结束任务',
    format: 'html',
    status: 'completed',
    progress: 100,
    current: 10,
    total: 10,
  },
  {
    id: 'running',
    kind: 'c2c',
    name: '合成进行中任务',
    format: 'html',
    status: 'running',
    progress: 50,
    current: 5,
    total: 10,
  },
];
Object.assign(window, { markerQa: { theme: useThemeStore, navigations } });
const empty = new URLSearchParams(location.search).has('empty');
createRoot(document.getElementById('root')!).render(
  <SettingsNavigateContext.Provider
    value={(section, settingId) => navigations.push({ section, settingId })}
  >
    <style>{`
      html, body, #root { height: auto; min-height: 100%; overflow: auto; }
      main { max-width: 780px; margin: auto; padding: 16px; }
      main > section { margin-bottom: 24px; min-width: 0; }
      .marker-directory { width: min(100%, 320px); }
      .marker-tasks { height: 240px; display: flex; }
    `}</style>
    <main>
      <section data-testid="version">
        <VersionSection />
      </section>
      <section data-testid="enhancements">
        <EnhancementPacksSection />
      </section>
      <section data-testid="mail-settings">
        <MailSettingsSection />
      </section>
      <section className="sidebar marker-directory" data-testid="contacts">
        <SidebarHeader
          user={{
            id: '10001',
            username: '合成用户',
            displayName: '合成用户',
            identityLabel: 'QQ',
            identityValue: '10001',
            avatarUrl: null,
          }}
          view="contacts"
          query=""
          onQueryChange={() => {}}
          onOpenProfile={() => {}}
          onOpenFriendNotices={() => {}}
          onOpenGroupNotices={() => {}}
          contactTab="friends"
          onContactTabChange={() => {}}
          showSearch={false}
          activeNotice={null}
          friendNoticeCount={2}
          groupNoticeCount={1}
        />
      </section>
      <section className="marker-tasks" data-testid="tasks">
        <CurrentTaskList
          exports={empty ? [] : tasks}
          renderExport={(task) => <p>{task.name}</p>}
          layout={innerWidth > 700 ? 'split' : 'compact'}
        />
      </section>
    </main>
  </SettingsNavigateContext.Provider>,
);
