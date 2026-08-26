// Discover QQ install paths + version + appid/qua.
//
// Mirrors napcat-core/helper/qq-basic-info.ts. 关键：appid/qua 必须跟当前
// QQ 版本严格匹配，否则后端会以 140022017 "请下载最新版QQ" 拒绝登录，
// 并把账号从历史登录列表里剔除（**有副作用，不要乱试**）。
//
// appid/qua 的正确值应由上层从 QQ 的 major.node 动态解析后传入
// （resolveQQInfo 的 opts.appid / opts.qua，Linux/Win 各自经 NINEBIRD_APPID /
// NINEBIRD_QUA 环境变量注入到 loader 进程）。这里不再维护静态版本表；
// 当上层没有传入时，退回到平台默认 appid + 正确格式的 qua（含 `_NQ_`）作为
// 最后兜底 —— 兜底值可能过时，仅用于避免完全无值。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface QQInfo {
    /** QQ.exe absolute path. */
    execPath: string;
    /** Resolved wrapper.node path. */
    wrapperPath: string;
    /** Full QQ version like "9.9.15-28953" or "9.9.15.28953". */
    fullVersion: string;
    /** Build id portion of the version (e.g. "28953"). */
    buildVer: string;
    /** Per-user QQ data path (where nt_qq lives). */
    dataPath: string;
    /** Per-user global data path. */
    dataPathGlobal: string;
    /** appid / qua used by the login service. */
    appid: string;
    qua: string;
}

interface VersionConfig {
    baseVersion: string;
    curVersion: string;
    prevVersion: string;
    onErrorVersions: string[];
    buildId: string;
}

function defaultVersionConfig(): VersionConfig {
    if (os.platform() === 'linux') {
        return {
            baseVersion: '3.2.12.28060',
            curVersion: '3.2.12.28060',
            prevVersion: '',
            onErrorVersions: [],
            buildId: '27254',
        };
    }
    if (os.platform() === 'darwin') {
        return {
            baseVersion: '6.9.53.28060',
            curVersion: '6.9.53.28060',
            prevVersion: '',
            onErrorVersions: [],
            buildId: '28060',
        };
    }
    return {
        baseVersion: '9.9.15-28131',
        curVersion: '9.9.15-28131',
        prevVersion: '',
        onErrorVersions: [],
        buildId: '28131',
    };
}

function getVersionConfigPath(execPath: string): string | undefined {
    let p: string | undefined;
    if (os.platform() === 'win32') {
        p = path.join(path.dirname(execPath), 'versions', 'config.json');
    } else if (os.platform() === 'darwin') {
        // QQ for macOS is sandboxed: user data lives inside the container.
        p = path.resolve(
            darwinContainerDataRoot(os.homedir()),
            './Library/Application Support/QQ/versions/config.json',
        );
    } else {
        p = path.resolve(os.homedir(), './.config/QQ/versions/config.json');
    }
    if (!fs.existsSync(p)) {
        p = os.platform() === 'darwin'
            ? path.join(path.dirname(execPath), '../Resources/app/versions/config.json')
            : path.join(path.dirname(execPath), './resources/app/versions/config.json');
    }
    return fs.existsSync(p) ? p : undefined;
}

function getPackageInfoPath(execPath: string, version: string): string {
    let p: string;
    if (os.platform() === 'darwin') {
        p = path.join(path.dirname(execPath), '..', 'Resources', 'app', 'package.json');
    } else if (os.platform() === 'linux') {
        p = path.join(path.dirname(execPath), './resources/app/package.json');
    } else {
        p = path.join(path.dirname(execPath), './versions/' + version + '/resources/app/package.json');
    }
    if (!fs.existsSync(p)) {
        p = path.join(path.dirname(execPath), './resources/app/versions/' + version + '/package.json');
    }
    return p;
}

function resolveWrapperPath(execPath: string, version: string): string {
    let appPath: string;
    if (os.platform() === 'darwin') {
        appPath = path.resolve(path.dirname(execPath), '../Resources/app');
    } else if (os.platform() === 'linux') {
        appPath = path.resolve(path.dirname(execPath), './resources/app');
    } else {
        appPath = path.resolve(path.dirname(execPath), `./versions/${version}/`);
    }
    let wp = path.resolve(appPath, 'wrapper.node');
    if (!fs.existsSync(wp)) {
        wp = path.join(appPath, './resources/app/wrapper.node');
    }
    if (!fs.existsSync(wp)) {
        wp = path.join(path.dirname(execPath), `./resources/app/versions/${version}/wrapper.node`);
    }
    if (!fs.existsSync(wp)) {
        throw new Error(`wrapper.node not found near ${execPath}`);
    }
    return wp;
}

/**
 * macOS 沙箱数据根归一化：QQ 进程内的 os.homedir() 可能是真实家目录，也可能
 * 直接就是容器路径（~/Library/Containers/com.tencent.qq/Data，App Sandbox 的
 * NSHomeDirectory 行为）。两种都要归一到容器 Data 根，否则会拼出“容器套
 * 容器”的嵌套路径（NT 在嵌套根下重建全新 profile，dbkey 对不上真实库）。
 */
function darwinContainerDataRoot(home: string): string {
    const containersTail = path.join('Library', 'Containers', 'com.tencent.qq');
    if (home.endsWith(path.join(containersTail, 'Data'))) return home;
    if (home.endsWith(containersTail)) return path.join(home, 'Data');
    return path.join(home, containersTail, 'Data');
}

