import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WebConnectionStatus } from '../../src/renderer/src/components/WebConnectionStatus';
import { ToastHost, useToast } from '../../src/renderer/src/components/Toast';
import { useWebConnection } from '../../src/renderer/src/state/webConnection';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import '../../src/renderer/src/styles/index.css';

ensureThemeInitialized();
window.weqRemoteConnection = { state: 'connected' };
window.weqRemoteShell = { openMenu() {} };
useWebConnection.getState().connected();
Object.assign(window, {
  connectionQa: {
    theme: useThemeStore,
    change(state: 'connected' | 'connection' | 'network') {
      window.weqRemoteConnection = { state };
      window.dispatchEvent(new Event('weq-remote-connection'));
    },
    reset() {
      useToast.setState({ toasts: [], leaving: [] });
    },
  },
});
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient()}>
    <WebConnectionStatus />
    <ToastHost />
  </QueryClientProvider>,
);
