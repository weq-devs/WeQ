/**
 * 探测「QQ 自己给哪些命令签名」——**只连 pipe，不注入**。
 *
 * 前提：QQ 已被 SnowLuma/nnphook 的 Linux hook 注入并上线（socket 形如
 * `<runtime-dir>/mojo.<pid>.control.sock`）。本脚本不负责注入，只做两件事：
 *
 *   1. 通过 hook 的 control socket 发 `sendRequest`，让 **QQ 本体**组帧发出。
 *      签名不签由 QQ 决定，我们不干预 —— 这正是要测的东西。
 *   2. 同时用 `nt_helper.startCapture` 抓网卡，把 QQ 刚发出去的那一帧解出来，
 *      看 SSO reserved 里有没有 tag 24（`SecInfo = SecSign + SecToken + SecExtra`）。
 *
 * 为什么不用 `scripts/sso_send.ts`：那条路经 nt_helper 自建 SSO 连接，签名是
 * nt_helper 自己塞的（只有 SecSign、token/extra 恒空），测不到 QQ 的行为。
 *
 * 用法：
 *   pnpm tsx scripts/probe-sign.ts                       # 扫内置命令表
 *   pnpm tsx scripts/probe-sign.ts --pid 56181
 *   pnpm tsx scripts/probe-sign.ts --cmd 0x102a_1 --cmd 0x6d6_2
 *   pnpm tsx scripts/probe-sign.ts --cmd trpc.qqva.gift_midground_panel.GiftMidgroundPanel.SsoGetSceneItem
 *   pnpm tsx scripts/probe-sign.ts --json out.json
 *   # 真实查询正文（JSON 中 bodyHex 为 inner body），要求签名正对照成功
 *   pnpm tsx scripts/probe-sign.ts --requests queries.json --control 0x102a_1 --json new-result.json
 *   # 复用已安装的长期授权助手；TUN 网络按实际路由指定抓包接口
 *   pnpm tsx scripts/probe-sign.ts --requests queries.json --control 0x102a_1 --iface utun4 \
 *     --authorization-helper /Library/PrivilegedHelperTools/app.weq.authorization/authorization.sock
 *   # taskgated 拒绝助手读内存时，可传本轮调试器提取的 {pid,d2Key} JSON；不在命令行传 key
 *   # --session-material-file <private-file>（运行后删除该文件）
 *   # 断连模式下探测：发包前一刻砍掉 QQ 的 MSF 长连接，并在等待窗口内持续压制
 *   sudo pnpm tsx scripts/probe-sign.ts --disconnect --cmd MessageSvc.PbSendMsg
 *
 * 权限：抓包要 root 或 `CAP_NET_RAW`（Linux）；`--disconnect` 走 `ss -K`，也要 root。
 */

import { createConnection, type Socket } from 'node:net';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { loadNativeSafe } from '../packages/native/src';
import type {
  CapturedFrame,
  CaptureSession,
  CaptureStats,
  NtHelperBinding,
} from '../packages/native/src';
import {
  openAuthorizedSignProbe,
  parseProbeMaterial,
  type SignProbeBackend,
} from './sign-probe-authorization';
import { DEFAULT_OIDB_CASES, DEFAULT_RAW_CASES } from './sign-probe-commands';
import {
  parseCase,
  parseRequestCases,
  validateControlSocketPath,
  type ProbeCase,
} from './sign-probe-requests';
import {
  inspectProbeFrames,
  describeProbeStatus,
  type ProbeInspection,
} from './sign-probe-analysis';

const LABEL = 'probe-sign';

/** hook 的 pipe 线格式，与 nnphook `apps/qq/common/pipe_protocol.hpp` 对齐。 */
const PIPE_MAGIC = 0x31504851;
const PIPE_VERSION = 1;
const PIPE_HEADER_SIZE = 40;
const PIPE_OP_HELLO = 1;
const PIPE_OP_SEND_REQUEST = 2;
const PIPE_OP_SEND_REPLY = 4;
const PIPE_OP_ERROR = 5;