function getDataPaths(execPath: string, getNTUserDataInfoConfig?: () => string): [string, string] {
    if (os.platform() === 'darwin') {
        // Same container root as the version config above (napcat installer
        // and @weq/platform both resolve it this way).
        // WeQ 侧把确切数据根经 NINEBIRD_DATA_ROOT 传进来（非沙箱路径一定
        // 正确）；没传才退回 homedir 推导（兼容两种 homedir 形态）。
        const envRoot = process.env.NINEBIRD_DATA_ROOT;
        const root = envRoot
            ? path.resolve(envRoot)
            : path.resolve(
                  darwinContainerDataRoot(os.homedir()),
                  './Library/Application Support/QQ',
              );
        return [root, path.join(root, 'global')];
    }
    let dataPath = getNTUserDataInfoConfig?.();
    if (!dataPath) {
        dataPath = path.resolve(os.homedir(), './.config/QQ');
        fs.mkdirSync(dataPath, { recursive: true });
    }
    // Linux 的 login.db 在 <dataPath>/global（裸 global，无 nt_qq 中间层）。
    // NapCat 用的 nt_qq/global 在 Linux 上是错的，会导致 getLoginList 读空库。
    // win32 保持 nt_qq/global 不变。
    if (os.platform() === 'linux') {
        return [dataPath, path.resolve(dataPath, './global')];
    }
    return [dataPath, path.resolve(dataPath, './nt_qq/global')];
}

function getAppIdFallback(): string {
    if (os.platform() === 'darwin' || os.platform() === 'linux') return '537246140';
    return '537246092';
}

function getQuaFallback(fullVersion: string, buildVer: string): string {
    // 关键：NapCat 的 QUA 格式是 V1_WIN_NQ_${ver}_${build}_GW_B，多了一个
    // 'NQ_' 段，而且 ver 跟 build 之间用下划线分隔（不是横杠）。
    // QQ 后端会校验这个字符串，格式错就 140022017 顺手踢账号。
    // ver 这里需要带点号格式 9.9.28 而非 9.9.28-46928。
    const verNoBuild = fullVersion.split('-')[0];
    if (os.platform() === 'darwin') return `V1_MAC_NQ_${verNoBuild}_${buildVer}_GW_B`;
    if (os.platform() === 'linux') return `V1_LNX_NQ_${verNoBuild}_${buildVer}_GW_B`;
    return `V1_WIN_NQ_${verNoBuild}_${buildVer}_GW_B`;
}

function resolveAppidAndQua(fullVersion: string, buildVer: string): { appid: string; qua: string } {
    // 无静态表：直接返回平台默认兜底。命中准确值靠上层从 major.node 解析后
    // 经 opts.appid / opts.qua 覆盖（见 resolveQQInfo）。
    return { appid: getAppIdFallback(), qua: getQuaFallback(fullVersion, buildVer) };
}

export interface ResolveOptions {
    /** Override appid (otherwise inferred from a default table). */
    appid?: string;
    /** Override qua. */
    qua?: string;
    /** Callback used to read NodeQQNTWrapperUtil.getNTUserDataInfoConfig once wrapper.node is loaded. */
    ntUserDataInfoConfig?: () => string;
}

/**
 * Resolve everything we need to drive a login flow from QQ's exec path.
 * `getNTUserDataInfoConfig` is optional -- if NineBird's caller has already
 * loaded wrapper.node it can pass that getter; otherwise the per-user
 * default (~/.config/QQ on linux, %USERPROFILE%\.config\QQ on win, etc.)
 * is used.
 */
export function resolveQQInfo(execPath: string, opts: ResolveOptions = {}): QQInfo {
    const versionConfigPath = getVersionConfigPath(execPath);
    const versionConfig: VersionConfig = versionConfigPath
        ? JSON.parse(fs.readFileSync(versionConfigPath, 'utf-8'))
        : defaultVersionConfig();
    const fullVersion = versionConfigPath ? versionConfig.curVersion : versionConfig.curVersion;

    const packagePath = getPackageInfoPath(execPath, fullVersion);
    let packageInfo: { version?: string; buildVersion?: string } = {};
    if (fs.existsSync(packagePath)) {
        packageInfo = JSON.parse(fs.readFileSync(packagePath, 'utf-8'));
    }
    const resolvedVersion = fullVersion || packageInfo.version || versionConfig.baseVersion;
    const buildVer =
        resolvedVersion.split('-')[1] ??
        resolvedVersion.split('.').slice(-1)[0] ??
        packageInfo.buildVersion ??
        versionConfig.buildId;

    const wrapperPath = resolveWrapperPath(execPath, resolvedVersion);
    const [dataPath, dataPathGlobal] = getDataPaths(execPath, opts.ntUserDataInfoConfig);

    const resolved = resolveAppidAndQua(resolvedVersion, buildVer);
    const appid = opts.appid ?? resolved.appid;
    const qua = opts.qua ?? resolved.qua;

    return {
        execPath,
        wrapperPath,
        fullVersion: resolvedVersion,
        buildVer,
        dataPath,
        dataPathGlobal,
        appid,
        qua,
    };
}

export function getPlatformType(): number {
    switch (os.platform()) {
        case 'win32': return 3;
        case 'darwin': return 4;
        case 'linux': return 5;
        default: return 3;
    }
}

export function getSystemHostname(): string {
    return os.hostname();
}

export function getSystemVersion(): string {
    return os.release();
}
