/**
 * Linux privilege-escalated injection — the `InjectHook` used on linux.
 *
 * The instance key/rkey/clientkey flows need a QQ process that (a) has the hook
 * injected and (b) has told the hook its MSF service address. On linux those are
 * two distinct, differently-privileged steps:
 *
 *   1. INJECT (root) — ptrace-based, so it runs in a short-lived pkexec child
 *      (`inject_worker`). A graphical polkit password dialog pops once per pid.
 *   2. WAIT-FOR-PACKET (unprivileged) — the hook only learns the service
 *      address from a genuine post-login recv packet, so no OIDB packet can be
 *      sent until one arrives. This runs here in the main process (no root).
 *
 * Frequency is low: a QQ pid is injected once and reused for its whole life
 * (`ensure` no-ops after the first success), so the password prompt is a
 * once-per-QQ-launch event. If a later fetch fails (native client died), the
 * caller `reset`s the pid and the next `ensure` re-injects (prompting again).
 *
 * Persistence: the "which pids are injected" cache is ALSO written to
 * config.json (keyed by pid + process start time). A WeQ restart would
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
import { getLogger, logErrorContext } from '@weq/service';
import { readProcStartTime } from './proc_stat';

const logger = getLogger().child({ scope: 'inject-elevation' });

/**
 * How long to wait for the first genuine post-login recv packet. A quiet
 * account only gets one when it receives a message, so this is generous — the
 * UI-layer timeout race (see the key-stall prompt) handles "too slow" separately.
 */
const REAL_PACKET_TIMEOUT_MS = 120_000;

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
 * Inject into `pid` as root via pkexec. Runs the worker with electron-as-node
 * (`ELECTRON_RUN_AS_NODE=1`) so no system `node` is required. pkexec scrubs the
 * environment, so we re-set it with `env` and pass all inputs as argv.
 */
function pkexecInject(pid: number): Promise<void> {
  const workerPath = resolveWorkerPath();
  const ntHelperPath = resolveNtHelperPath();

  return new Promise((resolve, reject) => {
    // `pkexec env ELECTRON_RUN_AS_NODE=1 <electron> <worker> <pid> <addon>` —
    // pkexec clears env, so `env` re-injects the one var electron-as-node needs.
    const child = spawn(
      'pkexec',
      ['env', 'ELECTRON_RUN_AS_NODE=1', process.execPath, workerPath, String(pid), ntHelperPath],
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
 * Build the linux `InjectHook`: pkexec-elevated inject + unprivileged
 * wait-for-packet, with per-pid idempotency backed by persisted records.
 *
 * @param userConfig Persists inject records to config.json so a WeQ restart
 *   reuses an already-hooked, still-running QQ instead of re-injecting it.
 */
export function createPkexecInjectHook(
  nt: NtHelperBinding,
  userConfig: UserConfigService,
): InjectHook {
  /** pids whose pkexec ptrace inject has completed. */
  const injected = new Set<number>();
  /** pids that are injected AND have observed a real post-login packet. */
  const ready = new Set<number>();

  // Seed the in-memory caches from persisted records, pruned against live
  // processes. A record survives a WeQ restart only if its pid is still alive
  // AND its process start time matches (guards against pid recycling).
  seedFromPersisted();

  // In-flight per pid, split by half. CRITICAL: ptrace is exclusive, so two
  // pkexec children injecting the SAME pid concurrently race — one attaches, the
  // other fails to read `/proc/<pid>/maps` while resolving mmap. Concurrency is
  // real here: the router retries (reset+ensure) while a slow first attempt
  // (blocked on the polkit password dialog) is still running, and a second key
  // request can arrive meanwhile. Coalescing every concurrent call for a pid
  // onto one promise guarantees a single pkexec / single wait is ever live.
  const injectInflight = new Map<number, Promise<void>>();
  const waitInflight = new Map<number, Promise<void>>();

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
      if (rec.ready) ready.add(rec.pid);
      logger.info('reusing persisted inject record for live pid', {
        event: 'inject-record-reuse',
        pid: rec.pid,
        ready: rec.ready,
      });
    }
  }

  /** The pkexec ptrace inject half — pops the polkit dialog. Untimed by callers. */
  async function doInject(pid: number): Promise<void> {
    if (injected.has(pid)) return;
    const existing = injectInflight.get(pid);
    if (existing) {
      logger.info('joining in-flight inject for pid', { event: 'inject-join', pid });
      return existing;
    }
    const task = (async (): Promise<void> => {
      logger.info('injecting into qq via pkexec (root)', { event: 'inject-pkexec', pid });
      await pkexecInject(pid);
      injected.add(pid);
      // Persist so a WeQ restart reuses this hook instead of re-injecting.
      // Skip if the pid vanished between inject and stat (record would be junk).
      const startTime = readProcStartTime(pid);
      if (startTime !== null) {
        userConfig.setInjectRecord({ pid, startTime, ready: false, injectedAt: Date.now() });
      }
    })();
    injectInflight.set(pid, task);
    try {
      await task;
    } finally {
      injectInflight.delete(pid);
    }
  }

  /** The unprivileged wait-for-packet half. Callers time THIS (+ the fetch). */
  async function doWaitForPacket(pid: number): Promise<void> {
    if (ready.has(pid)) return;
    const existing = waitInflight.get(pid);
    if (existing) return existing;
    const task = (async (): Promise<void> => {
      // Block until the hook has seen a real post-login packet, otherwise the
      // first OIDB send fails ("runtime targets not resolved").
      logger.info('waiting for first post-login packet', { event: 'inject-wait-packet', pid });
      try {
        await nt.waitForRealPacket(pid, REAL_PACKET_TIMEOUT_MS);
      } catch (e) {
        logger.warn('no post-login packet observed; pid not ready', {
          event: 'inject-wait-packet-failed',
          pid,
          ...logErrorContext(e),
        });
        throw new Error(
          '已注入，但尚未捕获到登录后数据包，暂时无法取密钥。请让该 QQ 收/发一条消息后重试。',
        );
      }
      ready.add(pid);
      // Upgrade the persisted record to ready:true (only if the pid is still the
      // same process we injected — else leave persistence to the next inject).
      const rec = userConfig.getInjectRecord(pid);
      if (rec && readProcStartTime(pid) === rec.startTime) {
        userConfig.setInjectRecord({ ...rec, ready: true });
      }
      logger.info('qq pid ready for packet send', { event: 'inject-ready', pid });
    })();
    waitInflight.set(pid, task);
    try {
      await task;
    } finally {
      waitInflight.delete(pid);
    }
  }

  return {
    inject(pid: number): Promise<void> {
      return doInject(pid);
    },
    async ensure(pid: number): Promise<void> {
      if (ready.has(pid)) return;
      await doInject(pid);
      await doWaitForPacket(pid);
    },
    reset(pid: number): void {
      // Forget both caches AND the persisted record — the hook is presumed dead
      // (QQ relaunched / hook unloaded), so nothing should reuse it. In-flight
      // promises (if any) keep running so a concurrent call still coalesces onto
      // them rather than starting a second pkexec; the next call after they
      // settle re-injects cleanly and re-persists.
      injected.delete(pid);
      ready.delete(pid);
      userConfig.deleteInjectRecord(pid);
    },
  };
}
