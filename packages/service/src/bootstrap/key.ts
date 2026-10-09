/**
 * Key acquisition service.
 *
 * Login is **pure protocol** (`nt_helper.quickLogin` / `qrLogin`): we take the
 * account's cached a1 + device guid straight from `login.db` and talk to the
 * login server ourselves. No QQ process is launched, nothing is injected, and
 * there is no privilege escalation anywhere on this path — the three
 * platforms only differ in the EasyLogin constants (appId / os / platform),
 * with `subAppId` scanned from the installed `major.node`.
 *
 *   - quick login — account has an a1 (`a1Payload`). The server may decide the
 *     device is unusual (140022011): the native flow then walks the user
 *     through a **phone confirmation** (TransEmp31/12) and resumes by itself.
 *   - QR login   — account has no usable a1. Emits a `qrcode` to render and a
 *     stream of `qrcode-state` transitions.
 *
 * Quick login failing is the UI's cue to fall back to QR — no service-level
 * retry/backoff lives here.
 *
 * The alive-QQ-instance path (`fetchFromInstance`) is kept for other features
 * (monitor / packet sending), but it is deliberately **not part of login**.
 */

import { existsSync } from 'node:fs';
import { hostname, release } from 'node:os';
import type { Platform } from '@weq/platform';
import type {
  LoginAccount,
  NtHelperBinding,
  QuickLoginEvent,
  QuickLoginOptions,
} from '@weq/native';
import { getLogger, logErrorContext } from '../common/logger';
import { requestDecryptKeyFromInstance } from '../account/online_ticket';
import { resolveDeviceGuid } from '../account/sso_session';
import { readKeyMeta, readLoginAccounts } from './login_db';

/** What every key flow returns when it finishes. */
export interface KeyResult {
  success: boolean;
  dbkey?: string;
  error?: string;
  /**
   * Web ticket the login flow harvested alongside the dbkey (domain → p_skey).
   * The pure-protocol flow does not harvest one, so this stays absent; the
   * field is kept so `openAccount`'s home-dress best-effort keeps its shape.
   */
  pskey?: Record<string, string>;
}

/** Events surfaced during a streaming flow. */
export type KeyEvent =
  | { kind: 'state'; state: string; message: string }
  | { kind: 'qrcode'; url: string }
  | { kind: 'qrcode-state'; state: string; stateCode?: number; uin?: string }
  | { kind: 'result'; result: KeyResult };

export interface QuickLoginStreamOptions {
  uin: string;
  /** Retained for API compatibility; the native flow enforces its own budget. */
  timeoutMs?: number;
}

export interface QrLoginStreamOptions {
  /** Retained for API compatibility; the native flow enforces its own budget. */
  timeoutMs?: number;
}

/**
 * EasyLogin `AppInfo` constants per platform. `appId` here is the EasyLogin
 * AppId — **not** the SSO `subAppId`, which is scanned from `major.node`.
 * `platform` is `NTLoginPlatform`: Windows=4 / Mac=5 / Linux=7.
 */
const APP_INFO: Record<string, { appId: number; os: string; platform: number }> = {
  win32: { appId: 1600001604, os: 'Windows', platform: 4 },
  darwin: { appId: 1600001602, os: 'Mac', platform: 5 },
  linux: { appId: 1600001615, os: 'Linux', platform: 7 },
};

export class KeyService {
  private readonly logger = getLogger().child({ scope: 'key' });

  constructor(private readonly platform: Platform) {}

  // -------------- alive-instance flow (not part of login) --------------

