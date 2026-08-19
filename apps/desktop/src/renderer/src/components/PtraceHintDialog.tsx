/**
 * Linux ptrace 保护引导弹窗。
 *
 * 主进程在「无 ptrace 权限、无法直接注入 QQ」时发 `ptrace:confirm-hint`，
 * 渲染层弹出本弹窗，引导用户关闭 yama ptrace 保护：
 *   - 「我已关闭，重新尝试」→ 回传 `retry`，主进程再次尝试无特权注入；
 *   - 「不再提醒，直接提权」→ 回传 `no-remind`，写入 global_config 后走 pkexec；
 *   - 关闭弹窗（✕ / ESC）→ 回传 `skip`，本次直接走 pkexec、不记忆。
 *
 * 复用 <Modal> 外壳（遮罩 / ESC / 动画）与 weq-close 的选项卡片视觉语言。
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
          <li>
            临时关闭（重启后失效）：
            <code className="weq-ptrace-cmd">
              echo 0 | sudo tee /proc/sys/kernel/yama/ptrace_scope
            </code>
          </li>
          <li>
            永久关闭：写入 <code className="weq-ptrace-cmd">/etc/sysctl.d/10-ptrace.conf</code>
            ，内容为
            <code className="weq-ptrace-cmd">kernel.yama.ptrace_scope = 0</code>
            然后执行
            <code className="weq-ptrace-cmd">sudo sysctl -p /etc/sysctl.d/10-ptrace.conf</code>
          </li>
        </ol>

        <p className="weq-ptrace-note">
          关闭后同用户下的进程可以调试你的程序，请仅在信任的本机启用。
        </p>

        <div className="weq-ptrace-actions">
          <button type="button" className="weq-close-opt" onClick={() => void respond('retry')}>
            <span className="weq-close-opt-ico">
              <RotateCw size={17} strokeWidth={1.85} aria-hidden />
            </span>
            <span className="weq-close-opt-text">
              <strong>我已关闭，重新尝试</strong>
              <span>按上面的方案关闭保护后，直接再次注入。</span>
            </span>
          </button>

          <button type="button" className="weq-close-opt" onClick={() => void respond('no-remind')}>
            <span className="weq-close-opt-ico">
              <BellOff size={17} strokeWidth={1.85} aria-hidden />
            </span>
            <span className="weq-close-opt-text">
              <strong>不再提醒，直接提权</strong>
              <span>以后不再弹出本提示，每次直接请求管理员授权。</span>
            </span>
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
