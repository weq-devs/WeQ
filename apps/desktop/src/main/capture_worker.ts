/**
 * Capture worker — the ROOT half of the elevated capture flow.
 *
 * 抓包要打开原始套接字，内核要求 euid=0 或 CAP_NET_RAW（抓包用 `libpcap`/AF_PACKET）。
 * Electron 不能以 root 运行，所以把**只有抓包会话**的那部分放进这个 root 子进程：
 * `capture_elevation.ts` 用 `sudo -S` 起它（密码来自渲染层自绘的密码框），它在这里
 * require `nt_helper.node` 并持有抓包会话，主进程按 `capture_protocol.ts` 的协议代理
 * 前端的 start / take / stop。
 *
 * 与 `attach_worker` 的差别：那个是一次性的（读一次内存就退出），这个**活到会话结束**，
 * 所以协议不能只靠 stdout 打一行 JSON —— `sudo -S` 要从 stdin 读密码，跟协议复用同一条
 * 管道会被 sudo 的缓冲读吃掉。于是：
 *
 *   1. 在 `127.0.0.1` 上监听一个随机端口（仅本机可达）；
 *   2. 把 `{port, token}` 作为**唯一一行 hello** 打到 stdout（主进程据此判定「起来了」）；
 *   3. 主进程连上来，首帧必须带 token，之后按行 JSON 一问一答。
 *
 * 生命周期：主进程持着这条连接。所有客户端断开 = 父进程没了（崩溃 / 被 kill），这里就把
 * 还开着的会话停掉再退出，不会把 root 的抓包会话留在后台。
 *
 * 注意：本进程是**另一个 native 实例**，主进程里 `setSsoSession` 注册的物料在这边不存在，
 * 所以 `start` 请求必须显式带 `d2key`（主进程从 attach 拿到的物料里取）。
 *
 * 由 electron-vite 作为独立入口打成 `.mjs`，打包后的（asar）安装也靠
 * `ELECTRON_RUN_AS_NODE` 用 electron-as-node 跑 —— 不假设用户机器上有系统 node。
 */

import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';
import type { CapturedFrame } from '@weq/native';
import {
  toCaptureFrameWire,
  type CaptureSessionWire,
  type CaptureStatsWire,
  type CaptureWorkerHello,
  type CaptureWorkerReply,
  type CaptureWorkerRequest,
} from './capture_protocol';

const requireFn = createRequire(__filename);

