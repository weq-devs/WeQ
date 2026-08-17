import net from 'node:net';
import {
    LoginListItem,
    NodeIDependsAdapter,
    NodeIDispatcherAdapter,
    NodeIGlobalAdapter,
    NodeIKernelLoginListener,
    NodeIKernelLoginService,
    NodeIKernelSessionListener,
    NodeIO3MiscListener,
    NodeIQQNTStartupSessionWrapperInstance,
    NodeIQQNTWrapperEngine,
    NodeIQQNTWrapperSessionInstance,
    PlatformType,
    VendorType,
    WrapperNodeApi,
    WrapperSessionInitConfig,
    // NodeIKernelTicketService
} from './wrapper-types';
import {getPlatformType, getSystemHostname, getSystemVersion, resolveQQInfo} from './qq-info';
import {collectPskey, type PskeyResult} from './pskey';
import fs from 'node:fs';
import path from 'node:path';

const TARGET_UIN = process.env.NINEBIRD_TARGET_UIN || '';
const PIPE_NAME  = process.env.NINEBIRD_PIPE_NAME || '';
const TIMEOUT_MS = parseInt(process.env.NINEBIRD_TIMEOUT_MS || '30000', 10);

// ---- 统一日志 -------------------------------------------------------------
// 与 addon / launcher.so 共用 NINEBIRD_LOG，串起整条注入链。loader 跑在 QQ
// 进程里、stdio 常被重定向到 /dev/null（headless），所以必须落文件才看得到。
// 这行日志一旦出现，就证明：stub 被 require、真实 loader 也加载了。
// const NB_LOG = process.env.NINEBIRD_LOG || '';
// function nbLog(msg: string): void {
//     if (!NB_LOG) return;
//     try {
//         fs.appendFileSync(NB_LOG, `[loader:quick pid=${process.pid}] ${msg}\n`);
//     } catch { /* 日志尽力而为，不影响主流程 */ }
// }
// nbLog(`loaded. PIPE_NAME=${PIPE_NAME} TARGET_UIN=${TARGET_UIN} TIMEOUT_MS=${TIMEOUT_MS}`);

//
// Pipe 协议：每条消息一行 NDJSON。
//   { kind: 'login-list', list: LoginListSummary[] }
//   { kind: 'result',     success: boolean, dbkey?: string, error?: string }
//
// 一条连接的整个生命周期就是 quick-dbkey.js 进程的生命周期，发完 result 再 end。
//

let pipeClient: net.Socket | null = null;
let shutdownCalled = false;
let dbkey: string | null = null;

function ensurePipeOpen(): Promise<void> {
    if (!PIPE_NAME)   {
        // nbLog('ensurePipeOpen: PIPE_NAME empty, skip'); return Promise.resolve();
    }
    if (pipeClient)   return Promise.resolve();
    // nbLog(`ensurePipeOpen: connecting to ${PIPE_NAME}`);
    return new Promise((resolve) => {
        const c = net.createConnection(PIPE_NAME);
        const onReady = () => {
            c.removeListener('error', onErr);
            pipeClient = c;
            // nbLog('ensurePipeOpen: connected');
            // 之后 pipe 出问题就直接退，没法再恢复
            c.on('error', () => process.exit(1));
            resolve();
        };
        const onErr = (_e: Error) => {
            c.removeListener('connect', onReady);
            // 连不上就当没有 pipe，让 sendResultAndExit 走 process.exit 兜底
            // nbLog(`ensurePipeOpen: connect FAILED: ${e && e.message}`);
            resolve();
        };
        c.once('connect', onReady);
        c.once('error', onErr);
    });
}

function sendMessage(obj: object): Promise<void> {
    if (!pipeClient) return Promise.resolve();
    return new Promise((resolve) => {
        pipeClient!.write(JSON.stringify(obj) + '\n', () => resolve());
    });
}

async function sendResultAndExit(success: boolean, error?: string): Promise<void> {
    if (shutdownCalled) return;
    shutdownCalled = true;

    const result = {
        kind:    'result',
        success,
        dbkey:   dbkey || undefined,
        error:   error || undefined,
    };

    if (!pipeClient) {
        process.exit(success ? 0 : 1);
    }

    try { await sendMessage(result); } catch {}
    pipeClient!.end(() => {
        setTimeout(() => process.exit(0), 100);
    });
}

async function sendFinalExit(dbkeyResult: { success: boolean; dbkey?: string; error?: string }, psKeyResult: PskeyResult): Promise<void> {
    if (shutdownCalled) return;
    shutdownCalled = true;

    // pskey 必须先发：消费端收到 `result` 就认为流程终结并 kill 掉 QQ + pipe，
    // 之后再发的帧会丢。
    try { await sendMessage({ kind: 'pskey', ...psKeyResult }); } catch {}
    try { await sendMessage({ kind: 'result', ...dbkeyResult }); } catch {}

    if (!pipeClient) {
        process.exit(dbkeyResult.success ? 0 : 1);
    }
    pipeClient!.end(() => {
        setTimeout(() => process.exit(0), 100);
    });
}


