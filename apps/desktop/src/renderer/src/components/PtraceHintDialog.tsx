/**
 * Linux ptrace 保护引导弹窗。
 *
 * 主进程在「无 ptrace 权限、无法直接注入 QQ」时发 `ptrace:confirm-hint`，
 * 渲染层弹出本弹窗，引导用户关闭 yama ptrace 保护：
 *   - 「我已关闭，重新尝试」→ 回传 `retry`，主进程再次尝试无特权注入；
 *   - 「不再提醒，直接提权」→ 回传 `no-remind`，写入 global_config 后走 pkexec；
 *   - 关闭弹窗（✕ / ESC）→ 回传 `skip`，本次直接走 pkexec、不记忆。
 *
 * 复用 <Modal> 外壳（遮罩 / ESC / 动画），按钮同排、教程两步用虚线分隔。
 */

import { useEffect, useState, type ReactElement } from 'react';
import { BellOff, RotateCw, ShieldAlert } from 'lucide-react';
import { Modal } from './Dialog';
import type { PtraceHintChoice } from '@weq/service';

function ipc():
  | {
      on(ch: string, cb: (...a: unknown[]) => void): (() => void) | undefined;
      send(ch: string, ...a: unknown[]): void;
    }
  | undefined {
  return (window as unknown as { electron?: { ipcRenderer?: ReturnType<typeof ipc> } }).electron
    ?.ipcRenderer;
}

export function PtraceHintDialog(): ReactElement | null {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const off = ipc()?.on('ptrace:confirm-hint', () => {
      setOpen(true);
    });
    return () => {
      if (typeof off === 'function') off();
    };
  }, []);

  function respond(choice: PtraceHintChoice): void {
    setOpen(false);
    ipc()?.send('ptrace:respond-hint', choice);
  }

  if (!open) return null;

  return (
    <Modal onClose={() => respond('skip')} labelledBy="weq-ptrace-title" width={440}>
      <div className="weq-ptrace">
        <header className="weq-ptrace-head">
          <h3 id="weq-ptrace-title" className="weq-ptrace-title">
            需要关闭 ptrace 保护
          </h3>
          <p className="weq-ptrace-sub">
            Linux 默认开启的 yama ptrace 保护会阻止 WeQ 向正在运行的 QQ 注入，导致无法读取密钥。
            关闭后即可免密码直接注入，无需每次输入管理员授权。
          </p>
        </header>

        <ol className="weq-ptrace-steps">
          <li className="weq-ptrace-step">
            <span className="weq-ptrace-step-title">
              <span className="weq-ptrace-step-num" aria-hidden>
                1
              </span>
              临时关闭（重启后失效）
            </span>
            <code className="weq-ptrace-cmd">
              echo 0 | sudo tee /proc/sys/kernel/yama/ptrace_scope
            </code>
          </li>
          <li className="weq-ptrace-step">
            <span className="weq-ptrace-step-title">
              <span className="weq-ptrace-step-num" aria-hidden>
                2
              </span>
              永久关闭
            </span>
            <code className="weq-ptrace-cmd"># 写入/etc/sysctl.d/10-ptrace.conf
              <br /> # kernel.yama.ptrace_scope = 0
              <br /> # 然后执行如下命令
              <br /> sudo sysctl -p /etc/sysctl.d/10-ptrace.conf
            </code>
          </li>
        </ol>

        <p className="weq-ptrace-note">
          关闭后同用户下的进程可以调试你的程序，请仅在信任的本机启用。
        </p>

        <div className="weq-ptrace-actions">
          <button
            type="button"
            className="weq-ptrace-opt weq-ptrace-opt-primary"
            onClick={() => void respond('retry')}
          >
            <RotateCw size={17} strokeWidth={2.5} aria-hidden />
            <span>重新尝试</span>
          </button>
          <button
            type="button"
            className="weq-ptrace-opt weq-ptrace-opt-danger"
            onClick={() => void respond('no-remind')}
          >
            <BellOff size={17} strokeWidth={2.5} aria-hidden />
            <span>不再提醒</span>
          </button>
        </div>

        <p className="weq-ptrace-foot">
          <ShieldAlert size={13} strokeWidth={1.85} aria-hidden />
          关闭弹窗将本次直接请求授权，且不会记住选择。
        </p>
      </div>
    </Modal>
  );
}
