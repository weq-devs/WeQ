// 快速登录 loader —— 用缓存的 uin 直接 quickLogin，抓 0xcde_2 数据库密钥。
//
// 流程：getLoginList（先发一帧 login-list）→ 校验目标 uin → connect →
// MSF 就绪 → quickLoginWithUin → session.init + startNT → hook 抓 0xcde_2
// → 顺路取 p_skey → pskey/result 双帧终结。
// 公共装配见 ./core/*，本文件只保留快登流程特有的编排与文案。

import {
    NodeIKernelLoginListener,
    type NodeIKernelLoginService,
} from './wrapper-types';
import { resolveQQInfo } from './qq-info';
import { collectPskey } from './pskey';
import { createLogger } from './core/log';
import { PIPE_NAME, TARGET_UIN, intEnv } from './core/env';
import {
    ensurePipeOpen,
    isShutdown,
    sendMessage,
    sendFinalExit,
    sendResultAndExit,
} from './core/pipe';
import { loadQQWrapper } from './core/wrapper';
import { loadHooker } from './core/hooker';
import { installDbkeyGate } from './core/dbkey';
import { summarizeLoginList } from './core/login-list';
import {
    amgomPostLogin,
    amgomPreLogin,
    buildSessionConfig,
    createWrapperSessions,
    fireSession,
    initEngine,
    initLoginService,
    makeOtelGate,
    resolveDataRoots,
    setupO3Misc,
} from './core/engine';

const TIMEOUT_MS = intEnv('NINEBIRD_TIMEOUT_MS', 30_000);
const log = createLogger('quick');
log(`loaded. PIPE_NAME=${PIPE_NAME} TIMEOUT_MS=${TIMEOUT_MS}`);

async function main(): Promise<void> {
    log('main() start');
    await ensurePipeOpen(log);

    if (!TARGET_UIN) {
        return sendResultAndExit(false, 'NINEBIRD_TARGET_UIN not set');
    }

    // 超时保护。
    setTimeout(() => {
        if (!isShutdown()) {
            void sendResultAndExit(false, 'timeout');
        }
    }, TIMEOUT_MS);

    try {
        const qqInfo = resolveQQInfo(process.execPath, {
            appid: process.env.NINEBIRD_APPID || undefined,
            qua: process.env.NINEBIRD_QUA || undefined,
        });

        const wrapper = loadQQWrapper(qqInfo.execPath, qqInfo.fullVersion);

        const loaded = loadHooker();
        if (!loaded.ok) {
            return sendResultAndExit(false, `NineBird.node not found: ${loaded.path}`);
        }
        const hooker = loaded.hooker;

        const dbkeyGate = installDbkeyGate(hooker);

        const { dataPath, dataPathGlobal } = resolveDataRoots(wrapper, qqInfo);
        log(`dataPath=${dataPath} dataPathGlobal=${dataPathGlobal}`);

        initEngine(wrapper, qqInfo, dataPathGlobal);
        const { startupSession, ntSession } = createWrapperSessions(wrapper);
        const o3Service = setupO3Misc(wrapper);
        const loginService: NodeIKernelLoginService = initLoginService(wrapper, qqInfo, dataPathGlobal);

        const loginList = await loginService.getLoginList();

        // 拿到历史登录列表先发一条出去（消费端靠它展示可选账号）。
        await sendMessage({
            kind: 'login-list',
            list: summarizeLoginList(loginList.LocalLoginInfoList),
        });

        if (!loginList.LocalLoginInfoList.some((u) => u.uin === TARGET_UIN)) {
            return sendResultAndExit(
                false,
                `uin ${TARGET_UIN} 不在历史登录列表，无法 quickLogin（请先在 QQ 客户端登录一次）`,
            );
        }

        // 登录前第一阶段环境探针上报（防风控核心）。
        const ts = amgomPreLogin(o3Service);

        await new Promise<void>((resolve, reject) => {
            const listener = new NodeIKernelLoginListener();
            listener.onLoginConnected = () => {
                resolve();
            };
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

        for (let tries = 0; ; tries++) {
            const s = loginService.getMsfStatus();
            if (s !== 3) break;
            if (tries > 60) {
                return sendResultAndExit(false, '等待 MSF 网络连接超时（30s）');
            }
            await new Promise((r) => setTimeout(r, 500));
        }

        // quickLogin 成功后 onQRCodeLoginSucceed 几乎立刻触发 —— 挂个
        // listener 抓 uid（sessionConfig 的 selfUid 用），给 5s 兜底。
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

        const success = res.result === '0' && !res.loginErrorInfo?.errMsg;
        if (!success) {
            const errMsg = res.loginErrorInfo?.errMsg || `quick login failed: ${res.result}`;
            return sendResultAndExit(false, errMsg);
        }

        await Promise.race([
            uidGate,
            new Promise((_, rej) => setTimeout(() => rej(new Error('wait uid timeout')), 5000)),
        ]);

        // 登录成功后，执行第二阶段环境参数上报及数据碎片设定（防风控核心）。
        const guid = amgomPostLogin(o3Service, loginService, qqInfo.appid, ts);

        const sessionConfig = buildSessionConfig(qqInfo, dataPath, TARGET_UIN, loginUid, guid);

        if (!ntSession) {
            return sendResultAndExit(false, 'ntSession is null, cannot init');
        }
        const otelGate = makeOtelGate(ntSession, sessionConfig);

        fireSession(startupSession, ntSession);

        const dbkeyResult = await Promise.race([
            dbkeyGate.then((key) => ({ success: true, dbkey: key, error: undefined })),
            new Promise<{ success: false; dbkey: undefined; error: string }>((res) =>
                setTimeout(() => res({ success: false, dbkey: undefined, error: 'dbkey timeout' }), TIMEOUT_MS),
            ),
        ]);

        await Promise.race([
            otelGate,
            new Promise((_, rej) => setTimeout(() => rej(new Error('opentelemetry init timeout')), 15000)),
        ]).catch(() => {});

        await sendFinalExit(dbkeyResult, await collectPskey(ntSession!));
    } catch (error) {
        log(`main() threw: ${String(error)}`);
        void sendResultAndExit(false, String(error));
    }
}

main().catch((err) => {
    log(`main() rejected: ${String(err)}`);
    void sendResultAndExit(false, String(err));
});
