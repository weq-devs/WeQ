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
 * the user can be asked "try again?".
 */

import type { Platform } from '@weq/platform';
import {
  NineBirdBootstrap,
  type NineBirdLoginListEvent,
  type NineBirdQrcodeEvent,
  type NineBirdQrcodeStateEvent,
  type NineBirdResultEvent,
} from '@weq/native';
import { getLogger, logErrorContext } from '../common/logger';

/** What every key flow returns when it finishes. */
export interface KeyResult {
  success: boolean;
  dbkey?: string;
  error?: string;
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

export class Win32KeyService {
  private readonly bootstrap: NineBirdBootstrap;
  private readonly logger = getLogger().child({ scope: 'win32-key' });

  constructor(private readonly platform: Platform) {
    this.bootstrap = new NineBirdBootstrap(
      platform.native.nineBirdBoot,
      platform.native.resources,
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
    this.logger.info('starting quick-login key flow', {
      event: 'quick-login-start',
      accountUin: opts.uin,
      timeoutMs: opts.timeoutMs ?? null,
      exePath,
    });
    const session = this.bootstrap.startQuickLogin({
      uin: opts.uin,
      qqExePath: exePath,
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    });
    return iterateSession(session);
  }

  // -------------- 3. QR-login stream --------------

  /**
   * Launch QQ with the qr-dbkey bootstrap script. Yields a `qrcode` event
   * with the URL to render, repeated `qrcode-state` events as the user
   * scans/confirms, and finally `result`.
   */
  qrLoginStream(opts: QrLoginStreamOptions = {}): AsyncIterable<KeyEvent> {
    const exePath = this.requireQqExe();
    this.logger.info('starting qr-login key flow', {
      event: 'qr-login-start',
      timeoutMs: opts.timeoutMs ?? null,
      exePath,
    });
    const session = this.bootstrap.startQrLogin({
      qqExePath: exePath,
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    });
    return iterateSession(session);
  }

  // ---- helpers ----

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
 * Backpressure note: events arriving while no consumer is waiting are
 * queued in memory. NDJSON frames are small and the streams are short, so
 * an unbounded queue is acceptable — but if you ever wire this to a slow
 * IPC channel, swap the queue for a bounded ring buffer.
 */
function iterateSession(
  session: ReturnType<NineBirdBootstrap['startQrLogin']>,
): AsyncIterable<KeyEvent> {
  const queue: KeyEvent[] = [];
  const waiters: Array<(v: IteratorResult<KeyEvent>) => void> = [];
  let done = false;

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

  session.onLoginList((e) => emit({ kind: 'login-list', list: e.list }));
  session.onQrcode((e) => emit({ kind: 'qrcode', url: e.url }));
  session.onState((e) => emit({ kind: 'qrcode-state', state: e.state }));

  void session.result.then((r: NineBirdResultEvent) => {
    emit({
      kind: 'result',
      result: { success: r.success, ...(r.dbkey ? { dbkey: r.dbkey } : {}), ...(r.error ? { error: r.error } : {}) },
    });
    finish();
  });

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
          session.kill();
          finish();
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
