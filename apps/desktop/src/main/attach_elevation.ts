/**
 * Linux attach — the `AttachHook` used on linux.
 *
 * Reading a running QQ's memory needs a ptrace attach: on Linux the kernel gates
 * both `ptrace(PTRACE_ATTACH)` and `process_vm_readv` behind `PTRACE_MODE_ATTACH`,
 * so this is the same privilege question injection used to pose. It is elevated
 * only when it has to be:
 *
 *   1. ATTACH (ptrace) — under Electron the host is usually unprivileged, but
 *      with yama ptrace_scope off (or CAP_SYS_PTRACE) a normal user can ptrace a
 *      same-user QQ, so we try in-process FIRST. Only when the kernel refuses
 *      (EPERM) do we fall back to a short-lived sudo child (`attach_worker`),
 *      whose password comes from a self-drawn renderer dialog (macOS-style
 *      `sudo -S`, no polkit). The first time that refusal happens we ask the
 *      renderer to walk the user through disabling the protection (see
 *      `attach_hint.ts`); the user can retry, suppress the hint permanently
 *      (global_config), or type a password to escalate. "Suppress" only silences
 *      that guidance dialog — the direct attempt always runs first regardless.
 *      The ordering itself lives in `@weq/service`'s `runUnprivilegedAttach` so
 *      it can be unit tested; see that module for why suppression must never
 *      short-circuit the direct attempt. When the host is already running as root
 *      — the web server on a headless box — we read in-process directly; sudo
 *      would be pointless.
 *
 *      One host shape can't use the sudo child at all: an install that root
 *      cannot read — AppImage (payload on a FUSE mount without `allow_other`) or
 *      a home/install dir on a single-user FUSE (gocryptfs …). There root can't
 *      even `exec` our own binary, so the elevated worker dies with
 *      `env: "<mount>/@weqdesktop": permission denied`. On such hosts the
 *      password instead buys a `sudo` that only lifts yama protection
 *      (`escalateViaPtraceScope`): the read then runs in-process as the user and
 *      the old scope value is written back afterwards.
 *
 * Frequency is low: a QQ pid is read once per process (`ensure` returns the
 * cached material afterwards), so the password prompt is at most a
 * once-per-QQ-launch event. If a later fetch fails, the caller `reset`s the pid
 * and the next `ensure` re-reads (prompting again if it must).
 *
 * The material itself is persisted per account (@weq/service's account config,
 * a2 / d2 / d2key in the online-session block), so nothing pid-scoped needs to
 * survive a WeQ restart — reading a pid's memory is idempotent, unlike the
 * exclusive hook pipe this flow used to install. The device guid is separate:
 * it is read offline from the QQ data root, no elevation involved.
 *
 * macOS rides the same hook but has a **hard gate that no password can open**:
 * `task_for_pid` is refused while 系统完整性保护（SIP）is on, because QQ runs with
 * the hardened runtime. So on macOS, before any password prompt or sudo child,
 * `doAttach` asks {@link readSipEnabled} and refuses outright when SIP is on —
 * with a message pointing at the 扫码登录 path. With SIP off the only
 * remaining blocker is privilege, which is exactly the sudo prompt below; the
 * Linux-specific yama guidance dialog is skipped on macOS because it can't apply
 * (see `askHint`).
 *
 * Windows never uses this — it gets `createDirectAttachHook` instead, which
 * reads in-process and needs no elevation.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveNtHelperPath, type NtHelperBinding, type SessionMaterial } from '@weq/native';
import {
  isOnPrivateFuseMount,
  linuxSudoErrorHint,
  readSipEnabled,
  readYamaPtraceScope,
  resolveSudoPath,
  writeYamaPtraceScope,
} from '@weq/native';
import { runUnprivilegedAttach, type AttachHook, type UserConfigService } from '@weq/service';
import { getLogger } from '@weq/service';
import { getSudoPasswordPrompt, requestSudoPassword } from './sudo_prompt';
import { getAttachHintPrompt } from './attach_hint';

const logger = getLogger().child({ scope: 'attach-elevation' });

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * macOS 且 SIP 开着时的拒绝理由。给两条出路：扫码（不读内存），或者关掉 SIP 再来。
 *
 * 这里不给「输入密码试试」这种话 —— 密码不是瓶颈，SIP 才是，说了只会让人白输一次。
 */