interface PipeFrame {
  op: number;
  requestId: number;
  status: number;
  flags: number;
  cmd: string;
  msg: string;
  body: Buffer;
}

function log(message: string): void {
  console.log(`[${LABEL}] ${message}`);
}

function fail(message: string): never {
  throw new Error(message);
}

// ─────────────────────────── 命令行 ───────────────────────────

const argv = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const opts = (name: string): string[] =>
  argv.reduce<string[]>((acc, value, index) => {
    if (value === name && argv[index + 1]) acc.push(argv[index + 1]!);
    return acc;
  }, []);

// ─────────────────────────── 断连 ───────────────────────────

interface EstablishedConn {
  /** `ss` 里的确切 peer 串，可直接喂给 `ss -K dst <peer>`。 */
  peer: string;
  localPort: number;
}

/** peer 是不是回环地址（`127.x` / `::1`）——本机服务不是 MSF 长连接。 */
function isLoopbackPeer(peer: string): boolean {
  return peer.startsWith('127.') || peer.startsWith('[::1]') || peer.startsWith('[::ffff:127.');
}

/**
 * 列出 `pid` 当前到**远端**的 ESTAB 连接（`ss -tnp`）。
 *
 * 不按端口白名单筛：MSF 实测会落在 8080 / 14000 / 80 / 443 等多个端口，且服务端
 * 随时会换。按「非回环 peer」筛更稳 —— QQ 主进程的回环连接都是本地服务（9210 之类），
 * 真正的长连接一定打到外网。
 */
function listMsfConnections(pid: number): EstablishedConn[] {
  let out: string;
  try {
    out = execFileSync('ss', ['-tnp'], { encoding: 'utf8' });
  } catch {
    return [];
  }
  const marker = `pid=${pid},`;
  const found: EstablishedConn[] = [];
  for (const line of out.split('\n')) {
    if (!line.includes('ESTAB') || !line.includes(marker)) continue;
    const cols = line.trim().split(/\s+/);
    if (cols.length < 6) continue;
    const peer = cols[4]!;
    if (isLoopbackPeer(peer)) continue;
    const localPort = Number(/]:(\d+)$/.exec(cols[3]!)?.[1] ?? 0);
    found.push({ peer, localPort });
  }
  return found;
}

/**
 * 砍掉 `pid` 所有到 MSF 端口的连接。
 *
 * `ss -K` 需要 root，脚本本身通常已用 sudo 跑（抓包也要），所以直接调。
 * 返回砍掉的条数；没有连接 = 0（QQ 可能正处于重连窗口）。
 */
function killMsfConnections(pid: number): number {
  const connections = listMsfConnections(pid);
  if (connections.length === 0) return 0;
  let killed = 0;
  for (const { peer } of connections) {
    try {
      execFileSync('ss', ['-K', `dst ${peer}`], { stdio: 'ignore' });
      killed += 1;
    } catch {
      // 竞态：连接刚好自己关了。
    }
  }
  return killed;
}

// ─────────────────────────── pipe 客户端 ───────────────────────────

function encodeFrame(frame: Partial<PipeFrame>): Buffer {
  const cmd = Buffer.from(frame.cmd ?? '');
  const msg = Buffer.from(frame.msg ?? '');
  const body = frame.body ?? Buffer.alloc(0);
  const header = Buffer.alloc(PIPE_HEADER_SIZE);
  header.writeUInt32LE(PIPE_MAGIC, 0);
  header.writeUInt16LE(PIPE_VERSION, 4);
  header.writeUInt16LE(frame.op ?? 0, 6);
  header.writeUInt32LE((frame.requestId ?? 0) >>> 0, 8);
  header.writeInt32LE(frame.status ?? 0, 12);
  header.writeUInt32LE((frame.flags ?? 0) >>> 0, 16);
  header.writeUInt32LE(cmd.length, 20);
  header.writeUInt32LE(msg.length, 24);
  header.writeUInt32LE(body.length, 28);
  header.writeBigUInt64LE(BigInt(0), 32);
  return Buffer.concat([header, cmd, msg, body]);
}

