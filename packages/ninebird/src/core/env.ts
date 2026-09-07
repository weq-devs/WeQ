// NINEBIRD_* 环境变量集中读取 —— 三个 loader 共用的启动配置。
//
// 这些变量由启动方注入（WeQ 的 native 侧 launchQQ / darwin boot / linux
// 入口 stub），loader 只读：管道名、超时、目标 uin、appid/qua、数据根与
// loader 目录。缺省语义见各字段注释。

/** 控制管道（win32 named pipe / unix socket）；空 = 不走管道直接 process.exit。 */
export const PIPE_NAME = process.env.NINEBIRD_PIPE_NAME || '';

/** quick-login 的目标账号；空 = quick 流程直接报错退出。 */
export const TARGET_UIN = process.env.NINEBIRD_TARGET_UIN || '';

/** appid / qua：上层从 QQ 的 major.node 解析后注入；缺省走 qq-info 的平台兜底。 */
export const APPID = process.env.NINEBIRD_APPID || undefined;
export const QUA = process.env.NINEBIRD_QUA || undefined;

/**
 * QQ 数据根。macOS 沙箱内 wrapper 的 getNTUserDataInfoConfig / os.homedir
 * 会拼出「容器套容器」的嵌套根，WeQ 侧从非沙箱进程把确切路径传进来；
 * 其它平台仅作 wrapper 探测失败时的兜底。
 */
export const DATA_ROOT = process.env.NINEBIRD_DATA_ROOT || undefined;

/** NineBird.node（hooker）所在目录；缺省回退 NINEBIRD_LOAD_PATH 的父目录 / __dirname。 */
export const LOADER_DIR = process.env.NINEBIRD_LOADER_DIR || undefined;
export const LOAD_PATH = process.env.NINEBIRD_LOAD_PATH || undefined;

/** 整数环境变量（超时等）；未设 / 非法时用 fallback。 */
export function intEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : fallback;
}
