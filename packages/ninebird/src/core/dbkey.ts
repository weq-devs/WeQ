// 0xcde_2 dbkey 提取 gate —— quick / qr 共用。
//
// 原理：0xcde_2 应答的 protobuf body 里，密钥是一个 `0A 10` 长度前缀标记的
// 16 字节 printable-ASCII 字符串。在 recv hook 里对 hex 原文做逐字节扫描，
// 第一个 `0A 10` 标记即定性：16 字节全 ASCII → 成功 resolve；否则报错
// reject（错误文案与旧实现逐字一致）。
//
// 抓到后登记进 pipe 模块（result 帧携带），并 resolve gate 让主流程继续
// 取 pskey —— dbkey 本身不再直接终结流程。

import { noteDbkey } from './pipe';
import type { NineBirdHooker } from './hooker';

const isPrintableAscii = (b: number): boolean => b >= 0x20 && b <= 0x7e;

/** 安装 0xcde_2 拦截 hook，返回在 dbkey 到达时 resolve 的 promise。 */
export function installDbkeyGate(hooker: NineBirdHooker): Promise<string> {
    let resolveDbkey!: (key: string) => void;
    let rejectDbkey!: (err: Error) => void;
    const gate = new Promise<string>((res, rej) => {
        resolveDbkey = res;
        rejectDbkey = rej;
    });

    hooker.installRecvHook((ev) => {
        const hex = ev.hex_data;
        if (!hex || (!hex.startsWith('08de19') && !hex.startsWith('08DE19'))) return;

        const buf = Buffer.from(hex, 'hex');
        for (let i = 0; i + 18 <= buf.length; i++) {
            if (buf[i] !== 0x0a || buf[i + 1] !== 0x10) continue;
            const start = i + 2;
            const slice = buf.slice(start, start + 16);
            let allAscii = true;
            for (let k = 0; k < 16; k++) {
                if (!isPrintableAscii(slice[k])) {
                    allAscii = false;
                    break;
                }
            }
            if (allAscii) {
                const key = slice.toString('ascii');
                noteDbkey(key);
                resolveDbkey(key);
                return;
            }
            rejectDbkey(new Error('0xcde_2 包里 16 字节段含非 ASCII 字节，dbkey 获取失败'));
            return;
        }
        rejectDbkey(new Error('0xcde_2 包里没有 "0A 10" 标记，dbkey 获取失败'));
    });

    return gate;
}