class PipeClient {
  private buffer = Buffer.alloc(0);
  private readonly frames: PipeFrame[] = [];

  private constructor(private readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
  }

  static connect(path: string): Promise<PipeClient> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(path);
      socket.once('error', reject);
      socket.once('connect', () => {
        socket.off('error', reject);
        resolve(new PipeClient(socket));
      });
    });
  }

  private drain(): void {
    for (;;) {
      if (this.buffer.length < PIPE_HEADER_SIZE) return;
      const op = this.buffer.readUInt16LE(6);
      const requestId = this.buffer.readUInt32LE(8);
      const status = this.buffer.readInt32LE(12);
      const flags = this.buffer.readUInt32LE(16);
      const cmdLen = this.buffer.readUInt32LE(20);
      const msgLen = this.buffer.readUInt32LE(24);
      const bodyLen = this.buffer.readUInt32LE(28);
      const total = PIPE_HEADER_SIZE + cmdLen + msgLen + bodyLen;
      if (this.buffer.length < total) return;
      const start = PIPE_HEADER_SIZE;
      this.frames.push({
        op,
        requestId,
        status,
        flags,
        cmd: this.buffer.subarray(start, start + cmdLen).toString(),
        msg: this.buffer.subarray(start + cmdLen, start + cmdLen + msgLen).toString(),
        body: Buffer.from(this.buffer.subarray(start + cmdLen + msgLen, total)),
      });
      this.buffer = this.buffer.subarray(total);
    }
  }

  send(frame: Partial<PipeFrame>): void {
    this.socket.write(encodeFrame(frame));
  }

  find(op: number, requestId: number): PipeFrame | undefined {
    return this.frames.find((f) => f.op === op && f.requestId === requestId);
  }

  hello(): PipeFrame | undefined {
    return this.frames.find((f) => f.op === PIPE_OP_HELLO);
  }

  close(): void {
    this.socket.destroy();
  }
}

// ─────────────────────────── 探测 ───────────────────────────

interface ProbeResult extends ProbeInspection {
  cmd: string;
  bodySource: ProbeCase['bodySource'];
  requestSha256: string;
  error?: string;
  replyStatus?: number;
  replyLength?: number;
  captureDropped?: number;
  /** 断连模式下本轮累计砍掉的 MSF 连接条数（0 = 扫描窗口内没看到连接）。 */
  killedConnections?: number;
  observedFrames?: number;
  observedCommands?: string[];
}

const report = {
  format: 'weq-sign-probe-v1',
  platform: process.platform,
  arch: process.arch,
  readerExecutable: process.execPath,
  uid: process.getuid?.(),
  euid: process.geteuid?.(),
  captureBackend: opt('--authorization-helper') ? 'authorization-helper' : 'native',
  materialSource: opt('--session-material-file')
    ? 'file'
    : opt('--authorization-helper')
      ? 'authorization-helper'
      : 'native',
  startedAt: new Date().toISOString(),
  finishedAt: '',
  pid: undefined as number | undefined,
  failure: undefined as string | undefined,
  control: undefined as string | undefined,
  controlPassed: undefined as boolean | undefined,
  cleanupErrors: [] as string[],
  captureSession: undefined as CaptureSession | undefined,
  captureStats: undefined as CaptureStats | undefined,
  results: [] as ProbeResult[],
};

