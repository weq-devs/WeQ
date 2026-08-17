/**
 * Make a running QQ pid ready to send packets, for local probe scripts.
 *
 * Scripts call `injectAndGetStatusEmbedded(pid, uin)` and start sending. On
 * linux the native inject already hands the uin to the hook over the pipe and
 * blocks until the hook binds the MSFService instance, so injection resolving
 * means the pid can send — there is no separate post-login packet wait anymore.
 * The only linux-specific prerequisite left is privilege: injection is
 * ptrace-based, so the process must be root. The desktop app spawns a pkexec
 * child for this; a probe script is simply run under sudo.
 */

/** The slice of `NtHelperBinding` this module needs. Structural to avoid a
 * dependency cycle — `@weq/native` already devDepends on this package. */
export interface InjectableNative {
  injectAndGetStatusEmbedded(
    pid: number,
    uin: string,
  ): Promise<{ pid: number; loggedIn: boolean; uin: string }>;
}

export interface EnsureSendableOptions {
  /** Prefix for progress lines, e.g. `'self-dress'`. Omit to stay quiet. */
  label?: string;
}

/**
 * Inject the hook into `pid` and block until it can actually send packets.
 * Throws with an actionable message when linux prerequisites are unmet.
 */
export async function ensureSendable(
  nt: InjectableNative,
  pid: number,
  uin: string,
  opts: EnsureSendableOptions = {},
): Promise<{ pid: number; loggedIn: boolean; uin: string }> {
  const say = (msg: string): void => {
    if (opts.label) console.log(`[${opts.label}] ${msg}`);
  };

  if (process.platform === 'linux' && process.getuid?.() !== 0) {
    throw new Error(
      'linux 注入需要 root（ptrace）。请用 sudo 运行本脚本，例如：\n' +
        '  sudo -E node --import tsx <script>',
    );
  }

  say(`注入 hook 到 pid=${pid} (uin=${uin}) ...`);
  const status = await nt.injectAndGetStatusEmbedded(pid, uin);
  say(`注入结果: pid=${status.pid} uin=${status.uin} loggedIn=${status.loggedIn}`);
  say('已就绪,可以发包');
  return status;
}
