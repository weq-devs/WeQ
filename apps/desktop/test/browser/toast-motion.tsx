import { createRoot } from 'react-dom/client';
import { ToastHost } from '../../src/renderer/src/components/Toast';
import { useToast } from '../../src/renderer/src/components/Toast.shared';
import { useThemeStore } from '../../src/renderer/src/state/theme';
import '../../src/renderer/src/styles/index.css';

Object.assign(window, {
  toastMotion: {
    theme: useThemeStore,
    store: useToast,
    reset() {
      useToast.setState({ toasts: [], leaving: [] });
      for (const [index, title] of ['上方通知', '中间通知', '下方通知'].entries()) {
        useToast.getState().push({
          key: `motion-${index}`,
          title,
          detail: '用于验证不同高度的横幅退出后，其他横幅连续移动。\n'.repeat(4),
          durationKind: 'long',
          ttl: 0,
        });
      }
    },
  },
});
createRoot(document.getElementById('root')!).render(<ToastHost />);