function saveReport(): void {
  report.finishedAt = new Date().toISOString();
  const jsonPath = opt('--json');
  if (!jsonPath) return;
  writeFileSync(jsonPath, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
  log(`结果已写入 ${jsonPath}`);
}

/**
 * 可能放着 hook socket 的目录。
 *
 * 注意 `sudo` 会重置 `XDG_RUNTIME_DIR`，且 `getuid()` 变成 0，所以不能只靠这两个
 * 推断：`/run/user/<uid>` 和 `/tmp/snowluma-<uid>` 都按可见的 uid 枚举一遍。
 *
 * macOS 的 hook 把 socket 放在 `$TMPDIR/snowluma-hook/` 下（见 nnphook
 * `runtime_dir()`），文件名带 `snowluma-hook` 前缀。sudo 会改写 `TMPDIR`，但
 * socket 仍留在原用户的 per-user 临时目录里，所以额外枚举 per-user 的
 * `T/snowluma-hook` 与 `T` 目录。
 */
function findRuntimeDirs(): string[] {
  const candidates = new Set<string>();
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  if (runtimeDir) candidates.add(runtimeDir);
  if (process.env.SNOWLUMA_HOOK_RUNTIME_DIR) {
    candidates.add(process.env.SNOWLUMA_HOOK_RUNTIME_DIR);
  }
  for (const uid of new Set([process.getuid?.() ?? 0, 1000, 1001])) {
    candidates.add(`/run/user/${uid}`);
    candidates.add(`/tmp/snowluma-${uid}`);
    candidates.add(`/tmp/qq-rtld-${uid}`);
  }
  if (process.platform === 'darwin') {
    let roots: string[] = [];
    try {
      roots = readdirSync('/var/folders');
    } catch {
      roots = [];
    }
    for (const a of roots) {
      let inner: string[] = [];
      try {
        inner = readdirSync(`/var/folders/${a}`);
      } catch {
        continue;
      }
      for (const b of inner) {
        candidates.add(`/var/folders/${a}/${b}/T/snowluma-hook`);
        candidates.add(`/var/folders/${a}/${b}/T`);
      }
    }
  }
  return [...candidates].filter((dir) => {
    try {
      readdirSync(dir);
      return true;
    } catch {
      return false;
    }
  });
}

/** Hook socket 名：Linux 为 `mojo.<pid>.control.sock`，macOS 带 `snowluma-hook` 前缀。 */
const CONTROL_SOCKET_RE = /^(?:snowluma-hook)?mojo\.(\d+)\.control\.sock$/;

/** 在已知 runtime 目录里找指定 pid 的 control socket。 */
function findControlSocket(pid: number): string | null {
  for (const dir of findRuntimeDirs()) {
    const hit = findControlSocketInDir(dir, pid);
    if (hit) return hit;
  }
  return null;
}

/** 在单个目录里按 pid 匹配 control socket（兼容 macOS 前缀）。 */
function findControlSocketInDir(dir: string, pid: number): string | null {
  try {
    const match = readdirSync(dir).find(
      (name) => CONTROL_SOCKET_RE.exec(name)?.[1] === String(pid),
    );
    return match ? `${dir}/${match}` : null;
  } catch {
    return null;
  }
}

/** 从 runtime 目录里的 `[snowluma-hook]mojo.<pid>.control.sock` 推断 pid。 */
function discoverPid(): number | null {
  for (const dir of findRuntimeDirs()) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    const pids = entries
      .map((name) => CONTROL_SOCKET_RE.exec(name)?.[1])
      .filter((value): value is string => Boolean(value))
      .map((value) => Number(value))
      .sort((a, b) => a - b);
    if (pids.length > 0) return pids[pids.length - 1]!;
  }
  return null;
}

