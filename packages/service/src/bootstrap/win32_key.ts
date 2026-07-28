/**
 * Win32 key acquisition service. Three pathways, all returning the same
 * shape (`KeyResult`) so callers can fan-in without per-flow branches:
 *
 *   1. Instance     — a running, logged-in QQ. One async call, no events.
 *   2. Quick login  — launch QQ with the quick-dbkey bootstrap. Emits a
 *                     `login-list` event mid-flight (so the UI can show
 *                     "fetching key for uin X"), then resolves.
 *   3. QR login     — launch QQ with the qr-dbkey bootstrap. Emits
 *                     `qrcode` (scan-this-URL) and a stream of
 *                     `qrcode-state` transitions before resolving.
 *
 * The streaming flows use `AsyncIterable` instead of EventEmitter because
 * (a) iterator termination naturally signals "stream ended",
 * (b) the type contract is explicit (one Event union, not loose strings),
 * (c) Electron IPC adapters (tRPC subscription, MessagePort) consume them
 *     cleanly without extra plumbing.
 *
 * No service-level retry / backoff — that belongs in the UI layer where
 * the user can be asked "try again?". The one exception is a failed
 * msf_recv hook install (see {@link isHookInstallFailure}): the loader
 * installs the hook before it emits anything user-visible, so relaunching
 * QQ once is invisible, and the dominant cause is a random address-space
 * race that a fresh process clears. That one is retried once in-place.
 */

import type { Platform } from '@weq/platform';
import {
  NineBirdBootstrap,
  type NineBirdLoginListEvent,
  type NineBirdResultEvent,
  type StubHooks,
} from '@weq/native';
import { getLogger, logErrorContext } from '../common/logger';

/** What every key flow returns when it finishes. */
export interface KeyResult {
  success: boolean;
  dbkey?: string;
  error?: string;
  /**
   * Set when the flow died because the msf_recv hook couldn't be installed,
   * even after the automatic retry. `error` already carries a user-facing
   * explanation; this flag tells the UI not to fall back to another login
   * method (the next one would hit the same address-space problem) and to
   * just ask the user to try again.
   */
  hookInstallFailed?: boolean;
  /**
   * Web ticket the login loader grabbed alongside the dbkey (domain → p_skey).
   * Best-effort: absent on `requestKey`, and on a login whose pskey call failed.
   */
  pskey?: Record<string, string>;
}

/** Events surfaced during a streaming flow. */
export type KeyEvent =
  | { kind: 'login-list'; list: NineBirdLoginListEvent['list'] }
  | { kind: 'qrcode'; url: string }
  | { kind: 'qrcode-state'; state: string }
  | { kind: 'result'; result: KeyResult };

export interface QuickLoginStreamOptions {
  uin: string;
  timeoutMs?: number;
}

export interface QrLoginStreamOptions {
  timeoutMs?: number;
}

/**
 * Did this terminal error come from a failed msf_recv hook install?
 *
 * Both platforms' hookers wrap the failure as `install_msf_recv_hook failed`.
 * win32 appends funchook's detail, so a trampoline-space failure is
 * identifiable there as `NO_SPACE_NEAR_TARGET_ADDR`; linux's hooker reports
 * no detail at all. Either way it's worth one retry — the dominant cause is
 * the address-space race, which a fresh process usually clears.
 */
export function isHookInstallFailure(error: string | undefined): boolean {
  return error?.includes('install_msf_recv_hook failed') ?? false;
}

/**
 * Whether the failure is specifically "no trampoline space within ±2GB of the
 * target" — the random one. Only win32 reports enough detail to tell.
 */
function isNoTrampolineSpace(error: string | undefined): boolean {
  return error?.includes('NO_SPACE_NEAR_TARGET_ADDR') ?? false;
}

/**
 * User-facing replacement for the raw native error, used once the retry has
 * also failed. The original string stays in the logs — it means nothing to a
 * user. Only claim the address-space cause when the hooker actually confirmed it.
 */
function hookInstallHint(error: string | undefined): string {
  return isNoTrampolineSpace(error)
    ? '注入 QQ 失败：QQ 进程内存布局导致的偶发错误，已自动重试一次仍未成功。请再试一次，通常重试即可解决。'
    : '注入 QQ 失败，已自动重试一次仍未成功。这多为偶发错误，请再试一次；若反复失败请反馈。';
}

