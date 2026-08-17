// NineBird -- in-process QQ NT login driver that captures the
// OidbSvcTrpcTcp.0xcde_2 database passphrase.
//
// Usage:
//
//   import { createNineBird } from 'ninebird';
//
//   const nb = createNineBird({
//       qqExecPath: 'C:/Program Files/Tencent/QQNT/QQ.exe',
//       nativeModulePath: '/abs/path/to/NineBird.win32-x64.node',
//   });
//
//   nb.on('passphrase', (key) => {
//       console.log('captured key:', key);
//       nb.shutdown();
//   });
//
//   await nb.initHook();
//
//   const list = await nb.getLoginList();
//   if (list.length > 0) {
//       const ok = await nb.quickLogin(list[0].uin);
//       if (!ok) await nb.getQRCode();
//   } else {
//       await nb.getQRCode();
//   }
//
// The instance exits the entire login flow as soon as 'passphrase' fires.
// We do not initialize a session, register adapters, or stay connected --
// the only goal is to observe the 0xcde_2 packet during login.

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

import {
    LoginListItem,
    NineBirdNative,
    NodeIGlobalAdapter,
    NodeIKernelLoginListener,
    NodeIKernelLoginService,
    NodeIO3MiscListener,
    NodeIO3MiscService,
    NodeIQQNTWrapperEngine,
    NodeQQNTWrapperUtil,
    QRCodeLoginSucceedResult,
    QuickLoginResult,
    RecvEvent,
    WrapperNodeApi,
} from './wrapper-types';
import { extractCde2Passphrase } from './oidb-cde2';
import { getPlatformType, getSystemHostname, getSystemVersion, QQInfo, resolveQQInfo } from './qq-info';

export interface NineBirdOptions {
    /** Absolute path to QQ.exe (Windows) / QQ binary (Linux/macOS). */
    qqExecPath: string;
    /**
     * Absolute path to NineBird.<platform>.node. This is REQUIRED -- we
     * never hardcode the location because callers may ship the .node next
     * to their own bundle, or extract it from a zip at runtime.
     */
    nativeModulePath: string;
    /** Optional appid override. */
    appid?: string;
    /** Optional qua override. */
    qua?: string;
    /** Optional onQRCode listener (you can also subscribe via .on('qrcode')). */
    onQRCode?: (data: { url: string; pngBase64: string }) => void;
}

export interface QRCodePayload {
    url: string;
    pngBase64: string;
}

type NineBirdEvents = {
    /** The captured 0xcde_2 database passphrase. Fires at most once. */
    passphrase: [string];
    /** Login QR code refreshed (initial or after expiry). */
    qrcode: [QRCodePayload];
    /** QR-code login succeeded -- carries uin/uid. */
    'login-success': [QRCodeLoginSucceedResult];
    /** QR-code session failed (expiry, network, ...) */
    'login-error': [{ errType: number; errCode: number }];
    /** Any unexpected error during init. */
    error: [Error];
};

export interface NineBird extends EventEmitter {
    on<K extends keyof NineBirdEvents>(event: K, listener: (...args: NineBirdEvents[K]) => void): this;
    once<K extends keyof NineBirdEvents>(event: K, listener: (...args: NineBirdEvents[K]) => void): this;
    emit<K extends keyof NineBirdEvents>(event: K, ...args: NineBirdEvents[K]): boolean;
}

export class NineBird extends EventEmitter {
    private readonly opts: NineBirdOptions;
    private native: NineBirdNative | null = null;
    private wrapper: WrapperNodeApi | null = null;
    private loginService: NodeIKernelLoginService | null = null;
    private engine: NodeIQQNTWrapperEngine | null = null;
    private o3Service: NodeIO3MiscService | null = null;
    private qqInfo: QQInfo | null = null;
    private listenerId: number = 0;
    private installed = false;
    private gotPassphrase = false;
    private shutdownCalled = false;

    constructor(opts: NineBirdOptions) {
        super();
        this.opts = opts;
        if (opts.onQRCode) this.on('qrcode', opts.onQRCode);
    }

