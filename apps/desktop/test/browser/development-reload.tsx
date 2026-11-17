import { createRoot } from 'react-dom/client';
import { ToastHost } from '../../src/renderer/src/components/Toast';
import { installDevelopmentReloadNotice } from '../../src/renderer/src/lib/developmentReloadNotice';
import '../../src/renderer/src/styles/index.css';

if (import.meta.hot) {
  import.meta.hot.data.reloadNotice ??= {};
  import.meta.hot.dispose(
    installDevelopmentReloadNotice(import.meta.hot, import.meta.hot.data.reloadNotice),
  );
}
createRoot(document.getElementById('root')!).render(<ToastHost />);