  /**
   * Ask a running, hooked QQ process for the dbkey of a specific account
   * database. The QQ process must already be logged in. Kept for the monitor
   * and other features that attach to a live QQ; login never calls it.
   */
  async fetchFromInstance(pid: number, dbPath: string): Promise<KeyResult> {
    this.logger.info('fetching database key from running instance', {
      event: 'fetch-key-from-instance',
      pid,
      dbPath,
    });
    try {
      const dbkey = await requestDecryptKeyFromInstance(this.platform.native.ntHelper, pid, dbPath);
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

  // -------------- 1. quick-login stream (pure protocol) --------------

  /**
   * Quick login: use the account's cached a1 + guid to fetch a2/d2/d2key and
   * (with key_meta) the dbkey in one native call. Yields `state` progress
   * events — including the phone-confirmation prompt when the server flags an
   * unusual device — then a terminal `result`.
   */
  quickLoginStream(opts: QuickLoginStreamOptions): AsyncIterable<KeyEvent> {
    return this.stream('quick', opts.uin);
  }

  // -------------- 2. QR-login stream (pure protocol) --------------

  /**
   * QR login: no usable a1. Yields a `qrcode` with the URL to render, a stream
   * of `qrcode-state` transitions, and finally `result`.
   */
  qrLoginStream(_opts: QrLoginStreamOptions = {}): AsyncIterable<KeyEvent> {
    return this.stream('qr', undefined);
  }

  // ---- helpers ----

  /**
   * Bridge the native login promise into an `AsyncIterable<KeyEvent>`. The
   * native call pushes events through `onEvent` while it runs; we re-emit them
   * in order and finish on the terminal result (or a thrown error).
   */
  private stream(mode: 'quick' | 'qr', uin: string | undefined): AsyncIterable<KeyEvent> {
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

    void (async (): Promise<void> => {
      const nt = this.platform.native.ntHelper;
      this.setDebugLog(nt, true);
      try {
        const options = await this.buildOptions(mode, uin);
        this.logger.info(`starting ${mode === 'quick' ? 'quick' : 'qr'}-login key flow`, {
          event: mode === 'quick' ? 'quick-login-start' : 'qr-login-start',
          accountUin: uin ?? null,
          subAppId: options.subAppId,
          os: options.os,
          platform: options.platform,
        });

        const onEvent = (err: Error | null, ev: QuickLoginEvent): void => {
          if (err) {
            this.logger.warn('login event callback error', {
              event: 'login-event-error',
              ...logErrorContext(err),
            });
            return;
          }
          for (const mapped of mapEvent(ev)) emit(mapped);
        };

        const res =
          mode === 'quick'
            ? await nt.quickLogin(options, onEvent)
            : await nt.qrLogin(options, onEvent);

        if (res.dbKey) {
          emit({ kind: 'result', result: { success: true, dbkey: res.dbKey } });
        } else {
          emit({
            kind: 'result',
            result: {
              success: false,
              error:
                '登录成功，但没有拿到数据库密钥（缺少 key_meta，请确认该账号的 nt_msg.db 存在）。',
            },
          });
        }
      } catch (e) {
        this.logger.warn('pure-protocol login failed', {
          event: mode === 'quick' ? 'quick-login-failed' : 'qr-login-failed',
          ...logErrorContext(e),
        });
        emit({ kind: 'result', result: { success: false, error: errorMessage(e) } });
      } finally {
        this.setDebugLog(nt, false);
        finish();
      }
    })();

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
            // Consumer abandoned the stream. The native flow cannot be aborted
            // mid-flight; it will settle on its own (its own deadline) and the
            // finally block still restores the debug flag.
            finish();
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    };
  }

  /** 组装 native 登录入参：三端常量 + major.node 扫描的 subAppId + 本地 a1/guid/uid。 */
  private async buildOptions(
    mode: 'quick' | 'qr',
    uin: string | undefined,
  ): Promise<QuickLoginOptions> {
    const nt = this.platform.native.ntHelper;
    const app = APP_INFO[this.platform.kind];
    if (!app) throw new Error(`不支持的平台：${this.platform.kind}`);

    const subAppId = this.resolveSubAppId(nt);
    const wrapperPath = this.platform.qqWrapperNodePath();
    if (!wrapperPath) {
      throw new Error('未找到 QQ 的 wrapper.node，无法为登录请求签名。');
    }

    const account = uin ? await this.findAccount(uin) : undefined;
    if (uin && !account) {
      throw new Error(`login.db 里没有账号 ${uin}，请先在 QQ 客户端登录一次。`);
    }
    const guid = account?.guid ?? resolveDeviceGuid(nt, this.platform);
    if (!guid) throw new Error('无法解析设备 guid，请先在 QQ 客户端登录一次。');

    let a1 = Buffer.alloc(0);
    if (mode === 'quick') {
      if (!account?.a1Payload) {
        throw new Error('该账号没有可用的 a1，请改用扫码登录。');
      }
      a1 = Buffer.from(account.a1Payload, 'hex');
      if (a1.length === 0) throw new Error('a1 解析失败，请先在 QQ 客户端登录一次。');
    }

    const keyMeta = uin ? this.keyMetaFor(uin) : null;

    return {
      uin: uin ?? '',
      a1,
      guid,
      appId: app.appId,
      subAppId,
      os: app.os,
      platform: app.platform,
      deviceName: hostname(),
      kernelVersion: release(),
      wrapperPath,
      ...(account?.uid ? { uid: account.uid } : {}),
      ...(keyMeta ? { keyMeta } : {}),
    };
  }

  /**
   * Scan the installed QQ build's appid from `major.node`. **When this is even
   * slightly uncertain we must not fall back to a stale constant**: a
   * mismatched subAppId gets the account kicked from the login list (140022017
   * side effect). So a missing/unparsable major.node is a hard error here.
   */
  private resolveSubAppId(nt: NtHelperBinding): number {
    const majorPath = this.platform.qqMajorNodePath();
    if (!majorPath) throw new Error('未找到 QQ 的 major.node，无法确定 subAppId。');
    let appid: number;
    try {
      appid = Number(nt.resolveAppidFromMajor(majorPath).appid);
    } catch (e) {
      throw new Error(`从 major.node 解析 subAppId 失败：${errorMessage(e)}`);
    }
    if (!Number.isSafeInteger(appid) || appid <= 0) {
      throw new Error('从 major.node 解析出的 subAppId 非法。');
    }
    return appid;
  }

  private async findAccount(uin: string): Promise<LoginAccount | undefined> {
    const accounts = await readLoginAccounts(this.platform);
    return accounts.find((a) => a.uin === uin);
  }

  /** 读该账号 `nt_msg.db` 头的 key_meta；库不存在 / 读不到时返回 null。 */
  private keyMetaFor(uin: string): string | null {
    const dbPath = this.platform.ntMsgDbPath(uin);
    if (!dbPath || !existsSync(dbPath)) return null;
    return readKeyMeta(dbPath);
  }

  /**
   * 调用获取密钥时开启原生 debug 日志（把每帧收发与解密后的明文写进
   * nt_helper 日志）；结束后立刻关掉，避免长时间刷盘。
   */
  private setDebugLog(nt: NtHelperBinding, enabled: boolean): void {
    try {
      nt.setDebugLog(enabled);
    } catch (e) {
      this.logger.warn('failed to toggle native debug log', {
        event: 'debug-log-toggle-failed',
        enabled,
        ...logErrorContext(e),
      });
    }
  }
}

// ---------- event mapping ------------------------------------------------

/** 把原生 `QuickLoginEvent` 映射成对外 `KeyEvent`（可能一条原生事件映射多条）。 */
function mapEvent(ev: QuickLoginEvent): KeyEvent[] {
  switch (ev.kind) {
    case 'state':
      return [
        {
          kind: 'state',
          state: ev.state ?? '',
          message: ev.message ?? '',
        },
      ];
    case 'unusual-device':
      return [
        {
          kind: 'state',
          state: 'unusual-device',
          message: ev.message ?? '当前设备被判定为异常设备，请在手机 QQ 上点击“确认登录”。',
        },
      ];
    case 'info':
      return [{ kind: 'state', state: 'info', message: ev.message ?? '' }];
    case 'qr-code':
      return ev.qrUrl ? [{ kind: 'qrcode', url: ev.qrUrl }] : [];
    case 'qr-state':
      return [
        {
          kind: 'qrcode-state',
          state: ev.state ?? '',
          ...(ev.stateCode !== undefined ? { stateCode: ev.stateCode } : {}),
          ...(ev.uin ? { uin: ev.uin } : {}),
        },
      ];
    default:
      return [];
  }
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
