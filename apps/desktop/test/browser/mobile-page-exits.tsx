import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DatabaseBrowserWindowHost } from '../../src/renderer/src/components/DatabaseBrowserWindow';
import { LogPerformanceWindowHost } from '../../src/renderer/src/components/LogPerformanceWindow';
import { SettingsDialog } from '../../src/renderer/src/components/SettingsDialog';
import { AnalysisReportPage } from '../../src/renderer/src/views/analysis/AnalysisReportPage';
import { CaptureWindowHost } from '../../src/renderer/src/components/CaptureWindow';
import { DbRepairWindowHost } from '../../src/renderer/src/components/DbRepairWindow';
import { DialogHost } from '../../src/renderer/src/components/Dialog';
import { useDialog } from '../../src/renderer/src/components/Dialog.shared';
import {
  AnnouncementCenter,
  AnnouncementEntry,
} from '../../src/renderer/src/components/AnnouncementCenter';
import { MobileNavigationRuntime } from '../../src/renderer/src/components/MobileNavigationRuntime';
import { WorkspaceContent, WorkspacePages } from '../../src/renderer/src/components/WorkspacePages';
import { BootstrapShell } from '../../src/renderer/src/views/BootstrapView';
import { useDatabaseBrowserWindow } from '../../src/renderer/src/state/databaseBrowserWindow';
import { useLogPerformanceWindow } from '../../src/renderer/src/state/logPerformanceWindow';
import { useCaptureWindow } from '../../src/renderer/src/state/captureWindow';
import { useDbRepairWindow } from '../../src/renderer/src/state/dbRepairWindow';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import { useViewState } from '../../src/renderer/src/state/view';
import { useMobileBack, mobileBack } from '../../src/renderer/src/hooks/useMobileNavigation';
import { seedMobileSurfaceData } from './mobile-surfaces.stub';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/mobile-web.css';

ensureThemeInitialized();
useViewState.setState({ openedUin: '10001' });
const noop = () => {};
const announcement = {
  id: 'fixture-announcement',
  title: '合成公告标题',
  level: 'normal',
  publishedAt: '2026-11-18T16:00:00Z',
  unread: false,
};
seedMobileSurfaceData({
  'announcements.list': { status: 'ready', entries: [announcement], unread: 0, reminder: null },
  'announcements.detail': { ...announcement, body: '合成公告正文', releasePageUrl: null },
});

function Fixture() {
  const [settings, setSettings] = useState(false);
  const [analysis, setAnalysis] = useState(false);
  const [categoryReturns, setCategoryReturns] = useState(0);
  const base = useRef<HTMLElement>(null);
  useMobileBack(
    !settings,
    () => setCategoryReturns((value) => value + 1),
    30,
    () => base.current,
  );
  Object.assign(window, {
    mobilePageExitsQa: {
      open: (kind: string) => {
        if (kind === 'database') useDatabaseBrowserWindow.getState().open();
        else if (kind === 'capture') useCaptureWindow.getState().open('fixture', '10001');
        else if (kind === 'repair')
          useDbRepairWindow.getState().open({ uin: '10001', name: '合成账号', avatarUrl: '' });
        else if (kind === 'analysis') setAnalysis(true);
        else if (kind === 'settings') setSettings(true);
        else useLogPerformanceWindow.getState().open(kind === 'logs' ? 'logs' : 'performance');
      },
      confirm: () => void useDialog.getState().confirm('合成确认', '合成内容'),
      theme: useThemeStore,
      back: mobileBack,
      categoryReturns,
    },
  });
  return (
    <>
      <style>
        {
          'html,body,#root{height:100%;margin:0;overflow:hidden}.fixture-base{height:100%;display:flex;flex-direction:column}'
        }
      </style>
      <main className="weq-web-shell fixture-base" ref={base}>
        <MobileNavigationRuntime root={base} />
        <WorkspacePages navigationKey="fixture">
          <WorkspaceContent>
            <AnnouncementEntry placement="mobile" />
            <label>
              原列表筛选
              <input aria-label="原列表筛选" defaultValue="保留筛选" />
            </label>
            <div style={{ overflow: 'auto', height: 100 }} data-scroll>
              <div style={{ height: 1000 }}>原列表现场</div>
            </div>
          </WorkspaceContent>
          <SettingsDialog
            open={settings}
            initialSection="account"
            onClose={() => setSettings(false)}
            onOpenMaintenance={noop}
            onOpenRecalls={noop}
          />
        </WorkspacePages>
      </main>
      <DatabaseBrowserWindowHost />
      {analysis && (
        <AnalysisReportPage
          request={{
            id: 'fixture',
            kind: 'buddy',
            name: '合成好友名称'.repeat(10),
            peerUid: 'u_fixture',
            period: '合成期间',
            scope: { expectedAccountUin: '10001', expectedAccountConfigId: 'fixture' },
          }}
          onClose={() => setAnalysis(false)}
        />
      )}
      <LogPerformanceWindowHost />
      <CaptureWindowHost />
      <DbRepairWindowHost />
      <DialogHost />
    </>
  );
}
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient()}>
    <AnnouncementCenter active canOpenUpdateSettings={false}>
      {new URLSearchParams(location.search).has('startup') ? (
        <BootstrapShell ready showWindowActions={false}>
          <AnnouncementEntry placement="startup" />
        </BootstrapShell>
      ) : (
        <Fixture />
      )}
    </AnnouncementCenter>
  </QueryClientProvider>,
);