function summarizeLoginList(items: LoginListItem[]) {
    return items
        .filter((u) => u.isQuickLogin)
        .map((u) => ({
            uin:          u.uin,
            uid:          u.uid,
            nickName:     u.nickName,
            faceUrl:      u.faceUrl,
            facePath:     u.facePath,
            loginType:    u.loginType,
            isQuickLogin: u.isQuickLogin,
            isAutoLogin:  u.isAutoLogin,
        }));
}

function loadQQWrapper(execPath: string, qqVersion: string): WrapperNodeApi {
    if (process.env['NAPCAT_WRAPPER_PATH']) {
        const wrapperPath = process.env['NAPCAT_WRAPPER_PATH'];
        const nativemodule: { exports: WrapperNodeApi } = { exports: {} as WrapperNodeApi };
        process.dlopen(nativemodule, wrapperPath);
        return nativemodule.exports;
    }
    if (!execPath) {
        throw new Error('无法加载 Wrapper，execPath 未定义');
    }
    let appPath: string;
    if (process.platform === 'darwin') {
        appPath = path.resolve(path.dirname(execPath), '../Resources/app');
    } else if (process.platform === 'linux') {
        appPath = path.resolve(path.dirname(execPath), './resources/app');
    } else {
        appPath = path.resolve(path.dirname(execPath), `./versions/${qqVersion}/`);
    }
    let wrapperNodePath = path.resolve(appPath, 'wrapper.node');
    if (!fs.existsSync(wrapperNodePath)) {
        wrapperNodePath = path.join(appPath, './resources/app/wrapper.node');
    }
    // 老版本兼容
    if (!fs.existsSync(wrapperNodePath)) {
        wrapperNodePath = path.join(path.dirname(execPath), `./resources/app/versions/${qqVersion}/wrapper.node`);
    }
    const nativemodule: { exports: WrapperNodeApi } = { exports: {} as WrapperNodeApi };
    process.dlopen(nativemodule, wrapperNodePath);
    process.env['NAPCAT_WRAPPER_PATH'] = wrapperNodePath;
    return nativemodule.exports;
}

