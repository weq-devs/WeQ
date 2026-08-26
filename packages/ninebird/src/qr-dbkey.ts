import net from 'node:net';
import {
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
    WrapperSessionInitConfig
} from './wrapper-types';
import { getPlatformType, getSystemHostname, getSystemVersion, resolveQQInfo } from './qq-info';
import { collectPskey, type PskeyResult } from './pskey';
import fs from 'node:fs';
import path from 'node:path';

const PIPE_NAME  = process.env.NINEBIRD_PIPE_NAME || '';
// 【关键修改】：扫码流程需要人工介入，默认超时时间放宽到 3 分钟 (180000ms)
const TIMEOUT_MS = parseInt(process.env.NINEBIRD_TIMEOUT_MS || '180000', 10);

// ---- 统一日志（见 quick-dbkey.ts 说明）------------------------------------
const NB_LOG = process.env.NINEBIRD_LOG || '';
function nbLog(msg: string): void {
    if (!NB_LOG) return;
    try {
        fs.appendFileSync(NB_LOG, `[loader:qr pid=${process.pid}] ${msg}\n`);
    } catch { /* 尽力而为 */ }
}
nbLog(`loaded. PIPE_NAME=${PIPE_NAME} TIMEOUT_MS=${TIMEOUT_MS}`);

//
// Pipe 协议：每条消息一行 NDJSON。
//   { kind: 'qrcode',       url: string }
//   { kind: 'qrcode-state', state: string }
//   { kind: 'pskey',        success: boolean, pskey?: Record<string,string>, error?: string }
//   { kind: 'result',       success: boolean, dbkey?: string, error?: string }
//
// `result` 是终结帧 —— 消费端收到它就 kill 掉 QQ，所以 pskey 必须排在它前面。
//

let pipeClient: net.Socket | null = null;
let shutdownCalled = false;
let dbkey: string | null = null;