    /**
     * Load wrapper.node + NineBird.node, install the recv hook, then
     * initialise the QQ engine + login service. After this resolves the
     * caller is ready to invoke getLoginList / quickLogin / getQRCode.
     *
     * Throws if wrapper.node cannot be located, the native module is
     * missing, or the recv-hook scan fails.
     */
    async initHook(): Promise<void> {
        if (this.installed) {
            throw new Error('NineBird: initHook already called');
        }
        if (!fs.existsSync(this.opts.nativeModulePath)) {
            throw new Error(
                `NineBird: nativeModulePath does not exist: ${this.opts.nativeModulePath}`,
            );
        }

        // 1. Discover QQ paths + version + appid.
        this.qqInfo = resolveQQInfo(this.opts.qqExecPath, {
            appid: this.opts.appid,
            qua: this.opts.qua,
        });

        // 2. Load wrapper.node into this process. process.dlopen mutates the
        // first arg's .exports the same way require('wrapper.node') would.
        //
        // On Windows wrapper.node depends on a pile of sibling DLLs that
        // live next to it (QQNT.dll, ThumbPlayer.dll, api-ms-win-*, ...).
        // The system loader resolves them via the standard PATH search,
        // so we prepend the wrapper directory before dlopen and restore
        // PATH afterward to avoid polluting the host process.
        //
        // napcat does not need this step because it runs INSIDE QQ.exe
        // (injected via a DLL), so its cwd / PATH already include the QQ
        // install root. Standalone Node / Electron must opt in.
        const wrapperContainer: { exports: WrapperNodeApi } = {
            exports: {} as WrapperNodeApi,
        };
        const savedPath = process.env.PATH;
        if (process.platform === 'win32') {
            const wrapperDir = path.dirname(this.qqInfo.wrapperPath);
            process.env.PATH = wrapperDir + path.delimiter + (savedPath ?? '');
        }
        try {
            process.dlopen(wrapperContainer, this.qqInfo.wrapperPath);
        } finally {
            process.env.PATH = savedPath;
        }
        this.wrapper = wrapperContainer.exports;

        // 3. Load NineBird.node and install the recv hook.
        const nativeContainer: { exports: NineBirdNative } = {
            exports: {} as NineBirdNative,
        };
        process.dlopen(nativeContainer, this.opts.nativeModulePath);
        this.native = nativeContainer.exports;

        this.native.installRecvHook((ev) => this.onRecv(ev));
        this.installed = true;

        // 4. Refresh data paths now that we can ask wrapper.node where
        // they really live (overrides the per-user-default fallback).
        try {
            const util = (this.wrapper as unknown as { NodeQQNTWrapperUtil: NodeQQNTWrapperUtil })
                .NodeQQNTWrapperUtil;
            const real = util.getNTUserDataInfoConfig?.();
            if (real) {
                this.qqInfo.dataPath = real;
                this.qqInfo.dataPathGlobal = path.resolve(real, './nt_qq/global');
            }
        } catch {
            // ignore -- the fallback path is fine for the login service
        }

        // 5. Initialise engine + login service. We do NOT initialise a
        // session -- 0xcde_2 is pushed by the server during the login
        // handshake, before a session would normally be opened.
        this.engine = this.wrapper.NodeIQQNTWrapperEngine.get();
        this.engine.initWithDeskTopConfig(
            {
                base_path_prefix: '',
                platform_type: getPlatformType(),
                app_type: 4,
                app_version: this.qqInfo.fullVersion,
                os_version: getSystemVersion(),
                use_xlog: false,
                qua: this.qqInfo.qua,
                global_path_config: { desktopGlobalPath: this.qqInfo.dataPathGlobal },
                thumb_config: { maxSide: 324, minSide: 48, longLimit: 6, density: 2 },
            },
            // NodeIGlobalAdapter contains several stub methods that the 
            // wrapper expects -- passing {} fails TS validation and
            // can cause runtime login issues.
            new NodeIGlobalAdapter(),
        );

        this.o3Service = this.wrapper.NodeIO3MiscService.get();
        this.o3Service.addO3MiscListener(new NodeIO3MiscListener());

        this.loginService = this.wrapper.NodeIKernelLoginService.get();
        this.loginService.initConfig({
            machineId: '',
            appid: this.qqInfo.appid,
            platVer: getSystemVersion(),
            commonPath: this.qqInfo.dataPathGlobal,
            clientVer: this.qqInfo.fullVersion,
            hostName: getSystemHostname(),
            externalVersion: false,
        });

        // 6. Wire login listener, then connect. The listener's
        // onLoginConnected fires once the MSF connection is established
        // and getLoginList / quickLogin become legal.
        await new Promise<void>((resolve, reject) => {
            const listener = new NodeIKernelLoginListener();
            const originalConnected = listener.onLoginConnected;
            listener.onLoginConnected = () => {
                originalConnected.call(listener);
                resolve();
            };
            listener.onQRCodeGetPicture = (arg) => {
                const base64 = arg.pngBase64QrcodeData.replace(/^data:image\/\w+;base64,/, '');
                this.emit('qrcode', { url: arg.qrcodeUrl, pngBase64: base64 });
            };
            listener.onQRCodeLoginSucceed = (result) => {
                this.emit('login-success', result);
            };
            listener.onQRCodeSessionFailed = (errType, errCode) => {
                this.emit('login-error', { errType, errCode });
                // Auto-refresh on expiry, mirroring NapCat behaviour.
                if (errType === 1 && errCode === 3) {
                    this.loginService?.getQRCodePicture();
                }
            };
            listener.onLoginFailed = (...args) => {
                this.emit('error', new Error(`login failed: ${JSON.stringify(args)}`));
            };

            this.listenerId = this.loginService!.addKernelLoginListener(listener);
            const connectOk = this.loginService!.connect();
            if (!connectOk) {
                reject(new Error('NineBird: loginService.connect() returned false'));
            }
            // Safety net: if onLoginConnected never fires, fail after 30 s.
            setTimeout(() => reject(new Error('NineBird: timed out waiting for onLoginConnected')), 30_000)
                .unref();
        });

        // 7. The amgom "weather" report is what NapCat does before login.
        // Empirically required to keep the login server happy before
        // 0xcde_2 is dispatched.
        const ts = Date.now().toString();
        this.o3Service.reportAmgomWeather('login', 'a1', [ts, '0', '0']);
    }