/** 本进程用到的 nt_helper 出口（其余不碰）。 */
interface CaptureAddon {
  getInitStatus(): number;
  probeCaptureSupport(): { available: boolean; backend: string; elevated: boolean; hint: string };
  startCapture(
    pid: number,
    options?: { iface?: string; port?: string; d2Key?: string } | null,
  ): Promise<CaptureSessionWire>;
  takeFrames(
    pid: number,
    options?: { cursor?: number; waitMs?: number } | null,
  ): Promise<{ frames: CapturedFrame[]; nextCursor: number; dropped: number }>;
  stopCapture(pid: number): Promise<CaptureStatsWire>;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function fail(error: string, code: number): never {
  process.stderr.write(`${JSON.stringify({ ok: false, error })}\n`);
  process.exit(code);
}

async function main(): Promise<void> {
  const ntHelperPath = process.argv[2];
  if (!ntHelperPath) fail('missing nt_helper.node path (argv[2])', 2);

  // LICENSE 校验在 require 时就跑，并且是**相对 cwd 往上找**的 —— 必须在 require 之前
  // chdir 进 addon 自己所在的目录（dev / 打包两种布局的祖先目录里都有 LICENSE）。
  try {
    process.chdir(dirname(ntHelperPath));
  } catch (e) {
    fail(`chdir failed: ${errText(e)}`, 2);
  }

  let addon: CaptureAddon;
  try {
    addon = requireFn(ntHelperPath) as CaptureAddon;
  } catch (e) {
    fail(`require nt_helper.node failed: ${errText(e)}`, 1);
  }

  const initStatus = addon.getInitStatus();
  if (initStatus !== 0) fail(`nt_helper init failed (status ${initStatus})`, 1);

  const support = addon.probeCaptureSupport();
  if (!support.available) fail(support.hint || '抓包后端不可用', 1);

  const token = randomBytes(16).toString('hex');
  /** 还开着的会话（pid）。父进程断开时按它清场。 */
  const activePids = new Set<number>();
  /** 已经通过口令校验的连接（之后的帧不用再带 token）。 */
  const authed = new WeakSet<Socket>();
  /**
   * 通过口令校验的连接。**只按它判定「父进程还在不在」** —— 没通过门禁的连接
   * 谁都能建（本机端口），不能因为对方断开就把 root 抓包一起收了。
   */
  const authedSockets = new Set<Socket>();
  let shuttingDown = false;

  /** 请求串行执行：`take` 会阻塞到 waitMs 结束，跟 `stop` 抢同一个会话会乱。 */
  let queue: Promise<void> = Promise.resolve();

  function reply(socket: Socket, payload: CaptureWorkerReply): void {
    if (socket.destroyed) return;
    socket.write(`${JSON.stringify(payload)}\n`);
  }

  async function dispatch(req: CaptureWorkerRequest): Promise<unknown> {
    switch (req.op) {
      case 'start': {
        const session = await addon.startCapture(req.pid, {
          iface: req.iface,
          port: req.port,
          // native 的字段名是 `d2Key`（napi 从 Rust `d2key` 转来）；写成 `d2key`
          // 会被静默忽略 → 密文全部解不开。线上协议那层（req.d2key）保持小写。
          d2Key: req.d2key,
        });
        activePids.add(req.pid);
        return session;
      }
      case 'take': {
        const batch = await addon.takeFrames(req.pid, {
          cursor: req.cursor,
          waitMs: req.waitMs,
        });
        return {
          frames: batch.frames.map(toCaptureFrameWire),
          nextCursor: batch.nextCursor,
          dropped: batch.dropped,
        };
      }
      case 'stop': {
        const stats = await addon.stopCapture(req.pid);
        activePids.delete(req.pid);
        return stats;
      }
      default:
        throw new Error(`未知的抓包 worker 请求：${String((req as { op?: unknown }).op)}`);
    }
  }

  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const pid of [...activePids]) {
      try {
        await addon.stopCapture(pid);
      } catch {
        // 尽力而为：父进程都没了，停不掉也只记在心里。
      }
    }
    activePids.clear();
    server.close();
    process.exit(0);
  }

  function handleLine(socket: Socket, line: string): void {
    const text = line.trim();
    if (text === '') return;
    let req: CaptureWorkerRequest;
    try {
      req = JSON.parse(text) as CaptureWorkerRequest;
    } catch {
      return; // 半行 / 垃圾输入：丢掉，不当成协议错误（连接是长在的）。
    }
    // 首帧必须自证身份 —— 端口是本机的，口令才是门禁。
    const claimed = (req as { token?: string }).token;
    if (!socketAllowed(socket, claimed)) {
      socket.destroy();
      return;
    }
    queue = queue.then(async () => {
      try {
        const result = await dispatch(req);
        reply(socket, { id: req.id, ok: true, result });
      } catch (e) {
        reply(socket, { id: req.id, ok: false, error: errText(e) });
      }
    });
  }

  function socketAllowed(socket: Socket, claimed: string | undefined): boolean {
    if (authed.has(socket)) return true;
    if (claimed !== token) return false;
    authed.add(socket);
    authedSockets.add(socket);
    return true;
  }

  const server: Server = createServer((socket) => {
    socket.setNoDelay(true);
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      if (!authedSockets.delete(socket)) return;
      // 父进程断开（退出 / 崩溃）—— 把会话停掉再走，别留一个 root 抓包在后台。
      if (authedSockets.size === 0) void shutdown();
    });
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        handleLine(socket, line);
        index = buffer.indexOf('\n');
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  if (!port) fail('capture worker failed to bind a loopback port', 1);

  const hello: CaptureWorkerHello = {
    port,
    token,
    euid: process.geteuid?.() ?? -1,
    backend: support.backend,
  };
  process.stdout.write(`${JSON.stringify(hello)}\n`);

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      void shutdown();
    });
  }
}

void main().catch((e) => fail(`capture worker crashed: ${errText(e)}`, 1));
