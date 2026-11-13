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
import { IS_WEB } from './lib/target';
import './styles/touch-context-menu.css';
import { installDataSaver } from './lib/dataSaver';
import { installMainWorkspacePreload } from './lib/mainWorkspaceLoader';

const stopWorkspacePreload = installMainWorkspacePreload();
import.meta.hot?.dispose(stopWorkspacePreload);

const stopDataSaver = installDataSaver();
import.meta.hot?.dispose(stopDataSaver);

if (IS_WEB) {
  const stopTouchContextMenu = installTouchContextMenu(document);
  import.meta.hot?.dispose(stopTouchContextMenu);
}

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
