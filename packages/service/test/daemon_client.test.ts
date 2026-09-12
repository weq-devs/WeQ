/**
 * daemon 管道客户端的**线上请求帧形状**回归测试。
 *
 * 锁死的是服务端 JSON 形状：Rust 侧 `Request` 是 serde 内部 tag
 * （`#[serde(tag = "cmd")]`），newtype 变体里结构体的字段会被**平铺**进同一层
 * 对象。所以 `release_watch_start` / `autostart_set` 必须发
 * `{ cmd, api_base, repo, ... }`，而不是 `{ cmd, cfg: { ... } }`。
 *
 * 发错形状时守护进程解析失败、不回帧直接断开，客户端只能拿到 null —— 上层
 * 会误报「守护进程未运行」，照着错误方向排查会很久（这正是曾经的线上 bug）。
 * 同一个坑在**响应**方向也踩过：客户端读的是 `res.info`，而线上帧是平铺的 ——
 * 状态永远解析成 undefined，开关看着像没事但永远翻不过来。两边都钉死。
 *
 * 这里用一个只回一帧的假守护进程把形状钉死。
 */

import { createServer, type Server, type Socket } from 'node:net';
import { existsSync, unlinkSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { daemonPipePath, type DaemonResponse } from '../src/daemon/protocol';
import {
  daemonAutostartSet,
  daemonReleaseWatchStart,
  daemonReleaseWatchStatus,
} from '../src/daemon/client';

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

/** 起一个假守护进程：收一帧请求 → 记下来 → 回 `reply` → 关连接。 */
function startFakeDaemon(reply: DaemonResponse): Promise<FakeDaemon> {
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
        socket.end(encodeResponse(reply));
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

describe('daemon 客户端请求帧形状', () => {
  let fake: FakeDaemon | null = null;

  afterEach(async () => {
    await fake?.stop();
    fake = null;
  });

  it('release_watch_start 平铺配置字段（不是嵌套 cfg）', async () => {
    // 真实守护进程回的帧长这样（`watching` 与 `res` 同层平铺，没有 info 包皮）。
    fake = await startFakeDaemon({
      res: 'release_watch_status',
      watching: true,
      repo: 'H3CoF6/WeQ',
      interval_secs: 3600,
      current_version: '1.0.0',
      latest_seen: null,
      pending: null,
      last_error: null,
    });

    const result = await daemonReleaseWatchStart(
      {
        api_base: 'https://api.github.com',
        repo: 'H3CoF6/WeQ',
        interval_secs: 3600,
        current_version: '1.0.0',
      },
      fake.pipe,
    );

    // 与 Rust `protocol.rs::new_command_json_shapes` 断言的形状完全一致。
    expect(fake.received).toEqual([
      {
        cmd: 'release_watch_start',
        api_base: 'https://api.github.com',
        repo: 'H3CoF6/WeQ',
        interval_secs: 3600,
        current_version: '1.0.0',
      },
    ]);
    // 收敛成纯载荷：不带协议层的 res 字段，字段名原样。
    expect(result).toEqual({
      watching: true,
      repo: 'H3CoF6/WeQ',
      interval_secs: 3600,
      current_version: '1.0.0',
      latest_seen: null,
      pending: null,
      last_error: null,
    });
  });

  it('release_watch_status 能解析平铺的状态帧', async () => {
    fake = await startFakeDaemon({
      res: 'release_watch_status',
      watching: true,
      repo: 'H3CoF6/WeQ',
      interval_secs: 3600,
      current_version: '1.0.0',
      latest_seen: '1.1.0',
      pending: '1.1.0',
      last_error: null,
    });

    const status = await daemonReleaseWatchStatus(fake.pipe);
    expect(status?.watching).toBe(true);
    expect(status?.pending).toBe('1.1.0');
    expect(fake.received).toEqual([{ cmd: 'release_watch_status' }]);
  });

  it('autostart_set 平铺 memory 字段（不是嵌套 memory）', async () => {
    fake = await startFakeDaemon({ res: 'autostart_applied', enabled: true });

    const result = await daemonAutostartSet({ enabled: true, gui_exe: '/app/weQ' }, fake.pipe);

    expect(fake.received).toEqual([{ cmd: 'autostart_set', enabled: true, gui_exe: '/app/weQ' }]);
    expect(result).toEqual({ ok: true, enabled: true });
  });

  it('守护进程不可达时返回 null（让上层给「未运行」提示）', async () => {
    // 没起假守护进程 → 连不上 → null（而不是抛错）。
    const result = await daemonReleaseWatchStart(
      {
        api_base: 'https://api.github.com',
        repo: 'H3CoF6/WeQ',
        interval_secs: 3600,
        current_version: '1.0.0',
      },
      nextPipe(),
    );
    expect(result).toBeNull();
  });
});
