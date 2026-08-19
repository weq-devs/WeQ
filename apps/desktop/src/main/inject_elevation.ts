/**
 * Linux injection — the `InjectHook` used on linux.
 *
 * The instance key/rkey/clientkey flows need a QQ process with the hook
 * injected and bound to its MSFService instance. On linux that is one
 * step, elevated only when it has to be:
 *
 *   1. INJECT (ptrace) — under Electron the host is usually unprivileged, but
 *      with yama ptrace_scope off (or CAP_SYS_PTRACE) a normal user can
 *      ptrace a same-user QQ, so we try in-process FIRST. Only when the kernel
 *      refuses (EPERM) do we fall back to a short-lived pkexec child
 *      (`inject_worker`), which pops the polkit password dialog. The first
 *      time that refusal happens we ask the renderer to walk the user through
 *      disabling the protection (see `ptrace_hint.ts`); the user can retry,
 *      suppress the hint permanently (global_config), or just escalate. When
 *      the host is already running as root — the web server on a headless
 *      box — we ptrace in-process directly; pkexec would be pointless and,
 *      with no polkit agent to authenticate against, impossible.
 *
 * The native inject call hands the account UIN to the hook over the pipe and
 * blocks until the hook binds the MSFService instance (~30s), so when inject
 * resolves the pid can already send OIDB packets — there is no separate
 * unprivileged wait-for-packet half anymore.
 *
 * Frequency is low: a QQ pid is injected once and reused for its whole life
 * (`ensure` no-ops after the first success), so the password prompt is a
 * once-per-QQ-launch event. If a later fetch fails (native client died), the
 * caller `reset`s the pid and the next `ensure` re-injects (prompting again).
 *
 * Persistence: the "which pids are injected" cache is ALSO written to
 * config.json (keyed by pid + process start time + uin). A WeQ restart would
 * otherwise forget an already-hooked, still-running QQ and re-inject it —
 * re-popping the password dialog and racing the hook's control pipe. On startup
 * we prune dead pids and seed the in-memory cache from what survives, so a
 * restart reuses the live hook instead of blindly re-injecting.
 *
 * Windows never uses this — it gets `createDirectInjectHook` instead, which
 * injects in-process and needs neither elevation nor the packet wait.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveNtHelperPath, type NtHelperBinding } from '@weq/native';
import type { InjectHook, UserConfigService } from '@weq/service';
import { getLogger } from '@weq/service';
import { getPtraceHintPrompt } from './ptrace_hint';
import { readProcStartTime } from './proc_stat';

const logger = getLogger().child({ scope: 'inject-elevation' });

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Locate the bundled `injectWorker.mjs`. electron-vite emits it next to the
 * main entry (`out/main/`), but this module may be chunked into
 * `out/main/chunks/`, so try the sibling path first, then one level up.
 */
function resolveWorkerPath(): string {
  const candidates = [
    join(__dirname, 'injectWorker.mjs'),
    join(__dirname, '..', 'injectWorker.mjs'),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0]!;
}

/**
 * Best-effort classification of a native inject failure. True when the kernel
 * refused the ptrace attach / injector extraction (EPERM / EACCES) — the only
 * failures an elevated retry can actually fix, and the ones worth prompting
 * about. Everything else (missing db, hook bind timeout, …) is left to the
 * caller as-is.
 */
function isPermissionError(error: Error): boolean {
  const msg = error.message;
  return (
    /operation not permitted|permission denied|not permitted|permission/i.test(msg) ||
    /EPERM|EACCES/i.test(msg) ||
    /os error (1|13)\b/i.test(msg) ||
    /failed to load extracted injector/i.test(msg)
  );
}

/**
 * Inject into `pid` as root via pkexec. Runs the worker with electron-as-node
 * (`ELECTRON_RUN_AS_NODE=1`) so no system `node` is required. pkexec scrubs the
 * environment, so we re-set it with `env` and pass all inputs as argv.
 */
