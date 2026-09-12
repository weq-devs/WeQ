// 控制管道客户端 —— loader 与 WeQ 之间的 NDJSON 事件流（每条消息一行 JSON）。
//
// 帧种类（按流程不同）：
//   { kind: 'qrcode',       url: string }
//   { kind: 'qrcode-state', state: string }
//   { kind: 'login-list',   list: LoginListSummary[] }
//   { kind: 'pskey',        success: boolean, pskey?: …, error?: string }
//   { kind: 'result',       success: boolean, dbkey?: string, error?: string }
//
// `result` 是终结帧 —— 消费端收到它就 kill 掉 QQ，所以 pskey 必须排在它前面
// （见 sendFinalExit）。管道连不上 / 没配管道时静默降级：消息丢弃、终结时
// 直接 process.exit（退出码即成败）。
//
// dbkey 存在这里（而非各 loader）是为了让 result 帧统一携带 `dbkey` 字段：
// quick/qr 流程由 hook 填充；account-list 流程永远为 null，JSON.stringify
// 会把 undefined 字段整个省掉 —— 与旧实现的帧形状逐字节一致。

import net from 'node:net';
import type { PskeyResult } from '../pskey';
import type { NbLog } from './log';
import { PIPE_NAME } from './env';

let pipeClient: net.Socket | null = null;
let shutdownCalled = false;
let dbkey: string | null = null;

/** hook 抓到 dbkey 时登记（进 result 帧）。 */
export function noteDbkey(key: string): void {
    dbkey = key;
}

/** 终结帧是否已发出（全局超时守卫用：发过就不再重复退出）。 */
export function isShutdown(): boolean {
    return shutdownCalled;
}

/** 确保管道已连接（幂等）。没配管道 → 直接 resolve；连不上 → 当没有管道。 */
export function ensurePipeOpen(log: NbLog): Promise<void> {
    if (!PIPE_NAME) {
        log('ensurePipeOpen: PIPE_NAME empty, skip');
        return Promise.resolve();
    }
    if (pipeClient) return Promise.resolve();
    log(`ensurePipeOpen: connecting to ${PIPE_NAME}`);
    return new Promise((resolve) => {
        const c = net.createConnection(PIPE_NAME);
        const onReady = () => {
            c.removeListener('error', onErr);
            pipeClient = c;
            log('ensurePipeOpen: connected');
            // 之后 pipe 出问题就直接退，没法再恢复
            c.on('error', () => process.exit(1));
            resolve();
        };
        const onErr = (e: Error) => {
            c.removeListener('connect', onReady);
            // 连不上就当没有 pipe，让 sendResultAndExit 走 process.exit 兜底
            log(`ensurePipeOpen: connect FAILED: ${e && e.message}`);
            resolve();
        };
        c.once('connect', onReady);
        c.once('error', onErr);
    });
}

/** 写一帧 NDJSON（无管道时丢弃）。 */
export function sendMessage(obj: object): Promise<void> {
    if (!pipeClient) return Promise.resolve();
    return new Promise((resolve) => {
        pipeClient!.write(JSON.stringify(obj) + '\n', () => resolve());
    });
}

/** 发终结的 result 帧并退出（qr 的旧流程路径：只有 result 一帧）。 */
export async function sendResultAndExit(success: boolean, error?: string): Promise<void> {
    if (shutdownCalled) return;
    shutdownCalled = true;

    const result = {
        kind: 'result',
        success,
        dbkey: dbkey || undefined,
        error: error || undefined,
    };

    if (!pipeClient) {
        process.exit(success ? 0 : 1);
    }

    try {
        await sendMessage(result);
    } catch {}
    pipeClient!.end(() => {
        setTimeout(() => process.exit(0), 100);
    });
}

/**
 * quick / qr 的双帧终结：pskey 先于 result —— 消费端收到 `result` 就认为
 * 流程终结并 kill 掉 QQ + pipe，之后再发的帧会丢。
 */
export async function sendFinalExit(
    dbkeyResult: { success: boolean; dbkey?: string; error?: string },
    psKeyResult: PskeyResult,
): Promise<void> {
    if (shutdownCalled) return;
    shutdownCalled = true;

    try {
        await sendMessage({ kind: 'pskey', ...psKeyResult });
    } catch {}
    try {
        await sendMessage({ kind: 'result', ...dbkeyResult });
    } catch {}

    if (!pipeClient) {
        process.exit(dbkeyResult.success ? 0 : 1);
    }
    pipeClient!.end(() => {
        setTimeout(() => process.exit(0), 100);
    });
}
