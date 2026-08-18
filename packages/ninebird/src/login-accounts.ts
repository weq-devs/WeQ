import net from 'node:net';
import {
    LoginListItem,
    NodeIGlobalAdapter,
    NodeIKernelLoginService,
    NodeIO3MiscListener,
    NodeIQQNTWrapperEngine,
    WrapperNodeApi,
} from './wrapper-types';
import {getPlatformType, getSystemHostname, getSystemVersion, resolveQQInfo} from './qq-info';
import fs from 'node:fs';
import path from 'node:path';
const PIPE_NAME  = process.env.NINEBIRD_PIPE_NAME || '';
const TIMEOUT_MS = parseInt(process.env.NINEBIRD_TIMEOUT_MS || '30000', 10);


const NB_LOG = process.env.NINEBIRD_LOG || '';
function nbLog(msg: string): void {
    if (!NB_LOG) return;
    try {
        fs.appendFileSync(NB_LOG, `[loader:account pid=${process.pid}] ${msg}\n`);
    } catch { /* 尽力而为 */ }
}
nbLog(`loaded. PIPE_NAME=${PIPE_NAME} TIMEOUT_MS=${TIMEOUT_MS}`);

//
// Pipe 协议：每条消息一行 NDJSON。
//   { kind: 'login-list', list: LoginListSummary[] }
//   { kind: 'result',     success: boolean, error?: string }
//

let pipeClient: net.Socket | null = null;
let shutdownCalled = false;

function ensurePipeOpen(): Promise<void> {
    if (!PIPE_NAME)   {
        nbLog('ensurePipeOpen: PIPE_NAME empty, skip'); return Promise.resolve();
    }
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

    // 超时保护
    setTimeout(() => {
        if (!shutdownCalled) {
            void sendResultAndExit(false, 'timeout');
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


        hooker.installRecvHook((ev: any) => {
            const hex = ev.hex_data as string;
            // 没错，这就是0xcde_2
            if (!hex || (!hex.startsWith('08de19') && !hex.startsWith('08DE19'))) {
                return;
            }
        });
        let dataPathGlobal = qqInfo.dataPathGlobal;

        try {
            const util = (wrapper as any).NodeQQNTWrapperUtil;
            const real = util?.getNTUserDataInfoConfig?.();

            if (real) {
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
        try {
            const startupCtor = (wrapper as any).NodeIQQNTStartupSessionWrapper;
            if (startupCtor?.create) {
                startupCtor.create();
            }
            const sessCtor = (wrapper as any).NodeIQQNTWrapperSession;
            if (sessCtor?.getNTWrapperSession) {
                sessCtor.getNTWrapperSession('nt_1');
            } else if (sessCtor?.create) {
                sessCtor.create();
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

        const loginList = await loginService.getLoginList();

        await sendMessage({
            kind: 'login-list',
            list: summarizeLoginList(loginList.LocalLoginInfoList),
        });

        return sendResultAndExit(true);

    } catch (error) {
        nbLog(`main() threw: ${String(error)}`);
        void sendResultAndExit(false, String(error));
    }
}

main().catch((err) => {
    nbLog(`main() rejected: ${String(err)}`);
    void sendResultAndExit(false, String(err));
});