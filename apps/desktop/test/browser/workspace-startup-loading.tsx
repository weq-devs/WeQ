import { createRoot } from 'react-dom/client';
import { WorkspaceStartupLoading } from '../../src/renderer/src/components/WorkspaceStartupLoading';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import '../../src/renderer/src/styles/index.css';

ensureThemeInitialized();
Object.assign(window, { startupQa: { theme: useThemeStore } });
createRoot(document.getElementById('root')!).render(<WorkspaceStartupLoading />);