function pkexecInject(pid: number, uin: string): Promise<void> {
  const workerPath = resolveWorkerPath();
  const ntHelperPath = resolveNtHelperPath();

  return new Promise((resolve, reject) => {
    // `pkexec env ELECTRON_RUN_AS_NODE=1 <electron> <worker> <pid> <uin> <addon>` —
    // pkexec clears env, so `env` re-injects the one var electron-as-node needs.
    const child = spawn(
      'pkexec',
      [
        'env',
        'ELECTRON_RUN_AS_NODE=1',
        process.execPath,
        workerPath,
        String(pid),
        uin,
        ntHelperPath,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.on('error', (e) => {
      reject(new Error(`pkexec 无法启动（是否已安装 polkit？）：${e.message}`));
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      // Prefer the worker's own JSON error; fall back to a code-based hint.
      let workerError = '';
      try {
        const parsed = JSON.parse(stderr.trim() || stdout.trim());
        if (parsed && typeof parsed.error === 'string') workerError = parsed.error;
      } catch {
        /* not JSON — use the raw code hint below */
      }
      const hint =
        code === 126
          ? '授权被取消。请在弹出的密码框中输入密码后重试。'
          : code === 127
            ? '未能弹出授权框。请确认桌面的 polkit 认证代理正在运行。'
            : workerError || `注入进程退出码 ${code}。${stderr.trim()}`;
      reject(new Error(`向 QQ 进程注入需要管理员授权：${hint}`));
    });
  });
}

/**
 * Build the linux `InjectHook`: a single inject step (pkexec-elevated ptrace
 * unless already root), with per-pid idempotency backed by persisted records.
 *
 * The inject half is elevated only when it has to be. Electron refuses to run
 * as root, so the desktop app is usually unprivileged — but a normal user can
 * still ptrace a same-user QQ when yama ptrace_scope is off, so we attempt the
 * in-process inject first and escalate via pkexec only when the kernel refuses
 * (or the user suppressed the hint). The web server typically runs as root on
 * a headless box — where pkexec is both unnecessary (we already have the
 * ptrace privilege) and unusable (no graphical polkit agent to authenticate
 * against). So when euid is 0 we always ptrace in-process.
 *
 * @param userConfig Persists inject records to config.json so a WeQ restart
 *   reuses an already-hooked, still-running QQ instead of re-injecting it.
 */
export function createLinuxInjectHook(
  nt: NtHelperBinding,
  userConfig: UserConfigService,
): InjectHook {
  const isRoot = process.geteuid?.() === 0;

  /** pids whose ptrace inject has completed. */
  const injected = new Set<number>();

  // Seed the in-memory cache from persisted records, pruned against live
  // processes. A record survives a WeQ restart only if its pid is still alive
  // AND its process start time matches (guards against pid recycling).
  seedFromPersisted();

  // In-flight per pid. CRITICAL: ptrace is exclusive, so two pkexec children
  // injecting the SAME pid concurrently race — one attaches, the other fails to
  // read `/proc/<pid>/maps` while resolving mmap. Concurrency is real here: the
  // router retries (reset+ensure) while a slow first attempt (blocked on the
  // polkit password dialog) is still running, and a second key request can
  // arrive meanwhile. Coalescing every concurrent call for a pid onto one
  // promise guarantees a single pkexec is ever live.
  const injectInflight = new Map<number, Promise<void>>();

  function seedFromPersisted(): void {
    const records = userConfig.getInjectRecords();
    for (const rec of Object.values(records)) {
      const live = readProcStartTime(rec.pid);
      if (live === null || live !== rec.startTime) {
        // Dead or recycled — drop it so we don't trust a stale hook.
        userConfig.deleteInjectRecord(rec.pid);
        continue;
      }
      injected.add(rec.pid);
      logger.info('reusing persisted inject record for live pid', {
        event: 'inject-record-reuse',
        pid: rec.pid,
        uin: rec.uin,
      });
    }
  }

  /**
   * Try the unprivileged ptrace inject in-process. Returns the error when the
   * native call rejects; the caller decides whether to prompt or escalate.
   */
  async function tryDirectInject(pid: number, uin: string): Promise<Error | null> {
    try {
      await nt.injectAndGetStatusEmbedded(pid, uin);
      return null;
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      logger.warn('unprivileged inject failed', {
        event: 'inject-direct-unprivileged-failed',
        pid,
        error: err.message,
      });
      return err;
    }
  }

  /**
   * Unprivileged inject with the ptrace-hint flow:
   *   1. try in-process — success means no password dialog at all;
   *   2. non-permission failure → escalate via pkexec (unchanged behaviour);
   *   3. permission failure → ask the renderer once (unless suppressed):
   *        retry      → try in-process again, then escalate on repeat failure
   *        no-remind  → persist the suppression, then escalate
   *        skip/dismiss→ escalate without remembering
   */
  async function injectUnprivileged(pid: number, uin: string): Promise<void> {
    if (userConfig.getSettings().suppressPtraceHint) {
      logger.info('ptrace hint suppressed by user; escalating directly', {
        event: 'inject-pkexec-suppressed',
        pid,
      });
      await pkexecInject(pid, uin);
      return;
    }

    const first = await tryDirectInject(pid, uin);
    if (first === null) return;
    if (!isPermissionError(first)) {
      await pkexecInject(pid, uin);
      return;
    }

    const prompt = getPtraceHintPrompt();
    const choice = prompt ? await prompt() : 'skip';
    if (choice === 'retry') {
      const retry = await tryDirectInject(pid, uin);
      if (retry === null) return;
      if (isPermissionError(retry)) {
        logger.warn('ptrace retry still permission-denied; escalating', {
          event: 'inject-direct-retry-denied',
          pid,
        });
      }
      await pkexecInject(pid, uin);
      return;
    }
    if (choice === 'no-remind') {
      userConfig.setSettings({ suppressPtraceHint: true });
      logger.info('ptrace hint permanently suppressed', {
        event: 'ptrace-hint-suppressed',
        pid,
      });
    }
    await pkexecInject(pid, uin);
  }

  /** The ptrace inject half — pops the polkit dialog unless we're already root. */
  async function doInject(pid: number, uin: string): Promise<void> {
    if (injected.has(pid)) return;
    const existing = injectInflight.get(pid);
    if (existing) {
      logger.info('joining in-flight inject for pid', { event: 'inject-join', pid });
      return existing;
    }
    const task = (async (): Promise<void> => {
      if (isRoot) {
        logger.info('injecting into qq in-process (already root)', {
          event: 'inject-direct-root',
          pid,
        });
        await nt.injectAndGetStatusEmbedded(pid, uin);
      } else {
        await injectUnprivileged(pid, uin);
      }
      injected.add(pid);
      // Persist so a WeQ restart reuses this hook instead of re-injecting.
      // Skip if the pid vanished between inject and stat (record would be junk).
      const startTime = readProcStartTime(pid);
      if (startTime !== null) {
        userConfig.setInjectRecord({ pid, startTime, uin, injectedAt: Date.now() });
      }
    })();
    injectInflight.set(pid, task);
    try {
      await task;
    } finally {
      injectInflight.delete(pid);
    }
  }

  return {
    inject(pid: number, uin: string): Promise<void> {
      return doInject(pid, uin);
    },
    async ensure(pid: number, uin: string): Promise<void> {
      await doInject(pid, uin);
    },
    reset(pid: number): void {
      // Forget the cache AND the persisted record — the hook is presumed dead
      // (QQ relaunched / hook unloaded), so nothing should reuse it. In-flight
      // promises (if any) keep running so a concurrent call still coalesces onto
      // them rather than starting a second pkexec; the next call after they
      // settle re-injects cleanly and re-persists.
      injected.delete(pid);
      userConfig.deleteInjectRecord(pid);
    },
  };
}
