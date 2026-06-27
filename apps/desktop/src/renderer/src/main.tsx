import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { TrpcProvider } from './trpc/provider';
import { ensureThemeInitialized } from './state/theme';
import './styles/index.css';

const root = document.getElementById('root');
if (!root) throw new Error('root element missing');

ensureThemeInitialized();

createRoot(root).render(
  <StrictMode>
    <TrpcProvider>
      <App />
    </TrpcProvider>
  </StrictMode>,
);
