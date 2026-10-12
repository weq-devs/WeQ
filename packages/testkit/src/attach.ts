/**
 * Read a running QQ pid's memory (its session material), for local probe
 * scripts.
 *
 * The native `scanSessionMaterial(pid)` does the whole job: RTTI-driven
 * runtime bootstrap, no hardcoded RVA, returning the session's a2 / d2 / d2key.
 * The device guid is not part of this — it is read offline from the QQ data
 * root (`readDeviceGuid`), no privilege needed. The only prerequisite is privilege — reading another
 * process's memory is a ptrace attach (Linux: root or CAP_SYS_PTRACE with yama
 * letting it through; macOS: root AND SIP off, since QQ runs hardened). The
 * desktop app spawns a sudo child for this; a probe script is simply run under
 * sudo.
 *
 * This helper does NOT demand root unconditionally: like the desktop's
 * `runUnprivilegedAttach`, it tries the direct (in-process) read first. With
 * yama already permissive (`ptrace_scope=0`) or when the caller already has
 * CAP_SYS_PTRACE, no escalation is needed; only a real EPERM/EACCES refusal
 * produces the actionable "run under sudo" error.
 */

/** The slice of `NtHelperBinding` this module needs. Structural to avoid a
 * dependency cycle — `@weq/native` already devDepends on this package. */
export interface AttachableNative {
  scanSessionMaterial(pid: number): Promise<{
    a2?: string;
    d2?: string;
    d2Key?: string;
  }>;
}

/** 一次读取的产出（与 `@weq/native` 的 `SessionMaterial` 同形）。 */
export type AttachedMaterial = Awaited<ReturnType<AttachableNative['scanSessionMaterial']>>;

export interface EnsureAttachedOptions {
  /** Prefix for progress lines, e.g. `'self-dress'`. Omit to stay quiet. */
  label?: string;
}

/**
 * Read `pid`'s session material and return it. Throws with an actionable
 * message when the platform prerequisites (root) are unmet.
 */
export async function ensureAttached(
  nt: AttachableNative,
  pid: number,
  uin: string,
  opts: EnsureAttachedOptions = {},
): Promise<AttachedMaterial> {
  const say = (msg: string): void => {
    if (opts.label) console.log(`[${opts.label}] ${msg}`);
  };

  say(`读取 pid=${pid} 的会话物料 (uin=${uin}) ...`);
  let material: Awaited<ReturnType<AttachableNative['scanSessionMaterial']>>;
  try {
    // Try the direct (in-process) read first — ptrace_scope=0 / CAP_SYS_PTRACE
    // make it succeed without any elevation. Mirrors the desktop flow.
    material = await nt.scanSessionMaterial(pid);
  } catch (error) {
    if (isPermissionDenied(error)) {
      throw new Error(
        '读别的进程内存被内核拒绝（ptrace attach）。二选一：\n' +
          '  a) 临时放行：sudo sysctl kernel.yama.ptrace_scope=0（或对该 pid 授权）\n' +
          '  b) 提权运行本脚本：sudo -E node --import tsx <script>',
      );
    }
    throw error;
  }
  // 只报「有没有」——物料本身就是凭据。
  say(
    `读取结果: a2=${material.a2 ? 'yes' : 'no'} d2=${material.d2 ? 'yes' : 'no'} ` +
      `d2key=${material.d2Key ? 'yes' : 'no'}`,
  );
  return material;
}

/** Classify a ptrace failure as "needs privilege" from its message/code. */
function isPermissionDenied(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string } | undefined)?.code;
  return (
    code === 'EPERM' ||
    code === 'EACCES' ||
    /\bEPERM\b|\bEACCES\b|Operation not permitted|Permission denied|ptrace/i.test(message)
  );
}