export const SIP_ENABLED_MESSAGE =
  'macOS 的系统完整性保护（SIP）处于开启状态，读取 QQ 进程内存会被系统直接拒绝' +
  '（QQ 带强化运行时，管理员权限也不够）。\n' +
  '两条出路：\n' +
  '  · 需要在线数据的功能可以改走扫码登录（登录本身不读内存）；\n' +
  '  · 关机后进恢复模式执行 `csrutil disable` 关闭 SIP，重启再回来启用「自动读取 QQ 内存」。';

/**
 * Locate the bundled `attachWorker.mjs`. electron-vite emits it next to the
 * main entry (`out/main/`), but this module may be chunked into
 * `out/main/chunks/`, so try the sibling path first, then one level up.
 */
function resolveWorkerPath(): string {
  const candidates = [
    join(__dirname, 'attachWorker.mjs'),
    join(__dirname, '..', 'attachWorker.mjs'),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0]!;
}

/**
 * Best-effort classification of a native attach failure. True when the kernel
 * refused the ptrace attach (EPERM / EACCES) — the only failures an elevated
 * retry can actually fix, and the ones worth prompting about. Everything else
 * (no such process, wrapper.node not mapped, …) is left to the caller as-is.
 */
function isPermissionError(error: Error): boolean {
  const msg = error.message;
  return (
    // English libc / kernel phrasings for EPERM / EACCES.
    /operation not permitted|permission denied|not permitted|permission/i.test(msg) ||
    // zh_CN locales render EPERM as 「不允许的操作」.
    /不允许的操作|权限不足|没有权限|操作不允许/i.test(msg) ||
    /EPERM|EACCES/i.test(msg) ||
    /os error (1|13)\b/i.test(msg) ||
    /PTRACE_ATTACH|ptrace attach/i.test(msg) ||
    // 原生侧打开 /proc/<pid>/mem 失败时的提示。
    /\/proc\/\d+\/mem|ptrace_scope/i.test(msg)
  );
}

/**
 * root 能不能读到我们自己的文件（`process.execPath` / worker / `nt_helper.node`）？
 *
 * AppImage 把 payload 挂在 FUSE 上、且默认不带 `allow_other`，内核只放行
 * euid/egid 与挂载者一致的进程 —— root 对挂载点里**所有**文件都是 EACCES。
 * 单用户 FUSE 家目录（gocryptfs / encfs / 未开 allow_other 的 sshfs）同理，
 * 所以判定不只看 `$APPIMAGE`：按 execPath 所在的挂载判断更准。
 *
 * 这类宿主上「提权跑 worker」是死路（连 exec 我们自己的二进制都做不到），
 * 得换 {@link escalateViaPtraceScope}。
 *
 * 逃生口：`WEQ_ATTACH_FORCE_PTRACE_SCOPE=1` 强制走 FUSE 那条、`=0` 强制走
 * 提权 worker —— 两种姿势都能在 `pnpm dev`（非 FUSE 宿主）里试出来，不必为了
 * 验证打个 AppImage。
 */
export function installInvisibleToRoot(): boolean {
  const override = process.env.WEQ_ATTACH_FORCE_PTRACE_SCOPE;
  if (override === '1') return true;
  if (override === '0') return false;
  if (process.env.APPIMAGE) return true;
  try {
    return isOnPrivateFuseMount(process.execPath);
  } catch {
    return false; // 判不出来就按原来的提权方式走（失败时 linuxSudoErrorHint 会解释）
  }
}

