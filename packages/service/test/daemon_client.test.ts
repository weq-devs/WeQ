/**
 * 旧 daemon 管道客户端的回归测试 —— 只覆盖升级退役依赖的两条路径：
 * 探活（`ping`）与停止（`stop`）。
 *
 * 锁死的是旧服务端的线上行为：`stop` 故意**不回帧**直接断开，客户端读 EOF
 * 即算成功。发错形状 / 把 EOF 当成失败，会让 `legacy_daemon.ts` 误判「旧后台
 * 还在」，升级后每次启动都卡在迁移失败上。
 */

import { createServer, type Server, type Socket } from 'node:net';
import { existsSync, unlinkSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { daemonPipePath, type DaemonResponse } from '../src/daemon/protocol';
import { daemonStop, pingDaemon } from '../src/daemon/client';

/** 每个用例用独立管道名，避免和真实的 weq-daemon / 并发用例互相干扰。 */
let pipeSeq = 0;
function nextPipe(): string {
  pipeSeq += 1;
  return `weq-daemon-test-${process.pid}-${pipeSeq}`;
}

/** 手工按「4 字节小端长度 + JSON」封一帧响应。 */
function encodeResponse(res: DaemonResponse): Buffer {
  const payload = Buffer.from(JSON.stringify(res), 'utf-8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(payload.byteLength, 0);
  return Buffer.concat([head, payload]);
}

interface FakeDaemon {
  /** 这次用例独占的管道名。 */
  pipe: string;
  /** 依次收到的请求对象（按线上 JSON 原样解析）。 */
  received: unknown[];
  stop: () => Promise<void>;
}

/**
 * 起一个假守护进程：收一帧请求 → 记下来 → 回 `reply` → 关连接。
 * `reply` 为 null 表示只断开不回帧（真实旧服务端处理 `stop` 的方式）。
 */
function startFakeDaemon(reply: DaemonResponse | null): Promise<FakeDaemon> {
  const pipe = nextPipe();
  const path = daemonPipePath(pipe);
  const received: unknown[] = [];
  const sockets = new Set<Socket>();

  return new Promise((resolve, reject) => {
    const server: Server = createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      let buf = Buffer.alloc(0);
      socket.on('data', (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        if (buf.byteLength < 4) return;
        const len = buf.readUInt32LE(0);
        if (buf.byteLength < 4 + len) return;
        received.push(JSON.parse(buf.subarray(4, 4 + len).toString('utf-8')));
        socket.end(reply === null ? undefined : encodeResponse(reply));
      });
    });
    server.on('error', reject);
    server.listen(path, () => {
      resolve({
        pipe,
        received,
        stop: () =>
          new Promise((done) => {
            for (const socket of sockets) socket.destroy();
            sockets.clear();
            server.close(() => {
              // unix socket 会留文件；windows named pipe 无文件。
              if (process.platform !== 'win32' && existsSync(path)) {
                try {
                  unlinkSync(path);
                } catch {
                  /* 已被清理 */
                }
              }
              done();
            });
          }),
      });
    });
  });
}

describe('旧 daemon 退役客户端', () => {
  let fake: FakeDaemon | null = null;

  afterEach(async () => {
    await fake?.stop();
    fake = null;
  });

  it('ping 发出最小请求帧并解析 pong', async () => {
    fake = await startFakeDaemon({ res: 'pong', version: '1.0.0', http_running: true });

    const result = await pingDaemon(fake.pipe);

    expect(fake.received).toEqual([{ cmd: 'ping' }]);
    expect(result).toEqual({ version: '1.0.0', httpRunning: true });
  });

  it('stop 读到 EOF 也算成功（旧服务端故意不回帧）', async () => {
    fake = await startFakeDaemon(null);

    await expect(daemonStop(fake.pipe)).resolves.toBe(true);
    expect(fake.received).toEqual([{ cmd: 'stop' }]);
  });

  it('旧守护进程不在时探活返回 null、停止返回 false（幂等）', async () => {
    // 没起假守护进程 → 连不上 → 不抛错。
    await expect(pingDaemon(nextPipe())).resolves.toBeNull();
    await expect(daemonStop(nextPipe())).resolves.toBe(false);
  });
});
