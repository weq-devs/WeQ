// NineBird 统一日志 —— qr / quick / account 三个 loader 共用。
//
// 落点约定：
//   - `NINEBIRD_LOG` 环境变量优先。macOS 的 darwin boot 固定注入 QQ 容器内
//     路径（`weq-ninebird/ninebird_qq.log`）—— QQ 是沙箱应用，写不了 WeQ 的
//     日志目录，macOS 行为保持不变；
//   - 未注入时（win32 的 addon 不设该变量）默认开启，写到 **WeQ 自身日志
//     同目录**：`%APPDATA%\WeQ\logs\ninebird_qq.log`（linux：
//     `$XDG_CONFIG_HOME||~/.config` 下的 `WeQ/logs/`）。QQ 与 WeQ 同用户
//     运行，该目录必然可写，也让 loader 日志和 GUI 日志聚在一起好排查。
//
// 写入是尽力而为：目录懒创建，任何失败都静默，绝不影响登录流程。

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** WeQ GUI 的日志目录（与 packages/native/src/loader.ts 的 defaultLogRoot 同约定）。 */
function weqLogDir(): string | null {
    if (process.platform === 'win32') {
        const appData = process.env.APPDATA || process.env.LOCALAPPDATA;
        return appData ? join(appData, 'WeQ', 'logs') : null;
    }
    if (process.platform === 'darwin') {
        // macOS：QQ 沙箱内写不了 WeQ 日志目录，且 darwin boot 一定注入
        // NINEBIRD_LOG —— 不提供默认（保持 macOS 行为不变）。
        return null;
    }
    const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
    return join(xdg, 'WeQ', 'logs');
}

/** 本次 loader 进程要写的日志文件；null = 日志关闭。 */
export function resolveLogPath(): string | null {
    const fromEnv = process.env.NINEBIRD_LOG?.trim();
    if (fromEnv) return fromEnv;
    const dir = weqLogDir();
    return dir ? join(dir, 'ninebird_qq.log') : null;
}

export type NbLog = (msg: string) => void;

/**
 * 建一个带 loader 标签的 logger。标签沿用旧实现的前缀格式
 * （`[loader:qr pid=…]` / `[loader:quick …]` / `[loader:account …]`），
 * 便于在混合日志里 grep 单条 loader 的生命周期。
 */
export function createLogger(tag: string): NbLog {
    const path = resolveLogPath();
    if (!path) return () => {};
    let dirEnsured = existsSync(dirname(path));
    return (msg: string): void => {
        try {
            if (!dirEnsured) {
                mkdirSync(dirname(path), { recursive: true });
                dirEnsured = true;
            }
            appendFileSync(path, `[loader:${tag} pid=${process.pid}] ${msg}\n`);
        } catch {
            /* 尽力而为 */
        }
    };
}
