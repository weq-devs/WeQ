import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { X } from 'lucide-react';
import {
  ContactProfileDialog,
  GroupProfileDialog,
} from '../../src/renderer/src/im-template/template/profilePanes';
import { MobileNavigationRuntime } from '../../src/renderer/src/components/MobileNavigationRuntime';
import {
  WorkspaceContent,
  WorkspacePage,
  WorkspacePages,
} from '../../src/renderer/src/components/WorkspacePages';
import { MediaPreviewShell } from '../../src/renderer/src/components/MediaPreviewShell';
import { Modal } from '../../src/renderer/src/components/Dialog';
import { MemberProfileCard } from '../../src/renderer/src/components/MemberProfileCard';
import { ConversationActionsMenu } from '../../src/renderer/src/components/ConversationActionsMenu';
import { useMobileWebViewport } from '../../src/renderer/src/hooks/useMobileWebViewport';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import { createTemplateDemoData } from '../support/templateDemoData';
import previewImage from '@resources/brand/logo.png';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/im-template/styles.css';
import '../../src/renderer/src/styles/mobile-web.css';
import '../../src/renderer/src/styles/annual-report.css';
import '../../src/renderer/src/styles/annual-report-reading.css';

ensureThemeInitialized();
const demo = createTemplateDemoData(0);
const person = {
  ...demo.contacts[0]!,
  id: 'u_fixture',
  uid: 'u_fixture',
  displayName: '合成联系人',
  nick: '合成联系人',
  avatarUrl: null,
};
const group = demo.conversations.find((row) => row.type === 'group')!;
const entries = Array.from({ length: 60 }, (_, index) => `合成条目 ${index}`);

function Fixture() {
  const [surface, show] = useState('contact');
  const root = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLButtonElement>(null);
  useMobileWebViewport(root, true);
  const close = () => show('home');
  Object.assign(window, { safeAreaQa: { show, theme: useThemeStore } });
  const details = !['home', 'media', 'popover', 'card', 'menu', 'report'].includes(surface);
  const toolbar = (
    <header
      data-qa-toolbar
      style={{ display: 'flex', alignItems: 'center', minHeight: 56, padding: '0 12px' }}
    >
      <strong style={{ flex: 1 }}>合成页面</strong>
      <button type="button" title="关闭页面" onClick={close} style={{ width: 44, height: 44 }}>
        <X size={20} />
      </button>
    </header>
  );
  return (
    <div
      ref={root}
      className="app-shell-root weq-web-shell"
      data-mobile-detail={details || undefined}
    >
      <style>{'html,body,#root{height:100%;margin:0;overflow:hidden}'}</style>
      <MobileNavigationRuntime root={root} />
      <header className="weq-mobile-header" style={{ visibility: details ? 'hidden' : undefined }}>
        <strong style={{ flex: 1 }}>WeQ</strong>
        <button
          ref={anchor}
          type="button"
          style={{ width: 44, height: 44 }}
          onClick={() => show('popover')}
        >
          工具
        </button>
      </header>
      <div className="app-shell">
        <main className="chat-main">
          <WorkspaceContent>
            {surface === 'contact' && (
              <ContactProfileDialog contact={person} embedded onClose={close} />
            )}
            {surface === 'group' && (
              <GroupProfileDialog conversation={group} embedded onClose={close} />
            )}
            {surface === 'chat' && (
              <section className="chat-pane">
                <header className="chat-header">
                  <button type="button" style={{ width: 44, height: 44 }}>
                    返回
                  </button>
                  <strong>合成会话</strong>
                </header>
              </section>
            )}
            {surface === 'settings' && (
              <section className="weq-mobile-settings">
                <header className="weq-mobile-settings-header">
                  <button type="button" aria-label="返回设置" onClick={close}>
                    <X size={20} />
                  </button>
                  <strong>设置</strong>
                </header>
              </section>
            )}
            {surface === 'page' && (
              <WorkspacePage title="合成工具" onClose={close}>
                <section>
                  {toolbar}
                  <p>工具正文</p>
                </section>
              </WorkspacePage>
            )}
            {surface === 'sidecar' && (
              <WorkspacePage title="合成侧页" placement="sidecar" onClose={close}>
                <section>
                  {toolbar}
                  <p>侧页正文</p>
                </section>
              </WorkspacePage>
            )}
          </WorkspaceContent>
        </main>
      </div>
      {surface === 'media' && (
        <MediaPreviewShell title="合成媒体" onClose={close}>
          <img src={previewImage} alt="WeQ" width={180} height={180} />
        </MediaPreviewShell>
      )}
      {surface === 'report' && (
        <section className="weq-report-root" data-immersive="true">
          {toolbar}
          <p>合成报告正文</p>
        </section>
      )}
      {surface === 'popover' && (
        <Modal
          presentation="popover"
          anchor={anchor.current}
          width={480}
          title="合成长浮层"
          onClose={close}
        >
          <section style={{ minHeight: 1200, padding: 12 }}>
            {toolbar}
            {entries.map((entry) => (
              <p key={entry}>{entry}</p>
            ))}
          </section>
        </Modal>
      )}
      {surface === 'card' && (
        <MemberProfileCard member={person} anchor={{ x: 1, y: 1 }} onClose={close} />
      )}
      {surface === 'menu' && (
        <ConversationActionsMenu
          x={1}
          y={1}
          onClose={close}
          actions={entries.map((label) => ({ label, icon: <X size={16} />, action: close }))}
        />
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <WorkspacePages>
      <Fixture />
    </WorkspacePages>
  </QueryClientProvider>,
);
