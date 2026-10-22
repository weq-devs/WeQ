import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { TrpcProvider } from './trpc/provider';
import { ensureThemeInitialized } from './state/theme';
import { OverlayAnchorProvider } from './lib/overlayAnchor';
import './styles/index.css';
import { BackupStartupGate } from './components/BackupStartupGate';

const root = document.getElementById('root');
if (!root) throw new Error('root element missing');

ensureThemeInitialized();

createRoot(root).render(
  <StrictMode>
    <TrpcProvider>
      <OverlayAnchorProvider>
        <BackupStartupGate>
          <App />
        </BackupStartupGate>
      </OverlayAnchorProvider>
    </TrpcProvider>
  </StrictMode>,
);
