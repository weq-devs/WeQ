/**
 * AccountMonitorService — per-account background task that tracks whether a
 * logged-in QQ.exe instance for this account is running, and harvests download
 * rkeys from it while it is.
 *
 * Lifecycle (owned by the open/close of an account session):
 *   start() →  poll `isQqLoggedIn(uin)` until the account is logged in
 *           →  resolve the account's pid (single QQ → it; multiple → match uin
 *              via `probeQqLoginInfo`)
 *           →  record { qqOnline: true, qqPid } into the account config
 *           →  inject the hook once + `fetchDownloadRkeys` → store rkeys
 *           →  poll that pid; when it disappears, clear pid + mark offline and
 *              fall back to login-polling
 *   stop()  →  ends all polling.
 *
 * All native calls are best-effort: any throw degrades to "treat as offline,
 * retry next tick" rather than tearing the loop down. Uses a single chained
 * `setTimeout` (guarded by `running`) so only one timer is ever live.
 */

import type { AccountSession } from '@weq/account';
import type { Platform } from '@weq/platform';
import type { AccountConfigService, DownloadRkey } from './user_config';
import { rkeyExpiryMs } from './user_config';

/** How often to poll for the account becoming logged in. */
const LOGIN_POLL_MS = 5000;
/** How often to poll the attached pid for liveness. */
const PID_POLL_MS = 5000;
/** Refresh rkeys this long before they expire. */
const RKEY_REFRESH_SKEW_MS = 5 * 60 * 1000;

/**
 * Global registry of injected pids — shared across all AccountMonitorService
 * instances to prevent re-injecting the same QQ.exe when switching accounts.
 * Key = pid, Value = true when injected.
 */
const injectedPids = new Set<number>();

export class AccountMonitorService {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** The pid we currently believe hosts this account, or null. */
  private attachedPid: number | null = null;
  /** Last online state written to config — avoids rewriting it every tick. */
  private lastOnline: boolean | null = null;
  private lastPid: number | null | undefined = undefined;

