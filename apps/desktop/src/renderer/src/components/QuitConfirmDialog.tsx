/**
 * 退出确认框 —— 完全退出 WeQ 时，若仍有后台服务在运行就弹。
 *
 * 取代原来的原生 `dialog.showMessageBox`：那个框不跟主题、没有「不再询问」、
 * 每次退出都弹。现在主进程在 `before-quit` 里通过 `quit:confirm` 把**正在运行的
 * 服务名单**发过来，用户选完后经 `quit:respond` 回传：
 *   - `tray`   只关闭窗口，服务继续跑（等同最小化到托盘）
 *   - `quit`   完全退出（危险色）
 *   - `cancel` 什么都不做
 *   - `remember` 勾了「不再询问」→ 主进程写 `quitConfirmSuppressed`
 *
 * 与 `CloseConfirmDialog`（点 ✕ 的关窗确认）刻意分开：两者触发时机、选项与
 * IPC 通道都不同，合并会把状态机搅成一团。
 */

import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Minimize2, Power } from 'lucide-react';
import { Modal } from './Dialog';
import '../styles/quit-confirm.css';

/** 与主进程 `QuitConfirmChoice` 同一套词汇：`window` = 只关窗口、进程继续。 */
type QuitAction = 'window' | 'quit' | 'cancel';

function ipc():
  | {
      on(ch: string, cb: (...a: unknown[]) => void): (() => void) | undefined;
      send(ch: string, ...a: unknown[]): void;
    }
  | undefined {
  return (window as unknown as { electron?: { ipcRenderer?: ReturnType<typeof ipc> } }).electron
    ?.ipcRenderer;
}

export function QuitConfirmDialog(): ReactElement | null {
  const [open, setOpen] = useState(false);
  const [services, setServices] = useState<string[]>([]);
  const [remember, setRemember] = useState(false);
  // 监听器只注册一次，用 ref 读当前 token，避免因 token 变化重装监听。
  const tokenRef = useRef(0);

  useEffect(() => {
    const bridge = ipc();
    const offConfirm = bridge?.on('quit:confirm', (...args: unknown[]) => {
      const payload = args[1] as { token?: number; services?: string[] } | undefined;
      if (typeof payload?.token !== 'number') return;
      tokenRef.current = payload.token;
      setServices(Array.isArray(payload.services) ? payload.services : []);
      setRemember(false);
      setOpen(true);
    });
    // 主进程放弃等待（超时 / 窗口销毁 / 请求被新的一次合并）时收起，别留一个死框。
    const offCancel = bridge?.on('quit:cancel-confirm', (...args: unknown[]) => {
      const payload = args[1] as { token?: number } | undefined;
      if (payload?.token === tokenRef.current) setOpen(false);
    });
    return () => {
      if (typeof offConfirm === 'function') offConfirm();
      if (typeof offCancel === 'function') offCancel();
    };
  }, []);

  function respond(choice: QuitAction): void {
    setOpen(false);
    ipc()?.send('quit:respond', {
      token: tokenRef.current,
      choice,
      remember: remember && choice !== 'cancel',
    });
  }

  if (!open) return null;

  return (
    <Modal
      onClose={() => respond('cancel')}
      dismissOnOutside={false}
      labelledBy="weq-quit-title"
      width={420}
    >
      <div className="weq-close weq-quit">
        <header className="weq-close-head">
          <h3 id="weq-quit-title" className="weq-close-title">
            退出 WeQ
          </h3>
          <p className="weq-close-sub">
            {services.length
              ? '以下后台服务将停止运行，其他设备将无法再通过它们访问本机。'
              : '完全退出将结束 WeQ 进程。'}
          </p>
        </header>

        {services.length ? (
          <ul className="weq-quit-services" aria-label="将停止的后台服务">
            {services.map((service) => (
              <li key={service}>{service}</li>
            ))}
          </ul>
        ) : null}

        <div className="weq-close-options">
          <button type="button" className="weq-close-opt" onClick={() => respond('window')}>
            <span className="weq-close-opt-ico">
              <Minimize2 size={17} strokeWidth={1.85} aria-hidden />
            </span>
            <span className="weq-close-opt-text">
              <strong>最小化到托盘</strong>
              <span>只关闭窗口，WeQ 与后台服务继续运行。</span>
            </span>
          </button>

          <button type="button" className="weq-close-opt is-danger" onClick={() => respond('quit')}>
            <span className="weq-close-opt-ico">
              <Power size={17} strokeWidth={1.85} aria-hidden />
            </span>
            <span className="weq-close-opt-text">
              <strong>完全退出</strong>
              <span>结束 WeQ 进程，停止全部后台服务。</span>
            </span>
          </button>
        </div>

        <label className="weq-close-remember">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
          />
          <span className="weq-close-remember-box" aria-hidden />
          <span className="weq-close-remember-txt">不再询问，以后直接按本次选择处理</span>
        </label>

        <div className="weq-close-foot">
          <button type="button" className="weq-action-soft" onClick={() => respond('cancel')}>
            取消
          </button>
        </div>
      </div>
    </Modal>
  );
}
