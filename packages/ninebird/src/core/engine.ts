// 引擎 / 会话装配 —— quick / qr / account-list 三条流程共用的公共段。
//
// 这里只放「逐字节相同」的代码：数据根解析、engine 初始化、session 实例
// 创建、loginService.initConfig、amgom 环境探针上报、WrapperSessionInitConfig
// 构建、otel gate 与会话点火。三条流程的**差异**（扫码 vs 快登 vs 只读列表）
// 全部留在各入口文件里。
//
// ⚠️ 本文件内任何一行都是登录成功路径的一部分：字段名/取值/调用顺序与
// 旧实现严格一致（appid/qua 错一个字符就会被 QQ 后端 140022017 拒绝）。

import fs from 'node:fs';
import path from 'node:path';
import {
    NodeIDependsAdapter,
    NodeIDispatcherAdapter,
    NodeIGlobalAdapter,
    NodeIKernelSessionListener,
    NodeIO3MiscListener,
    PlatformType,
    VendorType,
    type NodeIKernelLoginService,
    type NodeIQQNTStartupSessionWrapperInstance,
    type NodeIQQNTWrapperEngine,
    type NodeIQQNTWrapperSessionInstance,
    type NodeIO3MiscService,
    type WrapperNodeApi,
    type WrapperSessionInitConfig,
} from '../wrapper-types';
import { getPlatformType, getSystemHostname, getSystemVersion, type QQInfo } from '../qq-info';
import { DATA_ROOT } from './env';

/** 数据根 + global 子目录（quick / qr 语义；account-list 只用 global 字段）。 */
export interface DataRoots {
    dataPath: string;
    dataPathGlobal: string;
}

/**
 * 解析真实数据路径。macOS 沙箱内 wrapper 的 getNTUserDataInfoConfig 和
 * os.homedir 都会拼出「容器套容器」的嵌套根（NT 在嵌套根下重建全新
 * profile，dbkey 对不上真实库），所以用 WeQ 经 NINEBIRD_DATA_ROOT 传入的
 * 确切路径（非沙箱侧解析，必然正确）；其它平台问 wrapper，失败则保留
 * qq-info 的兜底路径。darwin/linux 的 global 都是数据根下的裸 global
 * （没有 nt_qq 中间层），win32 保持 nt_qq/global。
 */
export function resolveDataRoots(wrapper: WrapperNodeApi, qqInfo: QQInfo): DataRoots {
    let dataPath = qqInfo.dataPath;
    let dataPathGlobal = qqInfo.dataPathGlobal;
    try {
        if (process.platform === 'darwin') {
            const root = DATA_ROOT || dataPath;
            dataPath = path.resolve(root);
            dataPathGlobal = path.resolve(root, './global');
        } else {
            const util = wrapper.NodeQQNTWrapperUtil;
            const real = util?.getNTUserDataInfoConfig?.();
            if (real) {
                dataPath = real;
                dataPathGlobal =
                    process.platform === 'linux'
                        ? path.resolve(real, './global')
                        : path.resolve(real, './nt_qq/global');
            }
        }
    } catch {
        // 解析失败就保留 qq-info 的兜底路径。
    }
    return { dataPath, dataPathGlobal };
}

/** engine.initWithDeskTopConfig（三条流程逐字节相同）。 */
export function initEngine(
    wrapper: WrapperNodeApi,
    qqInfo: QQInfo,
    dataPathGlobal: string,
): void {
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
}

/**
 * 创建 StartupSession + NT session。startupSession 走新接口
 * NodeIQQNTStartupSessionWrapper.create()；ntSession 新版本走
 * getNTWrapperSession('nt_1')，老版本回退 create()。任一失败都静默
 * （ntSession 为 null 时由调用方决定怎么退出）。
 */
export function createWrapperSessions(wrapper: WrapperNodeApi): {
    startupSession: NodeIQQNTStartupSessionWrapperInstance | null;
    ntSession: NodeIQQNTWrapperSessionInstance | null;
} {
    let startupSession: NodeIQQNTStartupSessionWrapperInstance | null = null;
    let ntSession: NodeIQQNTWrapperSessionInstance | null = null;
    try {
        const startupCtor = wrapper.NodeIQQNTStartupSessionWrapper as
            | { create?(): NodeIQQNTStartupSessionWrapperInstance }
            | undefined;
        if (startupCtor?.create) {
            startupSession = startupCtor.create();
        }
        const sessCtor = wrapper.NodeIQQNTWrapperSession as
            | {
                  getNTWrapperSession?(name: string): NodeIQQNTWrapperSessionInstance;
                  create?(): NodeIQQNTWrapperSessionInstance;
              }
            | undefined;
        if (sessCtor?.getNTWrapperSession) {
            ntSession = sessCtor.getNTWrapperSession('nt_1');
        } else if (sessCtor?.create) {
            ntSession = sessCtor.create();
        }
    } catch {
        // 保持 null —— 调用方兜底。
    }
    return { startupSession, ntSession };
}

