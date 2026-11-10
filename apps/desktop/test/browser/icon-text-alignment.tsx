import { createRoot } from 'react-dom/client';
import { DialogHost, useDialog } from '../../src/renderer/src/components/Dialog';
import { ToastHost, useToast } from '../../src/renderer/src/components/Toast';
import { McpServerSection } from '../../src/renderer/src/components/settings/McpServerSection';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import '../../src/renderer/src/styles/index.css';

ensureThemeInitialized();
Object.assign(window, {
  alignmentQa: {
    theme: useThemeStore,
    show(kind: 'info' | 'warning' | 'error' | 'password', title: string) {
      const dialog = useDialog.getState();
      if (kind === 'password') void dialog.promptPassword(title, '合成密码提示');
      else if (kind === 'warning') void dialog.confirm(title, '合成确认提示');
      else if (kind === 'error') dialog.showError(title, '合成错误提示');
      else dialog.showInfo(title, '合成信息提示');
      useToast.setState({ toasts: [], leaving: [] });
      useToast.getState().push({
        tone: kind === 'password' ? 'success' : kind,
        durationKind: 'long',
        title,
        detail: '合成通知详情',
        ttl: 0,
      });
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <>
    <style>{`html,body,#root{min-height:100%;margin:0;background:var(--weq-chat-bg)}`}</style>
    <main className="weq-set" style={{ padding: 16 }}>
      <McpServerSection />
    </main>
    <DialogHost />
    <ToastHost />
  </>,
);
