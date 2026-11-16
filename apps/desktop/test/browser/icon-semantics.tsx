import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SiQzone } from 'react-icons/si';
import { AppSearchResults } from '../../src/renderer/src/components/search/AppSearchResults';
import { APP_SEARCH_ENTRIES } from '../../src/renderer/src/components/search/appSearchCatalog';
import { SettingsDialog } from '../../src/renderer/src/components/SettingsDialog';
import type { SettingsPageId } from '../../src/renderer/src/components/settings/navigation';
import { WorkspaceContent, WorkspacePages } from '../../src/renderer/src/components/WorkspacePages';
import { FEATURE_ICONS } from '../../src/renderer/src/lib/featureIcons';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/mobile-web.css';

const noop = () => {};
const selected: string[] = [];
const QzoneIcon = FEATURE_ICONS.qzone;
const entries = [
  '主页',
  'QQ 空间',
  'QQ 邮箱',
  '频道私聊',
  '年度报告',
  'WeQ 助手',
  '导出',
  '拉取漫游消息',
].map((title) => APP_SEARCH_ENTRIES.find((entry) => entry.id === `feature:${title}`)!);
ensureThemeInitialized();

function Fixture() {
  const [mode, setMode] = useState<'search' | 'settings' | 'brand'>('search');
  const [section, setSection] = useState<SettingsPageId>('qzone');
  Object.assign(window, {
    iconQa: {
      theme: useThemeStore,
      selected,
      show: (mode: 'search' | 'settings' | 'brand', section?: SettingsPageId) => {
        if (section) setSection(section);
        setMode(mode);
      },
    },
  });
  return (
    <WorkspacePages navigationKey="icon-qa">
      <div
        className="weq-web-shell"
        style={{ height: '100dvh', display: 'flex', flexDirection: 'column' }}
      >
        {mode === 'settings' ? (
          <>
            <WorkspaceContent>{null}</WorkspaceContent>
            <SettingsDialog
              key={section}
              open
              initialSection={section}
              onClose={noop}
              onOpenMaintenance={noop}
            />
          </>
        ) : mode === 'search' ? (
          <main
            style={{
              width: '100%',
              maxWidth: 680,
              margin: '0 auto',
              padding: 16,
              boxSizing: 'border-box',
            }}
          >
            <AppSearchResults
              keyword=""
              entries={entries}
              expanded
              onExpand={noop}
              onSelect={(entry) => selected.push(entry.id)}
            />
          </main>
        ) : (
          <main style={{ padding: 24 }}>
            {[16, 22, 44].map((size) => (
              <div key={size} style={{ display: 'flex', gap: 16 }}>
                <div
                  data-brand-reference={size}
                  style={{ width: 64, height: 64, display: 'grid', placeItems: 'center' }}
                >
                  <SiQzone size={size} />
                </div>
                <div
                  data-brand-actual={size}
                  style={{ width: 64, height: 64, display: 'grid', placeItems: 'center' }}
                >
                  <QzoneIcon size={size} strokeWidth={1.8} />
                </div>
              </div>
            ))}
          </main>
        )}
      </div>
    </WorkspacePages>
  );
}

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={client}>
    <Fixture />
  </QueryClientProvider>,
);
