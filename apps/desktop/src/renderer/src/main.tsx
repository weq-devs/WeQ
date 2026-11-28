import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { TrpcProvider } from './trpc/provider';
import { ensureThemeInitialized } from './state/theme';
import { OverlayAnchorProvider } from './lib/overlayAnchor';
import './styles/index.css';
import './lib/inputModality';
import { BackupStartupGate } from './components/BackupStartupGate';
import { installResourceDiagnostics } from './lib/resourceDiagnostics';
import { RendererErrorBoundary } from './components/RendererErrorBoundary';
import { installDevelopmentErrors } from './lib/developmentErrors';
import { installTouchContextMenu } from './lib/touchContextMenu';
import { IS_MAC, IS_WEB } from './lib/target.shared';
import { installForceClick } from './lib/forceClick';
import './styles/touch-context-menu.css';
import { installDataSaver } from './lib/dataSaver';
import { installMainWorkspacePreload } from './lib/mainWorkspaceLoader';
import { isRemoteClient } from './lib/remoteClient';
import { notifyRemoteReload } from './lib/remoteWebStartup';
import { installAccountBannerRouting } from './lib/accountBanners';
import {
  installDevelopmentReloadNotice,
  type DevelopmentReloadNoticeState,
} from './lib/developmentReloadNotice';

const stopAccountBanners = installAccountBannerRouting();
import.meta.hot?.dispose(stopAccountBanners);

if (IS_MAC && window.weq?.onForceClick) {
  const stop = installForceClick(window, window.weq.onForceClick);
  import.meta.hot?.dispose(stop);
}

if (import.meta.hot) {
  import.meta.hot.data.developmentReloadNotice ??= {};
  const state: DevelopmentReloadNoticeState = import.meta.hot.data.developmentReloadNotice;
  import.meta.hot.dispose(
    installDevelopmentReloadNotice(
      import.meta.hot,
      state,
      isRemoteClient() ? notifyRemoteReload : undefined,
    ),
  );
}

const stopWorkspacePreload = installMainWorkspacePreload();
import.meta.hot?.dispose(stopWorkspacePreload);

const stopDataSaver = installDataSaver();
import.meta.hot?.dispose(stopDataSaver);

const stopTouchContextMenu = installTouchContextMenu(
  document,
  IS_WEB ? undefined : '[data-weq-touch-context]',
);
import.meta.hot?.dispose(stopTouchContextMenu);

const stopDevelopmentErrors = installDevelopmentErrors(
  window,
  import.meta.env.DEV,
  (level, message, context) => window.weq?.debugLog?.(level, message, context),
);
import.meta.hot?.dispose(stopDevelopmentErrors);

const root = document.getElementById('root');
if (!root) throw new Error('root element missing');

ensureThemeInitialized();
const stopResourceDiagnostics = installResourceDiagnostics();
import.meta.hot?.dispose(stopResourceDiagnostics);

createRoot(root).render(
  <StrictMode>
    <RendererErrorBoundary>
      <TrpcProvider>
        <OverlayAnchorProvider>
          <BackupStartupGate>
            <App />
          </BackupStartupGate>
        </OverlayAnchorProvider>
      </TrpcProvider>
    </RendererErrorBoundary>
  </StrictMode>,
);
