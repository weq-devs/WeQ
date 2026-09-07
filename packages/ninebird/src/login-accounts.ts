// 账号列表 loader —— 只读：让 QQ 自己枚举本地历史登录账号。
//
// 不抓 dbkey：hook 只挂一个空过滤（保持与旧实现一致的行为），拿到
// login-list 一帧后即成功终结。用于解密 login.db 失败时的兜底数据源。
// 公共装配见 ./core/*。

import { resolveQQInfo } from './qq-info';
import { createLogger } from './core/log';
import { PIPE_NAME, intEnv } from './core/env';
import { ensurePipeOpen, isShutdown, sendMessage, sendResultAndExit } from './core/pipe';
import { loadQQWrapper } from './core/wrapper';
import { loadHooker } from './core/hooker';
import { summarizeLoginList } from './core/login-list';
import {
    createWrapperSessions,
    initEngine,
    initLoginService,
    resolveDataRoots,
    setupO3Misc,
} from './core/engine';

const TIMEOUT_MS = intEnv('NINEBIRD_TIMEOUT_MS', 30_000);
const log = createLogger('account');
log(`loaded. PIPE_NAME=${PIPE_NAME} TIMEOUT_MS=${TIMEOUT_MS}`);

async function main(): Promise<void> {
    log('main() start');
    await ensurePipeOpen(log);

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

        // 只挂空过滤 hook —— 拦下 0xcde_2 但不做任何事（与旧实现一致）。
        hooker.installRecvHook((ev) => {
            const hex = ev.hex_data;
            // 没错，这就是0xcde_2
            if (!hex || (!hex.startsWith('08de19') && !hex.startsWith('08DE19'))) {
                return;
            }
        });

        // account-list 只需要 global 路径（engine / loginService 配置用）。
        const { dataPathGlobal } = resolveDataRoots(wrapper, qqInfo);

        initEngine(wrapper, qqInfo, dataPathGlobal);
        // session 实例只为触发 wrapper 内部的初始化副作用，本身不用。
        createWrapperSessions(wrapper);
        setupO3Misc(wrapper);
        const loginService = initLoginService(wrapper, qqInfo, dataPathGlobal);

        const loginList = await loginService.getLoginList();

        await sendMessage({
            kind: 'login-list',
            list: summarizeLoginList(loginList.LocalLoginInfoList),
        });

        return sendResultAndExit(true);
    } catch (error) {
        log(`main() threw: ${String(error)}`);
        void sendResultAndExit(false, String(error));
    }
}

main().catch((err) => {
    log(`main() rejected: ${String(err)}`);
    void sendResultAndExit(false, String(err));
});
