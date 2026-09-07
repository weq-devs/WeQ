// 加载 QQ 的 wrapper.node —— 三个 loader 完全同构的发现逻辑。
//
// wrapper.node 在 QQ 安装目录里随版本挪位置（win32 的 versions/<ver>/、
// linux 的 resources/app/…），这里按平台 + 版本做逐级回退。napcat 本身跑在
// QQ 进程里不用这一步；loader 是被 QQ 的 Electron 入口拉起的独立 JS，
// 必须 dlopen 它才能驱动登录服务。

import fs from 'node:fs';
import path from 'node:path';
import type { WrapperNodeApi } from '../wrapper-types';

export function loadQQWrapper(execPath: string, qqVersion: string): WrapperNodeApi {
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
