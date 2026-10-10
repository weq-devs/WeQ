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

  if ((process.platform === 'linux' || process.platform === 'darwin') && process.getuid?.() !== 0) {
    throw new Error(
      '读别的进程内存需要 root（ptrace attach）。请用 sudo 运行本脚本，例如：\n' +
        '  sudo -E node --import tsx <script>',
    );
  }

  say(`读取 pid=${pid} 的会话物料 (uin=${uin}) ...`);
  const material = await nt.scanSessionMaterial(pid);
  // 只报「有没有」——物料本身就是凭据。
  say(
    `读取结果: a2=${material.a2 ? 'yes' : 'no'} d2=${material.d2 ? 'yes' : 'no'} ` +
      `d2key=${material.d2Key ? 'yes' : 'no'}`,
  );
  return material;
}
