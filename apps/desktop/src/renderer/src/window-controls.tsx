import { createRoot } from 'react-dom/client';
import { Minus, Square, X } from 'lucide-react';
import { ensureThemeInitialized, useThemeStore } from './state/theme';
import './styles/index.css';
import './styles/window-controls.css';

ensureThemeInitialized();
window.addEventListener('storage', () => useThemeStore.getState().hydrate());

const control = (action: 'minimize' | 'maximize' | 'close') => {
  window.location.href = `weq-window-control:${action}`;
};

createRoot(document.getElementById('root')!).render(
  <header className="weq-native-window-header" onDoubleClick={() => control('maximize')}>
    <span>{new URLSearchParams(window.location.search).get('title') ?? 'WeQ'}</span>
    <div className="app-title-bar-actions">
      <button type="button" title="最小化" aria-label="最小化" onClick={() => control('minimize')}>
        <Minus size={14} />
      </button>
      <button
        type="button"
        title="最大化/还原"
        aria-label="最大化/还原"
        onClick={() => control('maximize')}
      >
        <Square size={12} />
      </button>
      <button
        type="button"
        className="close"
        title="关闭"
        aria-label="关闭"
        onClick={() => control('close')}
      >
        <X size={16} />
      </button>
    </div>
  </header>,
);
