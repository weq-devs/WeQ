/**
 * High-level wrapper around `ninebird_addon.launchQQ`.
 *
 * The raw native API expects the caller to:
 *   - spin up an IPC server (win32 Named Pipe / linux unix socket),
 *   - parse NDJSON frames flowing in,
 *   - keep the QQ pid around for cleanup,
 *   - decide when to resolve,
 *   - (linux only) ensure a persistent entry stub sits in QQ's `resources/app`
 *     before launch — QQ resolves its Electron entry with a raw statx syscall
 *     that `LD_PRELOAD` can't intercept, so the stub must really hit disk.
 *     The stub is installed once (settings 「安装 NineBird」 or auto-install
 *     before login) and stays; it never self-deletes. Elevation for a
 *     root-owned `resources/app` is the caller's job; inject it via
 *     `stubHooks`. `dropStub` is idempotent: it skips when the on-disk stub
 *     already carries the WeQ marker, and (re)writes — possibly elevated —
 *     only when missing or stale.
 *
 * That boilerplate has nothing to do with the call site's business logic.
 * `NineBirdBootstrap` does it once. Callers get:
 *   - a Promise that resolves with the terminal `result` event,
 *   - typed `onQrcode` / `onState` / `onLoginList` subscriptions,
 *   - an explicit `kill()` that tears QQ + the IPC server (+ stub) down.
 */

import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { qqContainerDataRoot } from './darwin/install';
import {
  linuxLoaderShimContent,
  linuxOriginalMain,
  linuxPaths,
  linuxStubStatus,
} from './linux/install';
import type {
  LaunchQqResult,
  NineBirdAccountListEvent,
  NineBirdBootBinding,
  NineBirdEvent,
  NineBirdLoginListEvent,
  NineBirdPskeyEvent,
  NineBirdQrcodeEvent,
  NineBirdQrcodeStateEvent,
  NineBirdResources,
  NineBirdResultEvent,
} from './types';

/**
 * appid / qua matched to the installed QQ build, resolved by an upper layer
 * from QQ's `major.node` and threaded through to `launchQQ`. Absent fields
 * fall back to the loader's per-platform default.
 */
export interface AppidQua {
  appid?: string;
  qua?: string;
}

/**
 * Linux-only injection stub hooks. `dropStub` writes `content` to `path`
 * (inside QQ's `resources/app`); `removeStub` is expected to be a no-op on
 * linux (stub is persistent — see the module header). The defaults write
 * directly with `fs` and throw when the directory isn't writable — inject
 * elevated implementations (sudo -S + self-drawn password dialog) to support
 * root-owned installs. Ignored on win32.
 *
 * Both hooks may be async — the launch flow awaits them — so an elevated
 * implementation can shell out to `sudo` and reject on cancel/failure.
 */
export interface StubHooks {
  dropStub(path: string, content: string): void | Promise<void>;
  removeStub(path: string): void | Promise<void>;
}

const defaultStubHooks: StubHooks = {
  dropStub: (path, content) => writeFileSync(path, content),
  removeStub: (path) => rmSync(path, { force: true }),
};

export interface QrLoginOptions extends AppidQua {
  qqExePath: string;
  /** Default: 180_000 (3 min — leaves time to scan + confirm). */
  timeoutMs?: number;
}

export interface QuickLoginOptions extends AppidQua {
  uin: string;
  qqExePath: string;
  /** Default: 60_000. */
  timeoutMs?: number;
}

export interface AccountListOptions extends AppidQua {
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
  /** The `p_skey` the loader collected on its way out (fires before `result`). */
  onPskey(cb: (e: NineBirdPskeyEvent) => void): void;
  /** Force-terminate QQ and tear down the pipe server. Safe to call twice. */
  kill(): void;
}

export class NineBirdBootstrap {
  constructor(
    private readonly binding: NineBirdBootBinding,
    private readonly resources: NineBirdResources,
    /** Linux-only entry-stub hooks. Defaults write directly with `fs`. */
    private readonly stubHooks: StubHooks = defaultStubHooks,
  ) {}

  startQrLogin(opts: QrLoginOptions): LoginSession {
    return this.run({
      loadJsPath: this.resources.qrDbkeyJsPath,
      qqExePath: opts.qqExePath,
      timeoutMs: opts.timeoutMs ?? 180_000,
      ...(opts.appid !== undefined ? { appid: opts.appid } : {}),
      ...(opts.qua !== undefined ? { qua: opts.qua } : {}),
    });
  }

