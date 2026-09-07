// NineBird.node（hooker）的定位与加载 —— 三个 loader 同构。
//
// hooker 是随包发布的原生模块，与 loader JS 同目录
// （resources/ninebird-runtime/ 旁的 native/<platform>/ninebird/NineBird.node
// 经 NINEBIRD_LOADER_DIR / NINEBIRD_LOAD_PATH 告知），缺省回退 __dirname。

import fs from 'node:fs';
import path from 'node:path';
import type { RecvEvent } from '../wrapper-types';
import { LOAD_PATH, LOADER_DIR } from './env';

/** NineBird.node 暴露的最小接口（C++ 侧 recv hook）。 */
export interface NineBirdHooker {
    installRecvHook(cb: (event: RecvEvent) => void): boolean;
    uninstallRecvHook(): void;
    isReady?(): boolean;
}

export type LoadedHooker =
    | { ok: true; hooker: NineBirdHooker }
    | { ok: false; /** 找过的路径（报错文案用）。 */ path: string };

/** 定位并 require NineBird.node；文件不存在返回 `{ ok: false, path }`。 */
export function loadHooker(): LoadedHooker {
    const loaderDir = LOADER_DIR || (LOAD_PATH ? path.dirname(LOAD_PATH) : __dirname);
    const hookerPath = path.join(loaderDir, 'NineBird.node');
    if (!fs.existsSync(hookerPath)) {
        return { ok: false, path: hookerPath };
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- CJS bundle 里 require 原生模块
    const hooker = require(hookerPath) as NineBirdHooker;
    return { ok: true, hooker };
}
