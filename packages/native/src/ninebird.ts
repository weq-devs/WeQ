/**
 * High-level wrapper around `NineBirdBoot.launchQQ`.
 *
 * The raw native API expects the caller to:
 *   - spin up a Windows Named Pipe server,
 *   - parse NDJSON frames flowing in,
 *   - keep the QQ pid around for cleanup,
 *   - decide when to resolve.
 *
 * That boilerplate has nothing to do with the call site's business logic.
 * `NineBirdBootstrap` does it once. Callers get:
 *   - a Promise that resolves with the terminal `result` event,
 *   - typed `onQrcode` / `onState` / `onLoginList` subscriptions,
 *   - an explicit `kill()` that tears QQ + the pipe server down.
 */

import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import type {
  LaunchQqResult,
  NineBirdAccountListEvent,
  NineBirdBootBinding,
  NineBirdEvent,
  NineBirdLoginListEvent,
  NineBirdQrcodeEvent,
  NineBirdQrcodeStateEvent,
  NineBirdResources,
  NineBirdResultEvent,
} from './types';

export interface QrLoginOptions {
  qqExePath: string;
  /** Default: 180_000 (3 min — leaves time to scan + confirm). */
  timeoutMs?: number;
}

export interface QuickLoginOptions {
  uin: string;
  qqExePath: string;
  /** Default: 60_000. */
  timeoutMs?: number;
}

export interface AccountListOptions {
  qqExePath: string;
  /** Default: 60_000. */
  timeoutMs?: number;
}

/** Handle returned by `startAccountList`. */
export interface AccountListSession {
  /** QQ process id, available once `launchQQ` resolves. */
  pid: Promise<number>;
  /** Resolves with the terminal `result` event (success or error). */
  result: Promise<NineBirdResultEvent>;
  /** The login list QQ enumerated (one event, before `result`). */
  onAccountList(cb: (e: NineBirdAccountListEvent) => void): void;
  /** Force-terminate QQ and tear down the pipe server. Safe to call twice. */
  kill(): void;
}

/** Handle returned by `startQrLogin` / `startQuickLogin`. */
export interface LoginSession {
  /** QQ process id, available once `launchQQ` resolves. */
  pid: Promise<number>;
  /** Resolves with the terminal `result` event (success or error). */
  result: Promise<NineBirdResultEvent>;
  /** QR-login: scan-this-URL event. No-op subscription for quick-login. */
  onQrcode(cb: (e: NineBirdQrcodeEvent) => void): void;
  /** QR-login: state transitions (waiting/scanned/confirmed/…). */
  onState(cb: (e: NineBirdQrcodeStateEvent) => void): void;
  /** Quick-login: the cached login list QQ read from local login.db. */
  onLoginList(cb: (e: NineBirdLoginListEvent) => void): void;
  /** Force-terminate QQ and tear down the pipe server. Safe to call twice. */
  kill(): void;
}

export class NineBirdBootstrap {
  constructor(
    private readonly binding: NineBirdBootBinding,
    private readonly resources: NineBirdResources,
  ) {}

  startQrLogin(opts: QrLoginOptions): LoginSession {
    return this.run({
      loadJsPath: this.resources.qrDbkeyJsPath,
      qqExePath: opts.qqExePath,
      timeoutMs: opts.timeoutMs ?? 180_000,
    });
  }

  startQuickLogin(opts: QuickLoginOptions): LoginSession {
    return this.run({
      uin: opts.uin,
      loadJsPath: this.resources.quickDbkeyJsPath,
      qqExePath: opts.qqExePath,
      timeoutMs: opts.timeoutMs ?? 60_000,
    });
  }

  /**
   * Launch QQ with the account-list bootstrap. Unlike quick/QR login this
   * acquires no dbkey — it just asks QQ for its local login list (the same
   * data `decryptLoginDb` produces, but read by QQ itself), so it works
   * even when our own `login.db` decryption fails.
   */
  startAccountList(opts: AccountListOptions): AccountListSession {
    const session = this.run({
      loadJsPath: this.resources.accountListJsPath,
      qqExePath: opts.qqExePath,
      timeoutMs: opts.timeoutMs ?? 60_000,
    });
    return {
      pid: session.pid,
      result: session.result,
      // Same `login-list` wire frame as quick-login, but account-list.js
      // fills it with the richer NineBirdAccountListItem payload.
      onAccountList: (cb) =>
        session.onLoginList(
          cb as unknown as (e: NineBirdLoginListEvent) => void,
        ),
      kill: session.kill,
    };
  }