async function probeOne(
  pipe: PipeClient,
  nt: SignProbeBackend,
  pid: number,
  probeCase: ProbeCase,
  requestId: number,
  options: { disconnect?: boolean } = {},
): Promise<ProbeResult> {
  const result: ProbeResult = {
    ...inspectProbeFrames([], probeCase),
    cmd: probeCase.wire,
    bodySource: probeCase.bodySource,
    requestSha256: createHash('sha256').update(probeCase.body).digest('hex'),
  };
  let cursor = (await nt.takeFrames(pid, { maxFrames: 1 })).nextCursor;
  const captured: CapturedFrame[] = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (options.disconnect) {
      const killed = killMsfConnections(pid);
      result.killedConnections = (result.killedConnections ?? 0) + killed;
      if (!killed) await new Promise((resolve) => setTimeout(resolve, 2500));
    }
    pipe.send({
      op: PIPE_OP_SEND_REQUEST,
      requestId: requestId * 10 + attempt,
      flags: 0,
      cmd: probeCase.wire,
      body: probeCase.body,
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const chunk = await nt.takeFrames(pid, { cursor, waitMs: 1000, maxFrames: 4096 });
    cursor = chunk.nextCursor;
    result.captureDropped = Math.max(result.captureDropped ?? 0, chunk.dropped);
    captured.push(...chunk.frames);
    result.observedFrames = captured.length;
    result.observedCommands = [
      ...new Set(captured.flatMap((frame) => (frame.cmd ? [frame.cmd] : []))),
    ].slice(0, 16);
    Object.assign(result, inspectProbeFrames(captured, probeCase));
    // 捕获但解析失败时仍重试，绝不因 plain 非空就报告不签名。
    if (result.status === 'signed' || result.status === 'unsigned') break;
  }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const id = requestId * 10 + attempt;
    const error = pipe.find(PIPE_OP_ERROR, id);
    if (error) result.error ??= `${error.status} ${error.msg}`;
    const reply = pipe.find(PIPE_OP_SEND_REPLY, id);
    if (reply && result.replyStatus === undefined) {
      result.replyStatus = reply.status;
      result.replyLength = reply.body.length;
    }
  }
  return result;
}