  startQuickLogin(opts: QuickLoginOptions): LoginSession {
    return this.run({
      uin: opts.uin,
      loadJsPath: this.resources.quickDbkeyJsPath,
      qqExePath: opts.qqExePath,
      timeoutMs: opts.timeoutMs ?? 60_000,
      ...(opts.appid !== undefined ? { appid: opts.appid } : {}),
      ...(opts.qua !== undefined ? { qua: opts.qua } : {}),
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
      ...(opts.appid !== undefined ? { appid: opts.appid } : {}),
      ...(opts.qua !== undefined ? { qua: opts.qua } : {}),
    });
    return {
      pid: session.pid,
      result: session.result,
      // Same `login-list` wire frame as quick-login, but account-list.js
      // fills it with the richer NineBirdAccountListItem payload.
      onAccountList: (cb) =>
        session.onLoginList(cb as unknown as (e: NineBirdLoginListEvent) => void),
      kill: session.kill,
    };
  }

  private run(args: {
    qqExePath: string;
    loadJsPath: string;
    timeoutMs: number;
    uin?: string;
    appid?: string;
    qua?: string;
  }): LoginSession {
    const emitter = new EventEmitter();
    const isLinux = process.platform === 'linux';
    const pipeName = makePipeName();

    let qqPid = 0;
    let pipeServer: Server | null = null;
    let killed = false;
    let resultSettled = false;

    // ---- linux entry stub (ensured before launch, never removed) ----
    // The launcher.so (LD_PRELOAD) redirects QQ's Electron entry to
    // `<QQ>/resources/app/loadNineBird.js`, which must really exist on disk
    // (raw statx). The stub is a PERSISTENT shim (see linux/install.ts): it
    // does not self-delete and does not embed any per-launch loader path — it
    // requires `NINEBIRD_LOAD_PATH` (set by launchQQ), so once installed it
    // works for every future launch without re-elevation. `dropStub` is an
    // idempotent ensure: skip when the on-disk stub carries our marker (e.g.
    // installed via settings), rewrite when missing or stale (old
    // self-deleting stubs have no marker). `removeStub` is a no-op — cleanup
    // only happens via the explicit 「还原 NineBird」 action in settings.
    // On win32 both are no-ops.
    const stubPath = isLinux ? linuxPaths(args.qqExePath).loaderJs : '';
    let stubEnsured = false;
    const dropStub = async (): Promise<void> => {
      if (!isLinux || stubEnsured) return;
      const paths = linuxPaths(args.qqExePath);
      const status = linuxStubStatus(paths);
      if (status.installed && status.fresh) {
        stubEnsured = true;
        return;
      }
      const content = linuxLoaderShimContent(args.loadJsPath, linuxOriginalMain(paths.appDir));
      await this.stubHooks.dropStub(stubPath, content);
      stubEnsured = true;
    };
    const removeStub = (): void => {
      /* intentionally not cleaned up — see module header */
    };

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
      removeStub();
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

      // ---- linux: drop the entry stub before launch (may throw / elevate) ----
      try {
        await dropStub();
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        pidReject(err);
        settleResult({
          kind: 'result',
          success: false,
          error: `stub drop failed: ${err.message}`,
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
          ...(args.appid !== undefined ? { appid: args.appid } : {}),
          ...(args.qua !== undefined ? { qua: args.qua } : {}),
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
      onPskey: (cb) => void emitter.on('pskey', cb),
      kill,
    };
  }
}

// ---------- helpers -------------------------------------------------------

/**
 * IPC channel name for the addon → JS event stream. win32 uses a Named Pipe;
 * linux uses a unix domain socket path under a fresh temp dir (the addon
 * connects to it). Both are unique per launch (pid + timestamp).
 */
function makePipeName(): string {
  const stamp = Date.now().toString(36);
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\ninebird-${process.pid}-${stamp}`;
  }
  if (process.platform === 'darwin') {
    // QQ 是沙箱应用，连不上 /tmp 里任意 unix socket；把 socket 放进 QQ
    // 自己的容器 tmp（WeQ 非沙箱可以写，QQ 沙箱内也可以连），并压缩名字
    // 长度以避开 unix socket 路径 104 字节上限。
    const dir = join(qqContainerDataRoot(), 'tmp');
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      // 目录建不出来就退回系统 tmpdir（QQ 连不上时报错，日志可查）。
      const fallback = mkdtempSync(join(tmpdir(), 'ninebird-'));
      return join(fallback, `${process.pid}-${stamp}.sock`);
    }
    return join(dir, `nb-${process.pid}-${stamp.slice(-6)}.sock`);
  }
  const dir = mkdtempSync(join(tmpdir(), 'ninebird-'));
  return join(dir, `${process.pid}-${stamp}.sock`);
}

/**
 * Read NDJSON frames off one pipe socket and re-emit them as typed events.
 * The pipe is one-shot per launch: NineBird connects, streams events, ends.
 */
function attachSocket(socket: Socket, emitter: EventEmitter): void {
  let buf = '';
  const drain = (final: boolean): void => {
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      nl = buf.indexOf('\n');
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