export class Win32KeyService {
  private readonly bootstrap: NineBirdBootstrap;
  private readonly logger = getLogger().child({ scope: 'win32-key' });

  constructor(
    private readonly platform: Platform,
    /** Linux-only entry-stub hooks (pkexec elevation). Omit for the fs default. */
    stubHooks?: StubHooks,
  ) {
    this.bootstrap = new NineBirdBootstrap(
      platform.native.nineBirdBoot,
      platform.native.resources,
      stubHooks,
    );
  }

  // -------------- 1. instance flow --------------

  /**
   * Ask a running, hooked QQ process for the dbkey of a specific account
   * database. The QQ process must already be logged in.
   */
  async fetchFromInstance(pid: number, dbPath: string): Promise<KeyResult> {
    this.logger.info('fetching database key from running instance', {
      event: 'fetch-key-from-instance',
      pid,
      dbPath,
    });
    try {
      const dbkey = await this.platform.native.ntHelper.requestDecryptKey(pid, dbPath);
      this.logger.info('fetched database key from running instance', {
        event: 'fetch-key-from-instance-success',
        pid,
        dbPath,
      });
      return { success: true, dbkey };
    } catch (e) {
      this.logger.error('failed to fetch database key from running instance', {
        event: 'fetch-key-from-instance-failed',
        pid,
        dbPath,
        ...logErrorContext(e),
      });
      return { success: false, error: errorMessage(e) };
    }
  }

  // -------------- 2. quick-login stream --------------

  /**
   * Launch QQ with the quick-dbkey bootstrap script. The bootstrap reads
   * the local login.db, picks the matching account, and asks QQ to
   * decrypt — all without user interaction.
   *
   * Yields `login-list` (mid-flight) and `result` (terminal), in that
   * order. The QQ process is killed on terminal event or on iterator
   * abandonment (via `try/finally`).
   */
  quickLoginStream(opts: QuickLoginStreamOptions): AsyncIterable<KeyEvent> {
    const exePath = this.requireQqExe();
    const appidQua = this.resolveAppidQua();
    this.logger.info('starting quick-login key flow', {
      event: 'quick-login-start',
      accountUin: opts.uin,
      timeoutMs: opts.timeoutMs ?? null,
      exePath,
      appid: appidQua.appid ?? null,
      qua: appidQua.qua ?? null,
    });
    const startSession = (): ReturnType<NineBirdBootstrap['startQuickLogin']> =>
      this.bootstrap.startQuickLogin({
        uin: opts.uin,
        qqExePath: exePath,
        ...appidQua,
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      });
    return iterateSession(startSession, this.logger);
  }

  // -------------- 3. QR-login stream --------------

  /**
   * Launch QQ with the qr-dbkey bootstrap script. Yields a `qrcode` event
   * with the URL to render, repeated `qrcode-state` events as the user
   * scans/confirms, and finally `result`.
   */
  qrLoginStream(opts: QrLoginStreamOptions = {}): AsyncIterable<KeyEvent> {
    const exePath = this.requireQqExe();
    const appidQua = this.resolveAppidQua();
    this.logger.info('starting qr-login key flow', {
      event: 'qr-login-start',
      timeoutMs: opts.timeoutMs ?? null,
      exePath,
      appid: appidQua.appid ?? null,
      qua: appidQua.qua ?? null,
    });
    const startSession = (): ReturnType<NineBirdBootstrap['startQrLogin']> =>
      this.bootstrap.startQrLogin({
        qqExePath: exePath,
        ...appidQua,
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      });
    return iterateSession(startSession, this.logger);
  }

  // ---- helpers ----

  /**
   * Resolve the installed QQ build's appid/qua from its `major.node`. These
   * MUST match the build or the login server rejects with 140022017 (and drops
   * the account from the history list) — so we never guess. On any failure we
   * return `{}` and let the ninebird loader fall back to its per-platform
   * default (which may be stale, hence the warning).
   */
  private resolveAppidQua(): { appid?: string; qua?: string } {
    const majorPath = this.platform.qqMajorNodePath();
    if (!majorPath) {
      this.logger.warn('major.node not found; ninebird will use fallback appid/qua', {
        event: 'appid-qua-major-missing',
      });
      return {};
    }
    try {
      const info = this.platform.native.ntHelper.resolveAppidFromMajor(majorPath);
      return {
        ...(info.appid ? { appid: info.appid } : {}),
        ...(info.qua ? { qua: info.qua } : {}),
      };
    } catch (e) {
      this.logger.warn('resolveAppidFromMajor failed; ninebird will use fallback', {
        event: 'appid-qua-resolve-failed',
        majorPath,
        ...logErrorContext(e),
      });
      return {};
    }
  }