let closeBackend: (() => void) | undefined;
async function main(): Promise<void> {
  const requestPath = opt('--requests');
  const cmdArgs = opts('--cmd');
  if (requestPath && cmdArgs.length) fail('--requests 和 --cmd 不能混用');
  const cases: ProbeCase[] = requestPath
    ? parseRequestCases(JSON.parse(readFileSync(requestPath, 'utf8')))
    : (cmdArgs.length ? cmdArgs : [...DEFAULT_OIDB_CASES, ...DEFAULT_RAW_CASES]).map((cmd) =>
        parseCase(cmd),
      );
  const controlArg = opt('--control');
  const control = controlArg ? parseCase(controlArg).wire : undefined;
  report.control = control;
  if (control && !cases.some((entry) => entry.wire === control))
    fail('正对照必须包含在本轮请求清单中');
  const disconnect = argv.includes('--disconnect');
  if (disconnect && process.platform !== 'linux') fail('--disconnect 仅 Linux 支持');
  if (disconnect && process.getuid?.() !== 0) fail('--disconnect 需要 root');

  const explicitPid = opt('--pid');
  const pid = explicitPid ? Number(explicitPid) : discoverPid();
  if (!pid || !Number.isInteger(pid) || pid <= 0) {
    fail(
      '找不到运行中的 hook pipe；请先准备已注入并上线的 QQ。已查找目录：' +
        findRuntimeDirs().join(', '),
    );
  }
  report.pid = pid;
  const runtimeDir = opt('--runtime-dir');
  const explicitSocket = opt('--control-socket');
  const controlPath =
    explicitSocket ??
    (runtimeDir ? findControlSocketInDir(runtimeDir, pid) : findControlSocket(pid));
  if (!controlPath) fail(`找不到 pid=${pid} 的 hook control socket；没有发送任何探测请求`);
  validateControlSocketPath(controlPath);
  let nt: SignProbeBackend;
  const authorizationEndpoint = opt('--authorization-helper');
  if (authorizationEndpoint) {
    const authorized = await openAuthorizedSignProbe(authorizationEndpoint);
    nt = authorized.backend;
    closeBackend = authorized.close;
    log('使用已安装的长期授权助手执行提权操作');
  } else {
    const loaded = loadNativeSafe();
    if (!loaded.ok) fail(`native 加载失败：${loaded.message}`);
    const native: NtHelperBinding = loaded.bundle.ntHelper;
    const support = native.probeCaptureSupport();
    if (!support.available) fail(`抓包不可用：${support.hint}`);
    if (!support.elevated) log(`抓包权限待核实：${support.hint}`);
    nt = native;
  }
  const materialFile = opt('--session-material-file');
  const material = materialFile
    ? parseProbeMaterial(JSON.parse(readFileSync(materialFile, 'utf8')), pid)
    : await nt.scanSessionMaterial(pid);
  if (!material.d2Key) fail('没读到 d2key，抓包无法解密');
  log(`pid=${pid} control=${controlPath} 命令数=${cases.length}`);
  if (cases.some((entry) => entry.bodySource === 'placeholder')) {
    log('本轮包含占位正文；结果只说明这些输入下的签名观测，不代表真实业务请求已验收');
  }

  let pipe: PipeClient | undefined;
  let captureStarted = false;
  try {
    report.captureSession = await nt.startCapture(pid, {
      d2Key: material.d2Key,
      ringFrames: 16384,
      iface: opt('--iface'),
      port: opt('--port'),
    });
    captureStarted = true;
    await new Promise((resolve) => setTimeout(resolve, 600));
    pipe = await PipeClient.connect(controlPath);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    if (!pipe.hello()) fail('pipe 握手失败：没收到 hello 帧');
    // 用本轮第一条显式请求预热，不额外构造一个未经指定的业务请求。
    const warm = cases[0]!;
    const cursor = (await nt.takeFrames(pid, { maxFrames: 1 })).nextCursor;
    pipe.send({
      op: PIPE_OP_SEND_REQUEST,
      requestId: 9999,
      flags: 0,
      cmd: warm.wire,
      body: warm.body,
    });
    await nt.takeFrames(pid, { cursor, waitMs: 800, maxFrames: 4096 });
    let requestId = 10000;
    for (const probeCase of cases) {
      const result = await probeOne(pipe, nt, pid, probeCase, ++requestId, { disconnect });
      report.results.push(result);
      console.log(
        result.cmd.padEnd(58) +
          ' ' +
          (result.proto ? `p${result.proto}` : '---') +
          ' ' +
          describeProbeStatus(result) +
          (result.error ? `；hook=${result.error}` : ''),
      );
    }
  } finally {
    pipe?.close();
    if (captureStarted) {
      try {
        report.captureStats = await nt.stopCapture(pid);
      } catch (error) {
        report.cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
  }
  if (control)
    report.controlPassed = report.results.some(
      (entry) => entry.cmd === control && entry.status === 'signed',
    );
  if (control && !report.controlPassed) {
    fail(`正对照没有成功捕获签名，本轮不能据此接受缺签结论：${control}`);
  }
  const count = (status: ProbeResult['status']) =>
    report.results.filter((entry) => entry.status === status).length;
  log(
    '共 ' +
      report.results.length +
      ' 条：签名 ' +
      count('signed') +
      '，不签名 ' +
      count('unsigned') +
      '，解析失败 ' +
      count('parse-error') +
      '，未捕获 ' +
      count('not-captured'),
  );
  const protocols = new Map<number, number>();
  for (const result of report.results) {
    if (result.proto !== undefined)
      protocols.set(result.proto, (protocols.get(result.proto) ?? 0) + 1);
  }
  log(
    `协议分布：${[...protocols].map(([proto, count]) => `${proto}=${count}`).join('，') || '无有效观测'}`,
  );
  if (count('parse-error') || count('not-captured') || report.cleanupErrors.length)
    process.exitCode = 2;
}

try {
  await main();
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error);
  console.error(`[${LABEL}] 失败：${report.failure}`);
  process.exitCode = 1;
} finally {
  closeBackend?.();
  try {
    saveReport();
  } catch (error) {
    console.error(
      `[${LABEL}] 保存报告失败：${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
