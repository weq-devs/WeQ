/**
 * `InjectHook` — the seam that turns a running QQ pid into a state where the
 * hook can send OIDB packets (instance key / rkey / clientkey flows).
 *
 * Why a seam: the two platforms need different work to reach "sendable":
 *   - **win32**: inject the embedded hook. The MSF service address is resolved
 *     by port-probe, so a fetch can follow immediately.
 *   - **linux**: injection needs root (ptrace), so it is done by a
 *     pkexec-elevated child (see the desktop app's `inject_elevation`). And the
 *     hook can only learn the MSF service address from a *genuine post-login
 *     recv packet*, so `waitForRealPacket` must succeed before any packet is
 *     sent. That elevated + wait logic lives in the app layer; this default
 *     covers the win32 (and any non-elevated) path.
 *
 * Call sites (`AccountMonitorService`, the bootstrap router) depend only on
 * this interface, so they carry no per-platform branch. The hook owns its own
 * idempotency: `ensure` no-ops once a pid is ready; `reset` forgets a pid so a
 * failed fetch (native client died — QQ relaunched / hook unloaded) can force a
 * fresh inject on the next `ensure`.
 */

import type { NtHelperBinding } from '@weq/native';

export interface InjectHook {
  /**
   * Do ONLY the platform inject half (linux: the pkexec-elevated ptrace inject,
   * which pops the polkit password dialog; win32: the in-process embedded
   * inject). Does NOT run linux's post-login packet wait. Idempotent — a no-op
   * once the pid is already injected.
   *
   * Split out from {@link ensure} so a caller can time the two halves
   * separately: the password dialog can take arbitrarily long and should NOT
   * count against a "how long has the packet wait stalled" timer. Await this
   * first (untimed), then race {@link ensure}/the fetch against a stall timer.
   */
  inject(pid: number): Promise<void>;
  /**
   * Inject into `pid` (elevating if the platform needs it) and make it ready to
   * send OIDB packets — i.e. {@link inject} followed by linux's wait-for-packet.
   * Idempotent — a no-op once the pid is already ready, and skips the inject
   * half if {@link inject} already ran for this pid. Throws if injection or the
   * readiness wait fails; callers surface that.
   */
  ensure(pid: number): Promise<void>;
  /** Forget cached inject + readiness for `pid` so the next call re-injects. */
  reset(pid: number): void;
}

/**
 * The default hook: inject the embedded hook in-process and treat the pid as
 * immediately sendable. Correct for win32 (and used as the fallback whenever no
 * platform-specific hook is supplied). Not for linux — see {@link InjectHook}.
 */
export function createDirectInjectHook(nt: NtHelperBinding): InjectHook {
  const injected = new Set<number>();
  const doInject = async (pid: number): Promise<void> => {
    if (injected.has(pid)) return;
    await nt.injectAndGetStatusEmbedded(pid);
    injected.add(pid);
  };
  return {
    inject: doInject,
    // win32 has no packet-wait half, so ensure == inject.
    ensure: doInject,
    reset(pid: number): void {
      injected.delete(pid);
    },
  };
}