async function main() {
    // nbLog('main() start');
    await ensurePipeOpen();

    if (!TARGET_UIN) {
        return sendResultAndExit(false, 'NINEBIRD_TARGET_UIN not set');
    }

    // 超时保护
    setTimeout(() => {
        if (!shutdownCalled) {
            // nbLog('main() internal TIMEOUT_MS reached');
            void sendResultAndExit(false, 'timeout');
        }
    }, TIMEOUT_MS);

    try {
        // nbLog('resolving QQ info + loading wrapper');
        const qqInfo = resolveQQInfo(process.execPath, {
            appid: process.env.NINEBIRD_APPID || undefined,
            qua: process.env.NINEBIRD_QUA || undefined,
        });

        const wrapper = loadQQWrapper(qqInfo.execPath, qqInfo.fullVersion);
        // nbLog(`wrapper loaded. appid=${qqInfo.appid} qua=${qqInfo.qua} ver=${qqInfo.fullVersion}`);

        const loaderDir = process.env.NINEBIRD_LOADER_DIR
            || (process.env.NINEBIRD_LOAD_PATH ? path.dirname(process.env.NINEBIRD_LOAD_PATH) : __dirname);
        const hookerPath = path.join(loaderDir, 'NineBird.node');

        if (!fs.existsSync(hookerPath)) {
            return sendResultAndExit(false, `NineBird.node not found: ${hookerPath}`);
        }
        const hooker = require(hookerPath);
        // nbLog('NineBird.node required, installing recv hook');

        const isPrintableAscii = (b: number) => b >= 0x20 && b <= 0x7E;
        let resolveDbkey!: (key: string) => void;
        let rejectDbkey!: (err: Error) => void;
        const dbkeyGate = new Promise<string>((res, rej) => { resolveDbkey = res; rejectDbkey = rej; });

        hooker.installRecvHook((ev: any) => {
            const hex = ev.hex_data as string;

            if (!hex || (!hex.startsWith('08de19') && !hex.startsWith('08DE19'))) {
                return;
            }

            const buf = Buffer.from(hex, 'hex');
            for (let i = 0; i + 18 <= buf.length; i++) {
                if (buf[i] !== 0x0A || buf[i + 1] !== 0x10) continue;
                const start = i + 2;
                const slice = buf.slice(start, start + 16);
                let allAscii = true;
                for (let k = 0; k < 16; k++) {
                    if (!isPrintableAscii(slice[k])) { allAscii = false; break; }
                }
                if (allAscii) {
                    dbkey = slice.toString('ascii');
                    resolveDbkey(dbkey);
                    return;
                }
                rejectDbkey(new Error('0xcde_2 包里 16 字节段含非 ASCII 字节，dbkey 获取失败'));
                return;
            }

            rejectDbkey(new Error('0xcde_2 包里没有 "0A 10" 标记，dbkey 获取失败'));
        });

        let realDataPath = qqInfo.dataPath;
        let dataPathGlobal = qqInfo.dataPathGlobal;

        try {
            const util = (wrapper as any).NodeQQNTWrapperUtil;
            const real = util?.getNTUserDataInfoConfig?.();

            if (real) {
                realDataPath = real;
                dataPathGlobal = process.platform === 'linux'
                    ? path.resolve(real, './global')
                    : path.resolve(real, './nt_qq/global');
            }
        } catch (e) {
        }

        const engine: NodeIQQNTWrapperEngine = wrapper.NodeIQQNTWrapperEngine.get();

        engine.initWithDeskTopConfig(
            {
                base_path_prefix: '',
                platform_type: getPlatformType(),
                app_type: 4,
                app_version: qqInfo.fullVersion,
                os_version: getSystemVersion(),
                use_xlog: false,
                qua: qqInfo.qua,
                global_path_config: { desktopGlobalPath: dataPathGlobal },
                thumb_config: { maxSide: 324, minSide: 48, longLimit: 6, density: 2 },
            },
            new NodeIGlobalAdapter(),
        );

        let startupSession: NodeIQQNTStartupSessionWrapperInstance | null = null;
        let ntSession: NodeIQQNTWrapperSessionInstance | null = null;
        try {
            const startupCtor = (wrapper as any).NodeIQQNTStartupSessionWrapper;
            if (startupCtor?.create) {
                startupSession = startupCtor.create();
            }
            const sessCtor = (wrapper as any).NodeIQQNTWrapperSession;
            if (sessCtor?.getNTWrapperSession) {
                ntSession = sessCtor.getNTWrapperSession('nt_1');
            } else if (sessCtor?.create) {
                ntSession = sessCtor.create();
            }
        } catch (e) {
        }

        const o3Service = wrapper.NodeIO3MiscService.get();
        o3Service.addO3MiscListener(new NodeIO3MiscListener());

        const loginService: NodeIKernelLoginService = wrapper.NodeIKernelLoginService.get();
        loginService.initConfig({
            machineId: '',
            appid: qqInfo.appid,
            platVer: getSystemVersion(),
            commonPath: dataPathGlobal,
            clientVer: qqInfo.fullVersion,
            hostName: getSystemHostname(),
            externalVersion: false,
        });

        // nbLog('calling getLoginList()');
        const loginList = await loginService.getLoginList();
        // nbLog(`getLoginList() returned ${loginList.LocalLoginInfoList.length} accounts`);

        // 拿到历史登录列表先发一条出去，验证 pipe 的多次接收能力
        await sendMessage({
            kind: 'login-list',
            list: summarizeLoginList(loginList.LocalLoginInfoList),
        });

        if (!loginList.LocalLoginInfoList.some((u) => u.uin === TARGET_UIN)) {
            return sendResultAndExit(false, `uin ${TARGET_UIN} 不在历史登录列表，无法 quickLogin（请先在 QQ 客户端登录一次）`);
        }

        const ts = Date.now().toString();
        o3Service.reportAmgomWeather('login', 'a1', [ts, '0', '0']);


        // nbLog('waiting for loginService.connect() -> onLoginConnected');
        await new Promise<void>((resolve, reject) => {
            const listener = new NodeIKernelLoginListener();
            listener.onLoginConnected = () => { resolve(); };
            listener.onUserLoggedIn = (userid: string) => {
                void sendResultAndExit(false, `userid=${userid} have logged in!`);
            };
            listener.onLoginFailed = (...args) => {
                void sendResultAndExit(false, `login failed: ${JSON.stringify(args)}`);
            };

            loginService.addKernelLoginListener(listener);
            const ok = loginService.connect();

            if (!ok) {
                reject(new Error('loginService.connect() returned false'));
            }
            setTimeout(() => reject(new Error('connect timeout')), 10000);
        });

        // nbLog('login connected, waiting MSF status');
        for (let tries = 0; ; tries++) {
            const s = loginService.getMsfStatus();

            if (s !== 3) break;
            if (tries > 60) {
                return sendResultAndExit(false, '等待 MSF 网络连接超时（30s）');
            }
            await new Promise((r) => setTimeout(r, 500));
        }
        // nbLog('MSF ready, calling quickLoginWithUin');

        let loginUid = '';
        const uidGate = new Promise<void>((resolveUid) => {
            const uidListener = new NodeIKernelLoginListener();
            uidListener.onQRCodeLoginSucceed = (loginResult) => {
                loginUid = loginResult.uid;
                resolveUid();
            };
            loginService.addKernelLoginListener(uidListener);
        });

        const res = await loginService.quickLoginWithUin(TARGET_UIN);
        // nbLog(`quickLoginWithUin returned result=${res.result} err=${res.loginErrorInfo?.errMsg || ''}`);

        const success = res.result === '0' && !res.loginErrorInfo?.errMsg;

        if (!success) {
            const errMsg = res.loginErrorInfo?.errMsg || `quick login failed: ${res.result}`;
            return sendResultAndExit(false, errMsg);
        }
        // nbLog('quick login OK, waiting session init + recv hook to catch dbkey');

        // quickLogin 成功后 onQRCodeLoginSucceed 几乎立刻触发；给 5s 兜底。
        await Promise.race([
            uidGate,
            new Promise((_, rej) => setTimeout(() => rej(new Error('wait uid timeout')), 5000)),
        ]);


        const amgomDataPiece = 'eb1fd6ac257461580dc7438eb099f23aae04ca679f4d88f53072dc56e3bb1129';
        o3Service.setAmgomDataPiece(qqInfo.appid, new Uint8Array(Buffer.from(amgomDataPiece, 'hex')));


        let guid = loginService.getMachineGuid();
        guid = guid.slice(0, 8) + '-' + guid.slice(8, 12) + '-' + guid.slice(12, 16) + '-' + guid.slice(16, 20) + '-' + guid.slice(20);

        o3Service.reportAmgomWeather('login', 'a6', [ts, '184', '329']);


        const downloadPath = path.join(realDataPath, 'NapCat', 'temp');
        try { fs.mkdirSync(downloadPath, { recursive: true }); } catch {}

        const platformType = (getPlatformType() as unknown as PlatformType);
        const sessionConfig: WrapperSessionInitConfig = {
            selfUin: TARGET_UIN,
            selfUid: loginUid,
            desktopPathConfig: {
                // 【最致命的修复】：将 account_path 设为真实的路径，而不是静态解析的路径
                account_path: realDataPath
            },
            clientVer: qqInfo.fullVersion,
            a2: '',
            d2: '',
            d2Key: '',
            machineId: '',
            platform: platformType,
            platVer: getSystemVersion(),
            appid: qqInfo.appid,
            rdeliveryConfig: {
                appKey: '',
                systemId: 0,
                appId: '',
                logicEnvironment: '',
                platform: platformType,
                language: '',
                sdkVersion: '',
                userId: '',
                appVersion: '',
                osVersion: '',
                bundleId: '',
                serverUrl: '',
                fixedAfterHitKeys: [''],
            },
            defaultFileDownloadPath: downloadPath,
            deviceInfo: {
                guid,
                buildVer: qqInfo.fullVersion,
                localId: 2052,
                devName: getSystemHostname(),
                devType: 'Windows',
                vendorName: '',
                osVer: getSystemVersion(),
                vendorOsName: 'Windows',
                setMute: false,
                vendorType: VendorType.KNOSETONIOS,
            },
            deviceConfig: '{"appearance":{"isSplitViewMode":true},"msg":{}}',
        };

        if (!ntSession) {
            return sendResultAndExit(false, 'ntSession is null, cannot init');
        }
        const otelGate = new Promise<void>((resolveOtel, rejectOtel) => {
            const sessListener = new NodeIKernelSessionListener();
            sessListener.onOpentelemetryInit = (info) => {
                if (info.is_init) resolveOtel();
                else rejectOtel(new Error('opentelemetry init failed'));
            };
            ntSession!.init(
                sessionConfig,
                new NodeIDependsAdapter(),
                new NodeIDispatcherAdapter(),
                sessListener,
            );
        });

        if (startupSession) {
            startupSession.start();
        } else {
            try {
                ntSession.startNT(0);
            } catch {
                ntSession.startNT();
            }
        }


        const dbkeyResult = await Promise.race([
            dbkeyGate.then((key) => ({ success: true, dbkey: key, error: undefined })),
            new Promise<{ success: false; dbkey: undefined; error: string }>((res) =>
                setTimeout(() => res({ success: false, dbkey: undefined, error: 'dbkey timeout' }), TIMEOUT_MS)
            ),
        ]);

        await Promise.race([
            otelGate,
            new Promise((_, rej) => setTimeout(() => rej(new Error('opentelemetry init timeout')), 15000)),
        ]).catch(() => {});

        await sendFinalExit(dbkeyResult, await collectPskey(ntSession!));


    } catch (error) {
        // nbLog(`main() threw: ${String(error)}`);
        void sendResultAndExit(false, String(error));
    }
}

main().catch((err) => {
    // nbLog(`main() rejected: ${String(err)}`);
    void sendResultAndExit(false, String(err));
});
