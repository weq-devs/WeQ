/**
 * `InjectHook` — the seam that turns a running QQ pid into a state where the
 * hook can send OIDB packets (instance key / rkey / clientkey flows).
 *
 * Why a seam: the two platforms inject differently, but "sendable" is now one
 * native call on both:
 *   - **win32**: inject the embedded hook in-process. The MSF service address
 *     is resolved by port-probe, so a fetch can follow immediately.
 *   - **linux**: injection normally needs root (ptrace), so it is done by a
 *     sudo-elevated child (see the desktop app's `inject_elevation`) — unless
 *     the host can ptrace unprivileged (yama ptrace_scope off / CAP_SYS_PTRACE),
 *     in which case the app injects in-process and skips the password dialog.
 *     The native inject call hands the account UIN to the hook over the pipe
 *     and blocks until the hook binds the MSFService instance (~30s), so
 *     injection resolving already means the pid can send. That elevated flow
 *     lives in the app layer; this default covers the win32 (and any
 *     non-elevated) path.
 *
 * The caller must pass the account UIN: the native hook no longer derives it
 * from the process, and on linux it is what the hook uses to bind the right
 * instance. Call sites (`AccountMonitorService`, the bootstrap router) depend
 * only on this interface, so they carry no per-platform branch. The hook owns
 * its own idempotency: `ensure` no-ops once a pid is ready; `reset` forgets a
 * pid so a failed fetch (native client died — QQ relaunched / hook unloaded)
 * can force a fresh inject on the next `ensure`.
 *
 * ⚠️ 完全离线模式（设置 → 账号基础 → 自动注入 QQ）关闭时禁止注入。所有会触发
 * 注入的调用方必须在调用前检查 `userConfig.getSettings().autoInjectQq`（或调用
 * app_context 的 `requireInjectEnabled`）。唯一豁免：登录时的数据库密钥提取
 * （bootstrap 的 `fetchKeyFromInstance` / `prepareInstanceInject`）——那是打开
 * 账号的前提。
 */

import type { NtHelperBinding } from '@weq/native';

export interface InjectHook {
  /**
   * Inject the hook into `pid` and block until it is ready to send OIDB
   * packets. On linux this is the sudo-elevated ptrace inject (password comes
   * from a self-drawn renderer dialog); on win32 it is the in-process embedded
   * inject.
   * The native call itself waits for the hook to bind the MSFService instance
   * via `uin` on linux, so "inject resolved" already means "sendable".
   * Idempotent — a no-op once the pid is already injected.
   *
   * Split out from {@link ensure} so a caller can await the password dialog
   * untimed instead of under a fetch timeout.
   */
  inject(pid: number, uin: string): Promise<void>;
  /**
   * Inject into `pid` and make it ready to send OIDB packets. Same as
   * {@link inject} — linux no longer has a separate post-inject wait, so there
   * is no distinct `ensure` half. Idempotent; throws when injection fails.
   */
  ensure(pid: number, uin: string): Promise<void>;
  /** Forget cached inject state for `pid` so the next call re-injects. */
  reset(pid: number): void;
}

/**
 * The user's answer to the linux ptrace-hint dialog (shown once, when the
 * first unprivileged inject is refused by the kernel):
 *   - `retry`     — user closed yama ptrace protection; try in-process again
 *   - `no-remind` — persist the suppression, then escalate via sudo
 *   - `skip`      — escalate via sudo this time, without remembering
 *   - `cancel`    — close the dialog; do not escalate (inject fails)
 */
export type PtraceHintChoice = 'retry' | 'no-remind' | 'skip' | 'cancel';

/** The hint dialog's answer: the choice plus the password typed in it. */
export interface PtraceHintAnswer {
  choice: PtraceHintChoice;
  /** 提权路径用；用户没输入密码时为空字符串。 */
  password: string;
}

/**
 * The default hook: inject the embedded hook in-process and treat the pid as
 * immediately sendable. Correct for win32 (and used as the fallback whenever no
 * platform-specific hook is supplied). Not for linux — see {@link InjectHook}.
 */
export function createDirectInjectHook(nt: NtHelperBinding): InjectHook {
  const injected = new Set<number>();
  const doInject = async (pid: number, uin: string): Promise<void> => {
    if (injected.has(pid)) return;
    await nt.injectAndGetStatusEmbedded(pid, uin);
    injected.add(pid);
  };
  return {
    inject: doInject,
    // Both platforms reach "sendable" inside the inject call, so ensure == inject.
    ensure: doInject,
    reset(pid: number): void {
      injected.delete(pid);
    },
  };
}
