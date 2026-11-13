/**
 * 关闭确认框 —— 点击标题栏 ✕ 且「关闭行为」为 `ask` 时弹出.
 *
 * 主进程在 `win.on('close')` 里拦截关闭，向渲染层发 `window:confirm-close`
 * （携带 `canMinimizeToTray` 与当前运行中的后台服务名单）。用户选择后：
 *   - 勾了「不再询问」→ 先持久化对应的 windowCloseBehavior；
 *   - 通过 `window:respond-close` 把动作（tray / quit / cancel）回传主进程。
 *
 * 这是**唯一**会询问「退出还是托盘」的地方：Dock 菜单退出、Cmd+Q、托盘
 * 「退出 WeQ」都是明确指令，主进程直接退出，不再弹任何确认框。服务名单
 * 放在这里，是因为「点 ✕」本身并不表达「结束进程」，用户需要知道代价。
 *
 * 复用 <Modal> 外壳（遮罩 / ESC / 动画）保持与全局弹窗一致；两个选项与「记住
 * 选择」沿用设置页的视觉语言（#0099ff 主色、细描边、小圆角）。
 */

import { useEffect, useState, type ReactElement } from 'react';
import { Minimize2, Power } from 'lucide-react';
import { Modal } from './Dialog';
import { CheckPill } from './settings/controls';
import { trpc } from '../trpc/client';
import '../styles/close-confirm.css';

type CloseAction = 'tray' | 'quit' | 'cancel';

function ipc():
  | {
      on(ch: string, cb: (...a: unknown[]) => void): (() => void) | undefined;
      send(ch: string, ...a: unknown[]): void;
    }
  | undefined {
  return (window as unknown as { electron?: { ipcRenderer?: ReturnType<typeof ipc> } }).electron
    ?.ipcRenderer;
}

export function CloseConfirmDialog(): ReactElement | null {
  const [open, setOpen] = useState(false);
  const [canTray, setCanTray] = useState(true);
  const [services, setServices] = useState<string[]>([]);
  const [remember, setRemember] = useState(false);
  const setBehavior = trpc.bootstrap.setWindowCloseBehavior.useMutation();
  const utils = trpc.useUtils();

  useEffect(() => {
    const off = ipc()?.on('window:confirm-close', (...args: unknown[]) => {
      const payload = args[1] as { canMinimizeToTray?: boolean; services?: string[] } | undefined;
      setCanTray(payload?.canMinimizeToTray !== false);
      setServices(Array.isArray(payload?.services) ? payload.services : []);
      setRemember(false);
      setOpen(true);
    });
    return () => {
      if (typeof off === 'function') off();
    };
  }, []);

  async function respond(action: CloseAction): Promise<void> {
    setOpen(false);
    // 「不再询问」：先把选择写进设置，下次直接照此执行（cancel 不记忆）。
    if (remember && action !== 'cancel') {
      try {
        await setBehavior.mutateAsync({ behavior: action });
        await utils.bootstrap.getSettings.invalidate();
      } catch {
        // 记忆失败无伤大雅——本次动作照常执行，最坏下次再问一次。
      }
    }
    ipc()?.send('window:respond-close', action);
  }

  if (!open) return null;

  return (
    <Modal
      onClose={() => void respond('cancel')}
      dismissOnOutside={false}
      labelledBy="weq-close-title"
      width={392}
    >
      <div className="weq-close">
        <header className="weq-close-head">
          <h3 id="weq-close-title" className="weq-close-title">
            关闭 WeQ
          </h3>
          <p className="weq-close-sub">
            {canTray
              ? '可以最小化到系统托盘继续后台运行，或直接完全退出。'
              : '当前系统托盘不可用，本次只能完全退出应用。'}
          </p>
        </header>

        {services.length ? (
          <div className="weq-close-services-wrap">
            <p className="weq-close-services-title">完全退出将停止以下后台服务：</p>
            <ul className="weq-close-services" aria-label="将停止的后台服务">
              {services.map((service) => (
                <li key={service}>{service}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="weq-close-options">
          {canTray ? (
            <button
              type="button"
              className="weq-close-opt"
              onClick={() => void respond('tray')}
              disabled={setBehavior.isLoading}
            >
              <span className="weq-close-opt-ico">
                <Minimize2 size={17} strokeWidth={1.85} aria-hidden />
              </span>
              <span className="weq-close-opt-text">
                <strong>最小化到系统托盘</strong>
                <span>保留后台进程，可从托盘图标随时恢复。</span>
              </span>
            </button>
          ) : null}

          <button
            type="button"
            className="weq-close-opt is-danger"
            onClick={() => void respond('quit')}
            disabled={setBehavior.isLoading}
          >
            <span className="weq-close-opt-ico">
              <Power size={17} strokeWidth={1.85} aria-hidden />
            </span>
            <span className="weq-close-opt-text">
              <strong>完全退出</strong>
              <span>结束 WeQ 进程，停止所有后台服务。</span>
            </span>
          </button>
        </div>

        {/* 复用设置页的 CheckPill，避免再维护一套自绘复选框皮肤。 */}
        <div className="weq-close-remember">
          <CheckPill checked={remember} onChange={setRemember}>
            不再询问，下次直接按本次选择处理
          </CheckPill>
        </div>

        <div className="weq-close-foot">
          <button type="button" className="weq-action-soft" onClick={() => void respond('cancel')}>
            取消
          </button>
        </div>
      </div>
    </Modal>
  );
}
