// 扫码登录 loader —— 抓 OidbSvcTrpcTcp.0xcde_2 数据库密钥（QR 流程）。
//
// 流程：拉二维码 → 轮询扫码状态 → 登录成功 → session.init + startNT →
// hook 抓 0xcde_2 → 顺路取 p_skey → pskey/result 双帧终结。
// 公共装配见 ./core/*，本文件只保留扫码流程特有的编排与文案。

import {
    NodeIKernelLoginListener,
    type NodeIKernelLoginService,
} from './wrapper-types';
import { resolveQQInfo } from './qq-info';
import { collectPskey } from './pskey';
import { createLogger } from './core/log';
import { PIPE_NAME, intEnv } from './core/env';
import { ensurePipeOpen, isShutdown, sendMessage, sendFinalExit, sendResultAndExit } from './core/pipe';
import { loadQQWrapper } from './core/wrapper';
import { loadHooker } from './core/hooker';
import { installDbkeyGate } from './core/dbkey';
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

// 【关键】：扫码流程需要人工介入，默认超时放宽到 3 分钟。
const TIMEOUT_MS = intEnv('NINEBIRD_TIMEOUT_MS', 180_000);
const log = createLogger('qr');
log(`loaded. PIPE_NAME=${PIPE_NAME} TIMEOUT_MS=${TIMEOUT_MS}`);

async function main(): Promise<void> {
    log('main() start');
    await ensurePipeOpen(log);

    // 全局超时保护（含扫码耗时）。
    setTimeout(() => {
        if (!isShutdown()) {
            void sendResultAndExit(false, 'NINEBIRD global timeout (Did you forget to scan?)');
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

        // dbkey 收到只 resolve gate —— 主流程接着取 pskey，两者一起在
        // sendFinalExit 里发出去。
        const dbkeyGate = installDbkeyGate(hooker);

        const { dataPath, dataPathGlobal } = resolveDataRoots(wrapper, qqInfo);
        log(`dataPath=${dataPath} dataPathGlobal=${dataPathGlobal}`);

        initEngine(wrapper, qqInfo, dataPathGlobal);
        const { startupSession, ntSession } = createWrapperSessions(wrapper);
        const o3Service = setupO3Misc(wrapper);
        const loginService: NodeIKernelLoginService = initLoginService(wrapper, qqInfo, dataPathGlobal);

        // 登录前第一阶段环境探针上报（防风控核心）。
        const ts = amgomPreLogin(o3Service);

        // ========== 二维码轮询与验证核心模块 ==========
        let loginUid = '';
        let loginUin = '';

        await new Promise<void>((resolve, reject) => {
            const listener = new NodeIKernelLoginListener();

            listener.onLoginConnected = () => {
                // 连接成功后，等待 MSF 网络就绪，然后获取二维码
                const waitForMsfAndGetQr = async (): Promise<void> => {
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
                void sendMessage({
                    kind: 'qrcode-state',
                    state: `状态码异常 Type:${errType} Code:${errCode}，正在重新拉取二维码...`,
                });
                // 不论是过期还是网络波动，直接重新获取
                loginService.getQRCodePicture();
            };

            listener.onQRCodeLoginSucceed = (loginResult) => {
                loginUid = loginResult.uid;
                loginUin = String(loginResult.uin);
                void sendMessage({
                    kind: 'qrcode-state',
                    state: `扫码成功！当前登录账号 UIN: ${loginUin}`,
                });
                resolve();
            };

            listener.onUserLoggedIn = (userid: string) => {
                void sendResultAndExit(
                    false,
                    `无法登录: 当前系统内账号 (${userid}) 状态异常或已在登录状态。`,
                );
            };

            listener.onLoginFailed = (...args) => {
                void sendResultAndExit(false, `Kernel Core 登录遭遇硬失败: ${JSON.stringify(args)}`);
            };

            loginService.addKernelLoginListener(listener);
            const ok = loginService.connect();
            if (!ok) reject(new Error('loginService.connect() 初始化失败 (返回 false)'));
        });
        // ==============================================

        // 登录成功后，执行第二阶段环境参数上报及数据碎片设定（防风控核心）。
        const guid = amgomPostLogin(o3Service, loginService, qqInfo.appid, ts);

        const sessionConfig = buildSessionConfig(qqInfo, dataPath, loginUin, loginUid, guid);

        if (!ntSession) {
            return sendResultAndExit(false, 'ntSession 实例创建失败');
        }
        const otelGate = makeOtelGate(ntSession, sessionConfig);

        fireSession(startupSession, ntSession);

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
        log(`main() threw: ${String(error)}`);
        void sendResultAndExit(false, String(error));
    }
}

main().catch((err) => {
    log(`main() rejected: ${String(err)}`);
    void sendResultAndExit(false, String(err));
});