function ensurePipeOpen(): Promise<void> {
    if (!PIPE_NAME)   { nbLog('ensurePipeOpen: PIPE_NAME empty, skip'); return Promise.resolve(); }
    if (pipeClient)   return Promise.resolve();
    nbLog(`ensurePipeOpen: connecting to ${PIPE_NAME}`);
    return new Promise((resolve) => {
        const c = net.createConnection(PIPE_NAME);
        const onReady = () => {
            c.removeListener('error', onErr);
            pipeClient = c;
            nbLog('ensurePipeOpen: connected');
            c.on('error', () => process.exit(1));
            resolve();
        };
        const onErr = (e: Error) => {
            c.removeListener('connect', onReady);
            nbLog(`ensurePipeOpen: connect FAILED: ${e && e.message}`);
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

async function sendFinalExit(
    dbkeyResult: { success: boolean; dbkey?: string; error?: string },
    psKeyResult: PskeyResult,
): Promise<void> {
    if (shutdownCalled) return;
    shutdownCalled = true;

    // pskey 先于 result —— 消费端收到 result 即终结流程，后续帧会丢。
    try { await sendMessage({ kind: 'pskey', ...psKeyResult }); } catch {}
    try { await sendMessage({ kind: 'result', ...dbkeyResult }); } catch {}

    if (!pipeClient) {
        process.exit(dbkeyResult.success ? 0 : 1);
    }
    pipeClient!.end(() => {
        setTimeout(() => process.exit(0), 100);
    });
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
    if (!fs.existsSync(wrapperNodePath)) {
        wrapperNodePath = path.join(path.dirname(execPath), `./resources/app/versions/${qqVersion}/wrapper.node`);
    }
    const nativemodule: { exports: WrapperNodeApi } = { exports: {} as WrapperNodeApi };
    process.dlopen(nativemodule, wrapperNodePath);
    process.env['NAPCAT_WRAPPER_PATH'] = wrapperNodePath;
    return nativemodule.exports;
}

async function main() {
    nbLog('main() start');
    await ensurePipeOpen();

    // 设定全局超时保护
    setTimeout(() => {
        if (!shutdownCalled) {
            void sendResultAndExit(false, 'NINEBIRD global timeout (Did you forget to scan?)');
        }
    }, TIMEOUT_MS);

    try {
        const qqInfo = resolveQQInfo(process.execPath, {
            appid: process.env.NINEBIRD_APPID || undefined,
            qua: process.env.NINEBIRD_QUA || undefined,
        });
        const wrapper = loadQQWrapper(qqInfo.execPath, qqInfo.fullVersion);

        const loaderDir = process.env.NINEBIRD_LOADER_DIR
            || (process.env.NINEBIRD_LOAD_PATH ? path.dirname(process.env.NINEBIRD_LOAD_PATH) : __dirname);
        const hookerPath = path.join(loaderDir, 'NineBird.node');

        if (!fs.existsSync(hookerPath)) {
            return sendResultAndExit(false, `NineBird.node not found: ${hookerPath}`);
        }
        const hooker = require(hookerPath);

        const isPrintableAscii = (b: number) => b >= 0x20 && b <= 0x7E;

        // dbkey 不再直接终结流程 —— 收到后只 resolve gate，让主流程接着去取
        // pskey，两者一起在 sendFinalExit 里发出去。
        let resolveDbkey!: (key: string) => void;
        let rejectDbkey!: (err: Error) => void;
        const dbkeyGate = new Promise<string>((res, rej) => { resolveDbkey = res; rejectDbkey = rej; });

        // 挂载 0xcde_2 数据库密钥拦截 Hook
        hooker.installRecvHook((ev: any) => {
            const hex = ev.hex_data as string;
            if (!hex || (!hex.startsWith('08de19') && !hex.startsWith('08DE19'))) return;

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
            if (process.platform === 'darwin') {
                // 与 linux 一致：数据根取真实 per-user 路径，global 是数据根下
                // 的裸 global（darwin/linux 都没有 nt_qq 层）。macOS 沙箱内
                // wrapper 的 getNTUserDataInfoConfig 和 os.homedir 都会拼出
                // “容器套容器”的嵌套根（NT 在嵌套根下重建全新 profile，dbkey
                // 对不上真实库），所以用 WeQ 经 NINEBIRD_DATA_ROOT 传入的
                // 确切路径（非沙箱侧解析，必然正确）。
                const root = process.env.NINEBIRD_DATA_ROOT || realDataPath;
                realDataPath = path.resolve(root);
                dataPathGlobal = path.resolve(root, './global');
            } else {
                const util = (wrapper as any).NodeQQNTWrapperUtil;
                const real = util?.getNTUserDataInfoConfig?.();
                if (real) {
                    realDataPath = real;
                    dataPathGlobal = process.platform === 'linux'
                        ? path.resolve(real, './global')
                        : path.resolve(real, './nt_qq/global');
                }
            }
        } catch (e) {
            // 解析失败就保留 qq-info 的兜底路径。
        }
        nbLog(`dataPath=${realDataPath} dataPathGlobal=${dataPathGlobal}`);

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
        } catch (e) {}

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

        // 登录前执行第一阶段环境探针上报（防风控核心）
        const ts = Date.now().toString();
        o3Service.reportAmgomWeather('login', 'a1', [ts, '0', '0']);

        // ========== 二维码轮询与验证核心模块 ==========
        let loginUid = '';
        let loginUin = '';

        await new Promise<void>((resolve, reject) => {
            const listener = new NodeIKernelLoginListener();

            listener.onLoginConnected = () => {
                // 连接成功后，等待 MSF 网络就绪，然后获取二维码
                const waitForMsfAndGetQr = async () => {
                    for (let tries = 0; ; tries++) {
                        const s = loginService.getMsfStatus();
                        if (s !== 3) break; // !== 3 意味着网络已连接 (0或1)
                        if (tries > 60) {
                            return reject(new Error('等待 MSF 网络连接超时（30s）'));
                        }
                        await new Promise((r) => setTimeout(r, 500));
                    }
                    // MSF 就绪，拉取二维码
                    loginService.getQRCodePicture();
                };
                waitForMsfAndGetQr().catch(reject);
            };

            listener.onQRCodeGetPicture = (data) => {
                void sendMessage({ kind: 'qrcode', url: data.qrcodeUrl });
            };

            listener.onQRCodeSessionFailed = (errType, errCode) => {
                void sendMessage({ kind: 'qrcode-state', state: `状态码异常 Type:${errType} Code:${errCode}，正在重新拉取二维码...` });
                // 不论是过期还是网络波动，直接重新获取
                loginService.getQRCodePicture();
            };

            // listener.onLoginState = ( data )=> {
            //     void sendMessage({ kind: 'qrcode-state', state: JSON.stringify( data ) });
            // }

            listener.onQRCodeLoginSucceed = (loginResult) => {
                loginUid = loginResult.uid;
                loginUin = String(loginResult.uin);
                void sendMessage({ kind: 'qrcode-state', state: `扫码成功！当前登录账号 UIN: ${loginUin}` });
                resolve();
            };

            listener.onUserLoggedIn = (userid: string) => {
                void sendResultAndExit(false, `无法登录: 当前系统内账号 (${userid}) 状态异常或已在登录状态。`);
            };

            listener.onLoginFailed = (...args) => {
                void sendResultAndExit(false, `Kernel Core 登录遭遇硬失败: ${JSON.stringify(args)}`);
            };

            loginService.addKernelLoginListener(listener);
            const ok = loginService.connect();
            if (!ok) reject(new Error('loginService.connect() 初始化失败 (返回 false)'));
        });
        // ==============================================

        // 登录成功后，执行第二阶段环境参数上报及数据碎片设定（防风控核心）
        const amgomDataPiece = 'eb1fd6ac257461580dc7438eb099f23aae04ca679f4d88f53072dc56e3bb1129';
        o3Service.setAmgomDataPiece(qqInfo.appid, new Uint8Array(Buffer.from(amgomDataPiece, 'hex')));

        let guid = loginService.getMachineGuid();
        guid = guid.slice(0, 8) + '-' + guid.slice(8, 12) + '-' + guid.slice(12, 16) + '-' + guid.slice(16, 20) + '-' + guid.slice(20);
        o3Service.reportAmgomWeather('login', 'a6', [ts, '184', '329']);

        // 初始化会话配置
        const downloadPath = path.join(realDataPath, 'NapCat', 'temp');
        try { fs.mkdirSync(downloadPath, { recursive: true }); } catch {}

        const platformType = (getPlatformType() as unknown as PlatformType);
        const sessionConfig: WrapperSessionInitConfig = {
            selfUin: loginUin,  // <== 这里采用扫码后动态获得的 UIN
            selfUid: loginUid,  // <== 这里采用扫码后动态获得的 UID
            desktopPathConfig: {
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
            return sendResultAndExit(false, 'ntSession 实例创建失败');
        }

        // 初始化 Session 并等待 OpenTelemetry 配置完毕
        const otelGate = new Promise<void>((resolveOtel, rejectOtel) => {
            const sessListener = new NodeIKernelSessionListener();
            sessListener.onOpentelemetryInit = (info) => {
                if (info.is_init) resolveOtel();
                else rejectOtel(new Error('OpenTelemetry 探针初始化失败'));
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

        // dbkey 等到 0xcde_2 到达（扫码后通常几秒内）。全局 TIMEOUT_MS 已含扫码
        // 耗时，这里给一个从「启动完成」起算的独立窗口即可。
        const dbkeyResult = await Promise.race([
            dbkeyGate.then((key) => ({ success: true, dbkey: key })),
            new Promise<{ success: false; error: string }>((res) =>
                setTimeout(() => res({ success: false, error: 'dbkey timeout' }), 60_000),
            ),
        ]).catch((e: Error) => ({ success: false as const, error: e.message }));

        // 等底层依赖完成（给 15s 容错）；OTEL 失败不阻断 —— 但 pskey 要等它，
        // 因为 TipOffService 在 session 完全就绪前调用会拿不到票据。
        await Promise.race([
            otelGate,
            new Promise((_, rej) => setTimeout(() => rej(new Error('OpenTelemetry init timeout')), 15000)),
        ]).catch(() => {});

        await sendFinalExit(dbkeyResult, await collectPskey(ntSession!));

    } catch (error) {
        nbLog(`main() threw: ${String(error)}`);
        void sendResultAndExit(false, String(error));
    }
}

main().catch((err) => {
    nbLog(`main() rejected: ${String(err)}`);
    void sendResultAndExit(false, String(err));
});
