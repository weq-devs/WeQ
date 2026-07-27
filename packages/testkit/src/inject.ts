/**
 * Make a running QQ pid ready to send packets, for local probe scripts.
 *
 * Scripts used to just call `injectAndGetStatusEmbedded(pid)` and start sending,
 * which is correct on win32 but never works on linux, where two extra facts hold:
 *
 *   1. Injection is ptrace-based, so the process must be root. The desktop app
 *      spawns a pkexec child for this; a probe script is simply run under sudo.
 *   2. The hook learns the MSF service address only from a genuine post-login
 *      recv packet. Until one arrives, any send fails with "runtime targets not
 *      resolved" — so the inject must be followed by `waitForRealPacket`.
 *
 * `ensureSendable` hides both behind one call so every probe script is identical
 * across platforms.
 */

/** The slice of `NtHelperBinding` this module needs. Structural to avoid a
 * dependency cycle — `@weq/native` already devDepends on this package. */
export interface InjectableNative {
  injectAndGetStatusEmbedded(pid: number): Promise<{ pid: number; loggedIn: boolean; uin: string }>;
  waitForRealPacket(pid: number, timeoutMs: number): Promise<unknown>;
}

/**
 * How long to wait for the first genuine post-login recv packet. A quiet account
 * only produces one when it sends or receives a message, hence the generous
 * window (the desktop app uses the same 120s).
 */
const REAL_PACKET_TIMEOUT_MS = 120_000;

export interface EnsureSendableOptions {
  /** Prefix for progress lines, e.g. `'self-dress'`. Omit to stay quiet. */
  label?: string;
  /** Override the post-login packet wait (ms). Linux only. */
  timeoutMs?: number;
}

/**
 * Inject the hook into `pid` and block until it can actually send packets.
 * Throws with an actionable message when linux prerequisites are unmet.
 */
export async function ensureSendable(
  nt: InjectableNative,
  pid: number,
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

  say(`注入 hook 到 pid=${pid} ...`);
  const status = await nt.injectAndGetStatusEmbedded(pid);
  say(`注入结果: pid=${status.pid} uin=${status.uin} loggedIn=${status.loggedIn}`);

  if (process.platform !== 'linux') return status;

  // The hook cannot resolve the MSF service address before a real packet lands.
  say('等待登录后的首个真实数据包（hook 借它定位 MSF service 地址）...');
  try {
    await nt.waitForRealPacket(pid, opts.timeoutMs ?? REAL_PACKET_TIMEOUT_MS);
  } catch (e) {
    throw new Error(
      '已注入，但未捕获到登录后数据包，无法发包。请让该 QQ 收/发一条消息后重试。' +
        `（原因：${e instanceof Error ? e.message : String(e)}）`,
    );
  }
  say('已就绪,可以发包');
  return status;
}