    /** Returns the locally cached QQ accounts that support quick login. */
    async getLoginList(): Promise<LoginListItem[]> {
        this.requireReady();
        const res = await this.loginService!.getLoginList();
        return res.LocalLoginInfoList.filter((item) => item.isQuickLogin);
    }

    /**
     * Trigger QR-code generation. Subscribe to the 'qrcode' event to
     * receive `{ url, pngBase64 }`. Returns true if the request was
     * dispatched (you still wait for the event).
     */
    getQRCode(): boolean {
        this.requireReady();
        return this.loginService!.getQRCodePicture();
    }

    /**
     * Attempt a quick login with `uin`. Resolves true on success; on
     * failure refreshes the QR code (mirroring NapCat fallback) and
     * resolves false.
     */
    async quickLogin(uin: string): Promise<boolean> {
        this.requireReady();
        try {
            const res: QuickLoginResult = await this.loginService!.quickLoginWithUin(uin);
            const ok = res.result === '0' && !res.loginErrorInfo?.errMsg;
            if (!ok) {
                this.loginService!.getQRCodePicture();
                return false;
            }
            return true;
        } catch (e) {
            this.emit('error', e instanceof Error ? e : new Error(String(e)));
            this.loginService!.getQRCodePicture();
            return false;
        }
    }

    /** Returns the captured passphrase, or null if not yet received. */
    getDbPassphrase(): string | null {
        return this.dbPassphrase;
    }

    /** Resolves with the passphrase once captured; rejects on shutdown without one. */
    waitForPassphrase(): Promise<string> {
        if (this.dbPassphrase) return Promise.resolve(this.dbPassphrase);
        return new Promise((resolve, reject) => {
            this.once('passphrase', (key) => resolve(key));
            this.once('error', (e) => reject(e));
        });
    }

    /**
     * Uninstall the recv hook and detach the login listener. Safe to call
     * multiple times. After shutdown the process can exit cleanly.
     *
     * Note: wrapper.node and NineBird.node are not unloaded -- Node's
     * process.dlopen does not support unloading. The caller should exit
     * the process when done.
     */
    shutdown(): void {
        if (this.shutdownCalled) return;
        this.shutdownCalled = true;
        try {
            if (this.listenerId && this.loginService) {
                this.loginService.removeKernelLoginListener(this.listenerId);
            }
        } catch {
            // ignore
        }
        try {
            this.native?.uninstallRecvHook();
        } catch {
            // ignore
        }
    }

    // --- internals ----------------------------------------------------------

    private dbPassphrase: string | null = null;

    private onRecv(ev: RecvEvent): void {
        if (this.gotPassphrase) return;
        if (ev.cmd !== 'OidbSvcTrpcTcp.0xcde_2') return;
        const key = extractCde2Passphrase(ev.hex_data);
        if (key) {
            this.dbPassphrase = key;
            this.gotPassphrase = true;
            this.emit('passphrase', key);
        }
    }

    private requireReady(): void {
        if (!this.installed || !this.loginService) {
            throw new Error('NineBird: initHook() has not completed -- call it first');
        }
    }
}

/** Convenience factory. */
export function createNineBird(opts: NineBirdOptions): NineBird {
    return new NineBird(opts);
}

// Re-export types callers may need.
export type { LoginListItem, QRCodeLoginSucceedResult, RecvEvent } from './wrapper-types';
