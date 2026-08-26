/**
 * Linux ptrace 保护引导弹窗。
 *
 * 主进程在「无 ptrace 权限、无法直接注入 QQ」时发 `ptrace:confirm-hint`，
 * 渲染层弹出本弹窗，引导用户关闭 yama ptrace 保护：
 *   - 「重新尝试」→ 回传 `retry`，主进程再次尝试无特权注入；若仍被拒，
 *     用下方输入的密码提权（sudo -S，未输入则再弹标准密码框）；
 *   - 「输入密码并提权」→ 回传 `skip` + 密码，本次直接 sudo 提权、不记忆；
 *   - 「不再提醒」→ 回传 `no-remind` + 密码，写入 global_config 后 sudo 提权；
 *   - 关闭弹窗（✕ / ESC）→ 回传 `cancel`，本次不提权（注入失败）。
 *
 * 密码由本弹窗自绘输入（不再依赖 polkit 系统框），经
 * `ptrace:respond-hint` 回传，主进程用 stdin 喂给 sudo -S。
 */

import { useEffect, useRef, useState, type ReactElement } from 'react';
import { BellOff, RotateCw, ShieldAlert } from 'lucide-react';
import { Modal } from './Dialog';
import type { PtraceHintAnswer, PtraceHintChoice } from '@weq/service';

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
  const [password, setPassword] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const off = ipc()?.on('ptrace:confirm-hint', () => {
      setOpen(true);
      setPassword('');
    });
    return () => {
      if (typeof off === 'function') off();
    };
  }, []);

  function respond(choice: PtraceHintChoice): void {
    setOpen(false);
    setPassword('');
    const answer: PtraceHintAnswer = { choice, password };
    ipc()?.send('ptrace:respond-hint', answer);
  }

  if (!open) return null;

  return (
    <Modal onClose={() => respond('cancel')} labelledBy="weq-ptrace-title" width={440}>
      <div className="weq-ptrace">
        <header className="weq-ptrace-head">
          <h3 id="weq-ptrace-title" className="weq-ptrace-title">
            需要关闭 ptrace 保护
          </h3>
          <p className="weq-ptrace-sub">
            Linux 默认开启的 yama ptrace 保护会阻止 WeQ 向正在运行的 QQ 注入，导致无法读取密钥。
            关闭后即可免密码直接注入；也可以直接输入管理员密码临时提权。
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
            <code className="weq-ptrace-cmd">
              # 写入/etc/sysctl.d/10-ptrace.conf
              <br /> # kernel.yama.ptrace_scope = 0
              <br /> # 然后执行如下命令
              <br /> sudo sysctl -p /etc/sysctl.d/10-ptrace.conf
            </code>
          </li>
        </ol>

        <p className="weq-ptrace-note">
          关闭后同用户下的进程可以调试你的程序，请仅在信任的本机启用。
        </p>

        <label className="weq-ptrace-password">
          <span>管理员密码（不关闭 ptrace 时用于临时提权）</span>
          <input
            ref={inputRef}
            type="password"
            value={password}
            placeholder="管理员密码"
            autoComplete="current-password"
            onChange={(event) => setPassword(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') respond('skip');
            }}
          />
        </label>

        <div className="weq-ptrace-actions">
          <button
            type="button"
            className="weq-ptrace-opt weq-ptrace-opt-primary"
            onClick={() => void respond('retry')}
          >
            <RotateCw size={17} strokeWidth={2.5} aria-hidden />
            <span>重新尝试</span>
          </button>
          <button type="button" className="weq-ptrace-opt" onClick={() => void respond('skip')}>
            <ShieldAlert size={17} strokeWidth={2.5} aria-hidden />
            <span>输入密码并提权</span>
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
          关闭弹窗将本次取消提权；输入密码后回车可临时提权，「不再提醒」会记住选择并提权。
        </p>
      </div>
    </Modal>
  );
}
