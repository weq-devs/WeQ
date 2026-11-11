import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DraftCopiesHost } from '../../src/renderer/src/components/DraftCopiesHost';
import { ClientStateSync } from '../../src/renderer/src/components/ClientStateSync';
import {
  bindAccountState,
  useClientPreferences,
} from '../../src/renderer/src/lib/clientPreferences';
import { useDraftCopies } from '../../src/renderer/src/lib/draftPersistence';
import { useThemeStore } from '../../src/renderer/src/state/theme';
import { useViewState } from '../../src/renderer/src/state/view';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/mobile-web.css';
import '../../src/renderer/src/styles/client-sync.css';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const params = new URLSearchParams(location.search);
const withError = params.get('error') === '1';
useViewState.setState({ openedUin: '10001' });
bindAccountState({ expectedAccountUin: '10001', expectedAccountConfigId: 'fixture' });
Object.assign(window, {
  draftCopiesQa: { theme: useThemeStore, preferences: useClientPreferences },
});

function Fixture() {
  useEffect(() => {
    useDraftCopies.setState({ copiesOpen: 1, copiesCount: 2 });
    if (withError)
      useClientPreferences.setState({
        error: '共享设置读取失败：无法连接电脑端服务，修改暂时只保存在本机。',
      });
  }, []);
  return (
    <QueryClientProvider client={queryClient}>
      <div className="weq-web-shell" style={{ height: '100dvh' }}>
        <p style={{ padding: 16 }}>背景内容</p>
        <DraftCopiesHost />
        <ClientStateSync />
      </div>
    </QueryClientProvider>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
