import { FolderOpen, X } from 'lucide-react';
import { DesktopOnly, shellBridge } from '../lib/target';
import { useDialog } from './Dialog';
import { RestrictedModeIndicator } from './RestrictedMode';
import { useToast } from './Toast';
import '../styles/startup-shell.css';

/** 账号页与启动状态页共用窗口操作，关闭行为交给主进程统一处理。 */
export function BootstrapWindowActions() {
  const pushToast = useToast((s) => s.push);
  const showError = useDialog((s) => s.showError);

  const openLogDir = (): void => {
    const bridge = shellBridge();
    if (!bridge) return;
    void bridge
      .openLogDir()
      .then((ok) => {
        if (ok) {
          pushToast({
            tone: 'success',
            title: '已打开日志目录',
            detail: '反馈问题时，可把该目录中的最新日志一并附上。',
          });
        } else {
          showError('打开日志目录失败', '日志目录尚未初始化，请稍后再试。');
        }
      })
      .catch((e) => showError('打开日志目录失败', e instanceof Error ? e.message : String(e)));
  };

  return (
    <div className="weq-shell-actions">
      <RestrictedModeIndicator />
      <DesktopOnly>
        <button
          type="button"
          className="weq-shell-log-btn"
          onClick={openLogDir}
          title="打开日志目录"
          aria-label="打开日志目录"
        >
          <FolderOpen size={16} strokeWidth={1.7} />
        </button>
        <button
          type="button"
          className="weq-shell-close-btn"
          onClick={() => window.electron?.ipcRenderer.send('window-close')}
          title="关闭"
          aria-label="关闭"
        >
          <X size={18} strokeWidth={1.8} />
        </button>
      </DesktopOnly>
    </div>
  );
}