/** 提权 worker 的 JSON 输出：成功带物料，失败带原因。 */
interface WorkerOutput {
  ok: boolean;
  material?: SessionMaterial;
  error?: string;
}

/**
 * Read `pid`'s memory as root via `sudo -S` (macOS 同款提权姿势). Runs the
 * worker with electron-as-node (`ELECTRON_RUN_AS_NODE=1`) so no system `node`
 * is required. Password goes over stdin and never touches disk / logs; all
 * inputs travel as argv (sudo 不重置环境，`env` 只是把 electron-as-node 需要
 * 的变量显式补回去).
 */
function sudoAttach(pid: number, uin: string, password: string): Promise<SessionMaterial> {
  const workerPath = resolveWorkerPath();
  const ntHelperPath = resolveNtHelperPath();

  return new Promise((resolve, reject) => {
    // `sudo -S /usr/bin/env ELECTRON_RUN_AS_NODE=1 <electron> <worker> <pid> <uin> <addon>`
    const child = spawn(
      resolveSudoPath(),
      [
        '-S',
        '/usr/bin/env',
        'ELECTRON_RUN_AS_NODE=1',
        process.execPath,
        workerPath,
        String(pid),
        uin,
        ntHelperPath,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.on('error', (e) => {
      reject(new Error(`sudo 无法启动（是否已安装 sudo？）：${e.message}`));
    });
    child.on('close', (code) => {
      // The worker reports both success and failure as one JSON blob (stderr on
      // failure), so parse it before falling back to the exit code.
      let parsed: WorkerOutput | null = null;
      for (const raw of [stderr.trim(), stdout.trim()]) {
        try {
          const candidate = JSON.parse(raw) as WorkerOutput;
          if (candidate && typeof candidate.ok === 'boolean') {
            parsed = candidate;
            break;
          }
        } catch {
          /* not JSON — try the other stream / the code hint below */
        }
      }

      if (code === 0 && parsed?.ok && parsed.material) {
        resolve(parsed.material);
        return;
      }
      const detail =
        parsed?.error || stderr.trim() || stdout.trim() || `attach worker 退出码 ${code}`;
      reject(new Error(`读取 QQ 进程内存需要管理员授权：${linuxSudoErrorHint(detail)}`));
    });

    child.stdin.on('error', () => {
      // sudo 提前退出（密码错误后立即结束）——忽略 EPIPE。
    });
    child.stdin.write(`${password}\n`);
    child.stdin.end();
  });
}

/**
 * Build the linux `AttachHook`: a single read step (sudo-elevated ptrace unless
 * already root), with per-pid material caching.
 *
 * The read half is elevated only when it has to be. Electron refuses to run as
 * root, so the desktop app is usually unprivileged — but a normal user can still
 * ptrace a same-user QQ when yama ptrace_scope is off, so we attempt the
 * in-process read first and escalate via sudo only when the kernel refuses (or
 * the user suppressed the hint). The web server typically runs as root on a
 * headless box — where sudo is both unnecessary (we already have the ptrace
 * privilege) and impossible (no renderer to draw the password dialog). So when
 * euid is 0 we always read in-process.
 *
 * @param userConfig Owns the persisted `suppressAttachHint` flag.
 */
export function createLinuxAttachHook(
  nt: NtHelperBinding,
  userConfig: UserConfigService,
): AttachHook {
  const isRoot = process.geteuid?.() === 0;

  /** Material read per pid — reading is idempotent, so one read per process. */
  const materials = new Map<number, SessionMaterial>();

  // In-flight per pid. ptrace is exclusive, so two sudo children attaching the
  // SAME pid concurrently race (one attaches, the other fails to read
  // `/proc/<pid>/maps`). Concurrency is real here: the router retries
  // (reset+ensure) while a slow first attempt (blocked on the password dialog)
  // is still running, and a second key request can arrive meanwhile. Coalescing
  // every concurrent call for a pid onto one promise guarantees a single sudo is
  // ever live.
  const inflight = new Map<number, Promise<SessionMaterial>>();

  /**
   * Try the unprivileged in-process read. Returns either the material or the
   * error; the caller decides whether to prompt or escalate.
   */
  async function tryDirectAttach(
    pid: number,
  ): Promise<{ material: SessionMaterial } | { error: Error }> {
    try {
      return { material: await nt.scanSessionMaterial(pid) };
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      logger.warn('unprivileged attach failed', {
        event: 'attach-direct-unprivileged-failed',
        pid,
        error: error.message,
      });
      return { error };
    }
  }

  /**
   * Unprivileged read. The ordering contract lives in `@weq/service`'s
   * `runUnprivilegedAttach` (direct → hint → escalate), so it stays
   * unit-testable; here we only wire the real side effects and collect the
   * material whichever branch produced it.
   *
   * The direct attempt is ALWAYS made first — even when the user ticked
   * 「不再提醒」. That flag mutes the guidance dialog; it must not skip the
   * passwordless path, or a user who once ticked it would be stuck on the sudo
   * prompt forever even after turning ptrace_scope off.
   */
  async function attachUnprivileged(pid: number, uin: string): Promise<SessionMaterial> {
    const box: { material: SessionMaterial | null } = { material: null };
    await runUnprivilegedAttach({
      log: (level, message, context) => logger[level](message, { ...context, pid }),
      tryDirect: async () => {
        const outcome = await tryDirectAttach(pid);
        if ('material' in outcome) {
          box.material = outcome.material;
          return null;
        }
        return {
          permissionDenied: isPermissionError(outcome.error),
          message: outcome.error.message,
        };
      },
      askHint: async () => {
        // macOS 上没有 yama ptrace_scope：SIP 关掉之后，剩下的唯一门槛就是「root
        // 权限」。那张教人改 `/proc/sys/kernel/yama/ptrace_scope` 的引导弹窗在 mac
        // 上只会误导，所以直接回 `skip`，下一个分支就是 sudo 密码框。
        if (process.platform === 'darwin') {
          return { choice: 'skip' as const, password: '' };
        }
        const prompt = getAttachHintPrompt();
        return prompt ? await prompt() : { choice: 'skip' as const, password: '' };
      },
      escalate: async (password) => {
        box.material = await escalateWithPassword(pid, uin, password);
      },
      suppressHint: () => {
        userConfig.setSettings({ suppressAttachHint: true });
      },
      isHintSuppressed: () => userConfig.getSettings().suppressAttachHint,
    });
    if (box.material === null) {
      throw new Error('attach 流程结束但没有读到会话物料');
    }
    return box.material;
  }

  /**
   * FUSE 宿主的提权姿势：root 只做一件不碰挂载点的事 —— 把 yama ptrace 保护
   * 临时放开；读取本身由非特权的我们完成（同用户 ptrace 同用户，正是
   * ptrace_scope=0 允许的场景），完事再把原值写回去。
   *
   * 为什么不用 worker：见 {@link installInvisibleToRoot}。这条路的 sudo 子进程
   * 只执行 `/bin/sh` 与 `/proc/sys/...`（都是系统文件），读不到挂载点也不影响。
   *
   * 恢复放在 finally：本次读取一旦完成就只依赖已拿到的物料，写回保护不影响本次
   * 会话；写回失败只记日志，不掩盖读取结果。读不到 yama（内核没编）或保护本来
   * 就是开的，说明这条捷径不成立 —— 退回提权 worker。
   */
  async function escalateViaPtraceScope(
    pid: number,
    uin: string,
    password: string,
  ): Promise<SessionMaterial> {
    const before = readYamaPtraceScope();
    if (before === null || before === '0') {
      logger.warn('yama ptrace_scope unusable; falling back to the elevated worker', {
        event: 'attach-ptrace-scope-unusable',
        pid,
        scope: before ?? 'unavailable',
      });
      return sudoAttach(pid, uin, password);
    }

    logger.info('lifting yama ptrace protection for this attach (fuse-hosted install)', {
      event: 'attach-ptrace-scope-lift',
      pid,
      previous: before,
    });
    await writeYamaPtraceScope('0', password);
    try {
      return await nt.scanSessionMaterial(pid);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      throw new Error(`已临时放开 ptrace 保护，但读取内存仍然失败：${err.message}`);
    } finally {
      try {
        await writeYamaPtraceScope(before, password);
        logger.info('yama ptrace protection restored', {
          event: 'attach-ptrace-scope-restore',
          pid,
          restored: before,
        });
      } catch (e) {
        logger.warn('failed to restore ptrace_scope', {
          event: 'attach-ptrace-scope-restore-failed',
          pid,
          errorMessage: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  /**
   * Ask the renderer for the sudo password (via the hint dialog's field, or the
   * standalone password dialog when none was provided) and read the memory, by
   * whichever escalation this host can actually use:
   *   - normal installs → root runs the worker (ptrace on our behalf);
   *   - installs root can't read (AppImage / 单用户 FUSE) → root only lifts yama
   *     protection, we read ourselves ({@link escalateViaPtraceScope}).
   * Throws when the user cancels — no material is produced.
   */
  async function escalateWithPassword(
    pid: number,
    uin: string,
    provided?: string,
  ): Promise<SessionMaterial> {
    let password: string | null = provided ?? null;
    if (!password) {
      const prompt = getSudoPasswordPrompt();
      if (!prompt) {
        throw new Error(
          '无法弹出密码输入框（无图形界面）。请以 root 运行 WeQ 服务，或在有桌面的环境中操作。',
        );
      }
      password = await requestSudoPassword(
        '提权读取 QQ 内存',
        '需要管理员权限读取正在运行的 QQ 进程内存（a2 / d2 / d2key）。请输入管理员密码。',
      );
    }
    if (!password) {
      throw new Error('已取消授权，未读取 QQ 进程内存。');
    }
    if (installInvisibleToRoot()) {
      return escalateViaPtraceScope(pid, uin, password);
    }
    return sudoAttach(pid, uin, password);
  }

  /** The read half — pops the password dialog unless we're already root. */
  async function doAttach(pid: number, uin: string): Promise<SessionMaterial> {
    const cached = materials.get(pid);
    if (cached) return cached;
    const existing = inflight.get(pid);
    if (existing) {
      logger.info('joining in-flight attach for pid', { event: 'attach-join', pid });
      return existing;
    }
    // macOS 的硬门槛：SIP 开着时读内存不可能成功（QQ 带强化运行时，`task_for_pid`
    // 连 root 都拒），所以在这里就停住 —— 不问密码、不起 sudo 子进程。
    if (process.platform === 'darwin' && readSipEnabled() === true) {
      logger.warn('macOS SIP is on; skipping the memory scan', {
        event: 'attach-skip-sip-on',
        pid,
      });
      throw new Error(SIP_ENABLED_MESSAGE);
    }
    const task = (async (): Promise<SessionMaterial> => {
      const material = isRoot
        ? await (() => {
            logger.info('reading qq memory in-process (already root)', {
              event: 'attach-direct-root',
              pid,
            });
            return nt.scanSessionMaterial(pid);
          })()
        : await attachUnprivileged(pid, uin);
      materials.set(pid, material);
      return material;
    })();
    inflight.set(pid, task);
    try {
      return await task;
    } finally {
      inflight.delete(pid);
    }
  }

  return {
    attach(pid: number, uin: string): Promise<SessionMaterial> {
      return doAttach(pid, uin);
    },
    ensure(pid: number, uin: string): Promise<SessionMaterial> {
      return doAttach(pid, uin);
    },
    reset(pid: number): void {
      // Forget the cached material — the caller decided it is stale (QQ
      // relaunched / account switched). In-flight promises (if any) keep running
      // so a concurrent call still coalesces onto them rather than starting a
      // second sudo; the next call after they settle reads cleanly again.
      materials.delete(pid);
    },
  };
}