  private requireQqExe(): string {
    const exe = this.platform.qqExePath();
    if (!exe) {
      throw new Error(
        'QQ.exe not found via registry. Is QQ NT installed in a non-standard location?',
      );
    }
    return exe;
  }
}

// ---------- session → AsyncIterable bridge -------------------------------

/**
 * Bridge a `LoginSession` (callback-based, hot-emitting) into an
 * `AsyncIterable<KeyEvent>` (cold, pull-based).
 *
 * Takes a session *factory* rather than a session so a failed msf_recv hook
 * install can be retried transparently: that failure always lands before the
 * loader emits anything user-visible (the hook goes up before the QR code /
 * login list), so relaunching QQ once is invisible to the consumer. Only that
 * one error retries — everything else passes straight through.
 *
 * Backpressure note: events arriving while no consumer is waiting are
 * queued in memory. NDJSON frames are small and the streams are short, so
 * an unbounded queue is acceptable — but if you ever wire this to a slow
 * IPC channel, swap the queue for a bounded ring buffer.
 */
function iterateSession(
  startSession: () => ReturnType<NineBirdBootstrap['startQrLogin']>,
  logger: ReturnType<typeof getLogger>,
): AsyncIterable<KeyEvent> {
  const queue: KeyEvent[] = [];
  const waiters: Array<(v: IteratorResult<KeyEvent>) => void> = [];
  let done = false;
  let session: ReturnType<NineBirdBootstrap['startQrLogin']>;
  let retried = false;

  const emit = (e: KeyEvent): void => {
    const waiter = waiters.shift();
    if (waiter) waiter({ value: e, done: false });
    else queue.push(e);
  };

  const finish = (): void => {
    if (done) return;
    done = true;
    while (waiters.length > 0) {
      const waiter = waiters.shift();
      if (waiter) waiter({ value: undefined, done: true });
    }
  };

  const attach = (): void => {
    session = startSession();
    session.onLoginList((e) => emit({ kind: 'login-list', list: e.list }));
    session.onQrcode((e) => emit({ kind: 'qrcode', url: e.url }));
    session.onState((e) => emit({ kind: 'qrcode-state', state: e.state }));

    // The loader always sends `pskey` before the terminal `result`, so this is
    // populated by the time we build the KeyResult below.
    let pskey: Record<string, string> | undefined;
    session.onPskey((e) => {
      if (e.success && e.pskey) pskey = e.pskey;
      else
        logger.warn('ninebird: pskey unavailable', {
          event: 'login-pskey-missing',
          error: e.error,
        });
    });

    void session.result.then((r: NineBirdResultEvent) => {
      if (done) return; // consumer already walked away
      if (!r.success && isHookInstallFailure(r.error)) {
        if (!retried) {
          retried = true;
          logger.warn('ninebird: msf_recv hook install failed, relaunching QQ once', {
            event: 'hook-install-retry',
            error: r.error,
          });
          attach();
          return;
        }
        logger.error('ninebird: msf_recv hook install failed after retry', {
          event: 'hook-install-failed',
          error: r.error,
        });
        emit({
          kind: 'result',
          result: { success: false, error: hookInstallHint(r.error), hookInstallFailed: true },
        });
        finish();
        return;
      }
      emit({
        kind: 'result',
        result: {
          success: r.success,
          ...(r.dbkey ? { dbkey: r.dbkey } : {}),
          ...(r.error ? { error: r.error } : {}),
          ...(pskey ? { pskey } : {}),
        },
      });
      finish();
    });
  };

  attach();

  return {
    [Symbol.asyncIterator](): AsyncIterator<KeyEvent> {
      return {
        next(): Promise<IteratorResult<KeyEvent>> {
          if (queue.length > 0) {
            const value = queue.shift() as KeyEvent;
            return Promise.resolve({ value, done: false });
          }
          if (done) return Promise.resolve({ value: undefined, done: true });
          return new Promise((res) => waiters.push(res));
        },
        return(): Promise<IteratorResult<KeyEvent>> {
          // Consumer abandoned the stream — tear QQ down.
          finish();
          session.kill();
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