/** O3Misc listener 注册（wrapper 的 C++ 侧要求 getOnAmgomDataPiece 存在）。 */
export function setupO3Misc(wrapper: WrapperNodeApi): NodeIO3MiscService {
    const o3Service = wrapper.NodeIO3MiscService.get();
    o3Service.addO3MiscListener(new NodeIO3MiscListener());
    return o3Service;
}

/** loginService.initConfig（三条流程逐字节相同）。 */
export function initLoginService(
    wrapper: WrapperNodeApi,
    qqInfo: QQInfo,
    dataPathGlobal: string,
): NodeIKernelLoginService {
    const loginService = wrapper.NodeIKernelLoginService.get();
    loginService.initConfig({
        machineId: '',
        appid: qqInfo.appid,
        platVer: getSystemVersion(),
        commonPath: dataPathGlobal,
        clientVer: qqInfo.fullVersion,
        hostName: getSystemHostname(),
        externalVersion: false,
    });
    return loginService;
}

/**
 * 登录前第一阶段环境探针上报（防风控核心）。返回本次流程的时间戳，
 * 后面的 a6 上报要复用同一个 ts。
 */
export function amgomPreLogin(o3Service: NodeIO3MiscService): string {
    const ts = Date.now().toString();
    o3Service.reportAmgomWeather('login', 'a1', [ts, '0', '0']);
    return ts;
}

/**
 * 登录成功后第二阶段：环境参数上报 + 数据碎片设定（防风控核心）。
 * 顺带把 loginService.getMachineGuid() 格式化成带连字符的形式并返回
 * （sessionConfig 的 deviceInfo.guid 用）。
 */
export function amgomPostLogin(
    o3Service: NodeIO3MiscService,
    loginService: NodeIKernelLoginService,
    appid: string,
    ts: string,
): string {
    const amgomDataPiece =
        'eb1fd6ac257461580dc7438eb099f23aae04ca679f4d88f53072dc56e3bb1129';
    o3Service.setAmgomDataPiece(appid, new Uint8Array(Buffer.from(amgomDataPiece, 'hex')));

    const raw = loginService.getMachineGuid();
    const guid =
        raw.slice(0, 8) +
        '-' +
        raw.slice(8, 12) +
        '-' +
        raw.slice(12, 16) +
        '-' +
        raw.slice(16, 20) +
        '-' +
        raw.slice(20);

    o3Service.reportAmgomWeather('login', 'a6', [ts, '184', '329']);
    return guid;
}

/**
 * 构建 session.init 的第一个参数。字段名/类型必须与 wrapper 期望严格一致，
 * 否则 wrapper 会拒绝甚至挂掉。account_path 必须是真实数据路径（静态解析
 * 的路径会导致 dbkey 对不上库）。
 */
export function buildSessionConfig(
    qqInfo: QQInfo,
    dataPath: string,
    selfUin: string,
    selfUid: string,
    guid: string,
): WrapperSessionInitConfig {
    const downloadPath = path.join(dataPath, 'NapCat', 'temp');
    try {
        fs.mkdirSync(downloadPath, { recursive: true });
    } catch {}

    const platformType = getPlatformType() as unknown as PlatformType;
    return {
        selfUin,
        selfUid,
        desktopPathConfig: {
            account_path: dataPath,
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
}

/** session.init + 等 OpenTelemetry 探针就绪（is_init=true 才算 session ready）。 */
export function makeOtelGate(
    ntSession: NodeIQQNTWrapperSessionInstance,
    sessionConfig: WrapperSessionInitConfig,
): Promise<void> {
    return new Promise<void>((resolveOtel, rejectOtel) => {
        const sessListener = new NodeIKernelSessionListener();
        sessListener.onOpentelemetryInit = (info) => {
            if (info.is_init) resolveOtel();
            else rejectOtel(new Error('OpenTelemetry 探针初始化失败'));
        };
        ntSession.init(
            sessionConfig,
            new NodeIDependsAdapter(),
            new NodeIDispatcherAdapter(),
            sessListener,
        );
    });
}

/**
 * wrapper 的 NT 协议栈点火：调完这一刻 wrapper 才会去后端拉本地数据库密钥，
 * OidbSvcTrpcTcp.0xcde_2 包就在这里发出来。新版本接受 0；老版本不接收参数。
 */
export function fireSession(
    startupSession: NodeIQQNTStartupSessionWrapperInstance | null,
    ntSession: NodeIQQNTWrapperSessionInstance,
): void {
    if (startupSession) {
        startupSession.start();
    } else {
        try {
            ntSession.startNT(0);
        } catch {
            ntSession.startNT();
        }
    }
}