  /**
   * @param shouldHarvestRkeys Checked live before each rkey fetch — when it
   *   returns false (用户关掉了「自动获取 rkey 补全媒体」), online/pid tracking
   *   keeps running but rkey harvesting is skipped. Defaults to always-on.
   */
  constructor(
    private readonly session: AccountSession,
    private readonly platform: Platform,
    private readonly accountConfig: AccountConfigService,
    private readonly shouldHarvestRkeys: () => boolean = () => true,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleLoginPoll(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.attachedPid = null;
    this.lastOnline = null;
    this.lastPid = undefined;
  }

  private get uin(): string {
    return this.session.context.uin;
  }

  private get nt(): Platform['native']['ntHelper'] {
    return this.platform.native.ntHelper;
  }

  private schedule(fn: () => void | Promise<void>, ms: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      if (this.running) void fn();
    }, ms);
  }

  private scheduleLoginPoll(ms: number): void {
    this.schedule(() => this.loginPoll(), ms);
  }

  private schedulePidPoll(ms: number): void {
    this.schedule(() => this.pidPoll(), ms);
  }

  // ---- login phase: wait for the account to come online -------------------

  private async loginPoll(): Promise<void> {
    let loggedIn = false;
    try {
      loggedIn = this.nt.isQqLoggedIn(this.uin);
    } catch {
      /* probe unavailable — treat as not logged in */
    }

    if (!loggedIn) {
      this.markOffline();
      return this.scheduleLoginPoll(LOGIN_POLL_MS);
    }

    const pid = this.resolvePid();
    if (pid === null) {
      this.markOffline();
      return this.scheduleLoginPoll(LOGIN_POLL_MS);
    }

    this.attachedPid = pid;
    this.markOnline(pid);
    if (this.shouldHarvestRkeys()) await this.refreshRkey(pid);
    this.schedulePidPoll(PID_POLL_MS);
  }

  /**
   * Attribute one running QQ.exe to this account. Single instance → it (the
   * `isQqLoggedIn` mutex already proved this account is the one online).
   * Multiple instances → port-probe each and match the uin.
   */
  private resolvePid(): number | null {
    let pids: number[] = [];
    try {
      pids = this.nt.getQqProcesses();
    } catch {
      return null;
    }
    if (pids.length === 0) return null;
    if (pids.length === 1) return pids[0] ?? null;

    for (const pid of pids) {
      try {
        const info = this.nt.probeQqLoginInfo(pid);
        if (info && info.uin === this.uin && info.loggedIn) return pid;
      } catch {
        /* skip un-probable pid */
      }
    }
    return null;
  }

  // ---- attached phase: watch the pid, keep rkeys fresh --------------------

  private async pidPoll(): Promise<void> {
    const pid = this.attachedPid;
    if (pid === null) {
      return this.scheduleLoginPoll(LOGIN_POLL_MS);
    }

    let alive = false;
    try {
      alive = this.nt.getQqProcesses().includes(pid);
    } catch {
      alive = false;
    }

    if (!alive) {
      if (this.attachedPid !== null) {
        injectedPids.delete(this.attachedPid);
      }
      this.attachedPid = null;
      this.markOffline();
      return this.scheduleLoginPoll(LOGIN_POLL_MS);
    }

    if (this.shouldHarvestRkeys()) await this.refreshRkeyIfStale(pid);
    this.schedulePidPoll(PID_POLL_MS);
  }

  // ---- config writes ------------------------------------------------------

  private markOnline(pid: number): void {
    this.writeOnline(true, pid);
  }

  private markOffline(): void {
    this.writeOnline(false, null);
  }

  /** Persist online state only when it actually changed since last write. */
  private writeOnline(online: boolean, pid: number | null): void {
    if (this.lastOnline === online && this.lastPid === pid) return;
    this.lastOnline = online;
    this.lastPid = pid;
    try {
      this.accountConfig.setOnline(online, pid);
    } catch {
      /* config write failed — non-fatal */
    }
  }

  // ---- rkey harvesting ----------------------------------------------------

  private async ensureInjected(pid: number): Promise<void> {
    if (injectedPids.has(pid)) return;
    await this.nt.injectAndGetStatusEmbedded(pid);
    injectedPids.add(pid);
  }

  private async refreshRkey(pid: number): Promise<void> {
    try {
      await this.ensureInjected(pid);
      const raw = await this.nt.fetchDownloadRkeys(pid);
      const rkeys = parseRkeys(raw);
      if (rkeys.length > 0) this.accountConfig.setRkeys(rkeys);
    } catch {
      /* leave stale rkeys in place; retry on the next stale check */
    }
  }

  private async refreshRkeyIfStale(pid: number): Promise<void> {
    const rkeys = this.accountConfig.getRecord()?.rkeys ?? [];
    const now = Date.now();
    const stale =
      rkeys.length === 0 ||
      rkeys.some((r) => rkeyExpiryMs(r) - now < RKEY_REFRESH_SKEW_MS);
    if (stale) await this.refreshRkey(pid);
  }
}

/** Normalise the native `fetchDownloadRkeys` JSON into {@link DownloadRkey}s. */
function parseRkeys(raw: string): DownloadRkey[] {
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: DownloadRkey[] = [];
  for (const x of arr) {
    if (!x || typeof x !== 'object') continue;
    const o = x as Record<string, unknown>;
    if (typeof o.rkey !== 'string') continue;
    out.push({
      rkey: o.rkey,
      type: typeof o.type_ === 'number' ? o.type_ : 0,
      ttlSeconds: typeof o.ttl_seconds === 'number' ? o.ttl_seconds : 0,
      createTime: typeof o.create_time === 'number' ? o.create_time : 0,
    });
  }
  return out;
}