  private run(args: {
    qqExePath: string;
    loadJsPath: string;
    timeoutMs: number;
    uin?: string;
  }): LoginSession {
    const emitter = new EventEmitter();
    const pipeName = makePipeName();

    let qqPid = 0;
    let pipeServer: Server | null = null;
    let killed = false;
    let resultSettled = false;

    const settleResult = (e: NineBirdResultEvent): void => {
      if (resultSettled) return;
      resultSettled = true;
      emitter.emit('result', e);
    };

    const kill = (): void => {
      if (killed) return;
      killed = true;
      if (qqPid) {
        try {
          process.kill(qqPid);
        } catch {
          /* QQ may have died on its own */
        }
        qqPid = 0;
      }
      if (pipeServer) {
        try {
          pipeServer.close();
        } catch {
          /* ignore */
        }
        pipeServer = null;
      }
    };

    // ---- pipe server ----
    pipeServer = createServer((socket) => attachSocket(socket, emitter));
    pipeServer.on('error', (err) => {
      settleResult({
        kind: 'result',
        success: false,
        error: `pipe server error: ${err.message}`,
      });
      kill();
    });
    const listenReady = new Promise<void>((res, rej) => {
      pipeServer!.once('error', rej);
      pipeServer!.listen(pipeName, () => {
        pipeServer!.removeListener('error', rej);
        res();
      });
    });

    // ---- pid promise (resolves once launchQQ returns) ----
    let pidResolve!: (n: number) => void;
    let pidReject!: (e: Error) => void;
    const pid = new Promise<number>((res, rej) => {
      pidResolve = res;
      pidReject = rej;
    });

    // ---- result promise (resolves on 'result' NDJSON frame, or on error/timeout) ----
    const result = new Promise<NineBirdResultEvent>((res) => {
      emitter.once('result', (e: NineBirdResultEvent) => {
        kill();
        res(e);
      });
    });

    // ---- timeout ----
    const timer = setTimeout(() => {
      settleResult({
        kind: 'result',
        success: false,
        error: `timeout after ${args.timeoutMs}ms`,
      });
    }, args.timeoutMs);
    timer.unref();
    void result.finally(() => clearTimeout(timer));

    // ---- kick off ----
    void (async (): Promise<void> => {
      try {
        await listenReady;
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        pidReject(err);
        settleResult({
          kind: 'result',
          success: false,
          error: `pipe listen failed: ${err.message}`,
        });
        return;
      }

      let launched: LaunchQqResult;
      try {
        launched = await this.binding.launchQQ({
          qqExePath: args.qqExePath,
          hookDllPath: this.resources.hookDllPath,
          qqntJsonPath: this.resources.qqntJsonPath,
          loadJsPath: args.loadJsPath,
          loaderDir: this.resources.loaderDir,
          pipeName,
          timeoutMs: args.timeoutMs,
          ...(args.uin !== undefined ? { uin: args.uin } : {}),
        });
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        pidReject(err);
        settleResult({
          kind: 'result',
          success: false,
          error: `launchQQ threw: ${err.message}`,
        });
        return;
      }

      if (!launched.success) {
        pidReject(new Error(launched.error ?? 'launchQQ returned success=false'));
        settleResult({
          kind: 'result',
          success: false,
          error: launched.error ?? 'launchQQ failed',
        });
        return;
      }

      qqPid = launched.pid;
      pidResolve(launched.pid);
    })();

    return {
      pid,
      result,
      onQrcode: (cb) => void emitter.on('qrcode', cb),
      onState: (cb) => void emitter.on('qrcode-state', cb),
      onLoginList: (cb) => void emitter.on('login-list', cb),
      kill,
    };
  }
}

// ---------- helpers -------------------------------------------------------

function makePipeName(): string {
  const stamp = Date.now().toString(36);
  return `\\\\.\\pipe\\ninebird-${process.pid}-${stamp}`;
}

/**
 * Read NDJSON frames off one pipe socket and re-emit them as typed events.
 * The pipe is one-shot per launch: NineBird connects, streams events, ends.
 */
function attachSocket(socket: Socket, emitter: EventEmitter): void {
  let buf = '';
  const drain = (final: boolean): void => {
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      emitParsed(line, emitter);
    }
    if (final && buf.trim()) {
      emitParsed(buf, emitter);
      buf = '';
    }
  };
  socket.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    drain(false);
  });
  socket.on('end', () => drain(true));
  socket.on('error', () => {
    /* surface as a missing 'result' → caller's timeout will fire */
  });
}

function emitParsed(line: string, emitter: EventEmitter): void {
  let parsed: NineBirdEvent;
  try {
    parsed = JSON.parse(line) as NineBirdEvent;
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== 'object' || !('kind' in parsed)) return;
  emitter.emit(parsed.kind, parsed);
}
