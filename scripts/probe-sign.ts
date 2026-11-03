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
 *
 * 权限：抓包要 root 或 `CAP_NET_RAW`（Linux）。发包本身不需要。
 */

import { createConnection, type Socket } from 'node:net';
import { readdirSync, writeFileSync } from 'node:fs';
import { loadNativeSafe } from '../packages/native/src';
import type { CapturedFrame, NtHelperBinding } from '../packages/native/src';

const LABEL = 'probe-sign';

/** hook 的 pipe 线格式，与 nnphook `apps/qq/common/pipe_protocol.hpp` 对齐。 */
const PIPE_MAGIC = 0x31504851;
const PIPE_VERSION = 1;
const PIPE_HEADER_SIZE = 40;
const PIPE_OP_HELLO = 1;
const PIPE_OP_SEND_REQUEST = 2;
const PIPE_OP_SEND_REPLY = 4;
const PIPE_OP_ERROR = 5;

/** SSO reserved 里承载 `SsoSecureInfo` 的字段号。 */
const RESERVED_SEC_INFO_TAG = 24;

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
  console.error(`[${LABEL}] 失败: ${message}`);
  process.exit(1);
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

// ─────────────────────────── 默认命令表 ───────────────────────────

/** WeQ 在用、且 subCommand 固定的 OIDB 命令（`cmd_sub` 形式）。 */
const DEFAULT_OIDB_CASES: readonly string[] = [
  '5d6_6',
  '5d6_19',
  '6d6_2',
  '6d6_3',
  '6d6_4',
  '6d6_5',
  '6d7_0',
  '6d7_1',
  '6d7_2',
  '6d8_1',
  '6d8_2',
  '6d8_3',
  '7e5_104',
  '7ed_12',
  '88d_110',
  '89a_0',
  '89a_15',
  '8a0_1',
  '8a7_0',
  '8b7_5',
  '8fc_2',
  '8fc_3',
  'a80_1',
  'b5d_44',
  'cd4_1',
  'cde_2',
  'd69_0',
  'd72_0',
  'dc2_34',
  'e07_0',
  'e37_1200',
  'eac_1',
  'eb7_1',
  'ed3_1',
  'f16_1',
  'fd4_1',
  'fe1_2',
  'fe1_3',
  'fe5_2',
  'fe7_3',
  '102a_0',
  '102a_1',
  '1096_1',
  '1097_1',
  '10c0_2',
  '10eb_1',
  '1124_1',
  '1125_1',
  '1126_1',
  '112a_2',
  '112e_1',
  '11e9_200',
  '11ea_200',
  '11ec_1',
  '1253_1',
  '1255_0',
  '126d_200',
  '126e_200',
  '12a9_100',
  '12a9_103',
  '12b6_0',
  '902e_1',
  '902f_1',
  '9067_202',
  '9083_1',
  '912e_0',
  '912f_0',
  '921b_0',
  '929b_0',
  '93cf_1',
  '93d0_1',
  '93d1_1',
  '93d3_1',
  '93d7_1',
  '93db_1',
  '9436_0',
  '9437_0',
  '9474_0',
  '967c_0',
  '967d_0',
  '967e_0',
];

/** WeQ 在用的 raw trpc / 服务命令（不套 OIDB 信封）。 */
const DEFAULT_RAW_CASES: readonly string[] = [
  'MessageSvc.PbSendMsg',
  'trpc.msg.msg_svc.MsgService.SsoReadedReport',
  'trpc.msg.msg_svc.MsgService.SsoGroupRecallMsg',
  'trpc.msg.msg_svc.MsgService.SsoC2CRecallMsg',
  'trpc.msg.register_proxy.RegisterProxy.SsoGetGroupMsg',
  'trpc.msg.register_proxy.RegisterProxy.SsoGetC2cMsg',
  'trpc.group.long_msg_interface.MsgService.SsoSendLongMsg',
  'trpc.group.long_msg_interface.MsgService.SsoRecvLongMsg',
  'trpc.qq_new_tech.status_svc.StatusService.SetStatus',
  'trpc.qpay.red_pack_skin.Skin.SsoGetSkinInfo',
  'QunAlbum.trpc.qzone.webapp_qun_media.QunMedia.GetMediaList',
];

// ─────────────────────────── protobuf 小工具 ───────────────────────────

function writeVarint(out: number[], value: bigint): void {
  let current = value;
  while (current > 0x7fn) {
    out.push(Number((current & 0x7fn) | 0x80n));
    current >>= 7n;
  }
  out.push(Number(current));
}

/** `(command, subCommand, innerBody)` → OIDB 信封（内层 body 允许为空）。 */
export function buildOidbEnvelope(command: number, subCommand: number, inner: Buffer): Buffer {
  const out: number[] = [];
  const varintField = (field: number, value: bigint): void => {
    writeVarint(out, BigInt(field) << 3n);
    writeVarint(out, value);
  };
  varintField(1, BigInt(command));
  varintField(2, BigInt(subCommand));
  varintField(3, 0n);
  writeVarint(out, (4n << 3n) | 2n);
  writeVarint(out, BigInt(inner.length));
  out.push(...inner);
  varintField(6, 0n);
  return Buffer.from(out);
}

function readVarint(buf: Buffer, offset: number): { value: bigint; next: number } {
  let result = 0n;
  let shift = 0n;
  let index = offset;
  for (;;) {
    const byte = buf[index];
    if (byte === undefined) throw new Error('varint 越界');
    index += 1;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: result, next: index };
    shift += 7n;
  }
}

/** 解一层 protobuf，返回 `tag → bytes | bigint`。 */
function decodeFields(buf: Buffer): Map<number, Buffer | bigint> | null {
  const out = new Map<number, Buffer | bigint>();
  let index = 0;
  while (index < buf.length) {
    const tag = readVarint(buf, index);
    index = tag.next;
    const field = Number(tag.value >> 3n);
    const wire = Number(tag.value & 7n);
    if (field === 0) return null;
    if (wire === 2) {
      const len = readVarint(buf, index);
      index = len.next;
      const size = Number(len.value);
      if (index + size > buf.length) return null;
      out.set(field, buf.subarray(index, index + size));
      index += size;
    } else if (wire === 0) {
      const value = readVarint(buf, index);
      index = value.next;
      out.set(field, value.value);
    } else if (wire === 1) {
      out.set(field, buf.subarray(index, index + 8));
      index += 8;
    } else if (wire === 5) {
      out.set(field, buf.subarray(index, index + 4));
      index += 4;
    } else {
      return null;
    }
  }
  return out;
}

// ─────────────────────────── SSO 帧解析 ───────────────────────────

/**
 * 从抓到的明文里取 SSO head 的 reserved 字段。
 *
 * `plain` 是 **SSO 层**（service 层已被 native 剥掉），开头是 head 长度前缀。
 * 协议 12 的 head 依次是 `seq/i32 · subAppId/i32 · 2052/i32 · preamble(12B) ·
 * a2 · command · cookies · guid · "" · version/i16 · reserved`；协议 13 只有
 * `command · cookies · reserved`。
 *
 * 长度前缀语义：字段值 = **从该前缀起点算起的整段长度**（含前缀自身）。
 */
function readReserved(plain: Buffer, protocol: number): Buffer | null {
  try {
    const headLen = plain.readUInt32BE(0);
    const head = plain.subarray(4, headLen);
    let offset = 0;
    const readPrefixed = (): Buffer => {
      const size = head.readUInt32BE(offset);
      const data = head.subarray(offset + 4, offset + size);
      offset += size;
      return data;
    };
    const readPrefixedI16 = (): Buffer => {
      const size = head.readUInt16BE(offset);
      const data = head.subarray(offset + 2, offset + size);
      offset += size;
      return data;
    };
    if (protocol === 12) {
      offset = 12 + 12; // seq/subAppId/2052 + preamble
      readPrefixed(); // a2
    }
    readPrefixed(); // command
    readPrefixed(); // cookies
    if (protocol === 12) {
      readPrefixed(); // guid
      readPrefixed(); // ""（空）
      readPrefixedI16(); // version
    }
    return readPrefixed();
  } catch {
    // 帧结构不认识（压缩体 / 新协议版本）时按「没看到 reserved」处理，
    // 由调用方把这一条标成「未发出」，而不是让整轮扫描挂掉。
    return null;
  }
}

interface SecInfo {
  sign: number;
  token: number;
  extra: number;
}

/** 从 reserved 里取 `SecInfo`；没有 tag 24 或 tag 24 为空都算「不签名」。 */
function readSecInfo(reserved: Buffer | null): SecInfo | null {
  if (!reserved || reserved.length === 0) return null;
  const fields = decodeFields(reserved);
  const sec = fields?.get(RESERVED_SEC_INFO_TAG);
  if (!(sec instanceof Buffer) || sec.length === 0) return null;
  const inner = decodeFields(sec);
  if (!inner) return null;
  const size = (tag: number): number => {
    const value = inner.get(tag);
    return value instanceof Buffer ? value.length : 0;
  };
  return { sign: size(1), token: size(2), extra: size(3) };
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
    this.socket.end();
  }
}

// ─────────────────────────── 探测 ───────────────────────────

interface ProbeCase {
  /** 线上命令名。 */
  wire: string;
  /** 发给 pipe 的 OIDB 信封（raw 命令为空 body）。 */
  body: Buffer;
}

interface ProbeResult {
  cmd: string;
  sent: boolean;
  error?: string;
  secInfo: SecInfo | null;
  reservedTags: number[] | null;
  replyStatus?: number;
  replyLength?: number;
}

/**
 * `cmd_sub` 的解析规则：命令按 16 进制，子命令按 **10 进制**。
 *
 * 例：`89a_15` → `0x89a` + 子命令 15；`12a9_103` → `0x12a9` + 子命令 103；
 * `11e9_200` → `0x11e9` + 子命令 200。OIDB 子命令习惯上就是十进制写的，别按
 * 十六进制解（那样 `0x6d7_2` 会被发成 `_16`，命令直接发不出去）。
 */
export function parseCase(spec: string): ProbeCase {
  // 同时接受 `89a_15` 和 `0x89a_15`（有 `0x` 前缀时不会被当成十六进制再解析一次）。
  if (/^(?:0x)?[0-9a-f]+_\d+$/i.test(spec)) {
    const [rawCommand, subText] = spec.split('_');
    const commandHex = rawCommand!.replace(/^0x/i, '');
    const command = Number.parseInt(commandHex, 16);
    const subCommand = Number.parseInt(subText!, 10);
    return {
      wire: `OidbSvcTrpcTcp.0x${command.toString(16)}_${subCommand}`,
      // 空 body 在部分命令上会被 hook 判为空包而不发；塞一个空的 tag1 子消息
      // （`0a 00`）让帧一定上线——我们只关心签名位，不看业务结果。
      body: buildOidbEnvelope(command, subCommand, Buffer.from([0x0a, 0x00])),
    };
  }
  return { wire: spec, body: Buffer.from([0x0a, 0x00]) };
}

/**
 * 可能放着 hook socket 的目录。
 *
 * 注意 `sudo` 会重置 `XDG_RUNTIME_DIR`，且 `getuid()` 变成 0，所以不能只靠这两个
 * 推断：`/run/user/<uid>` 和 `/tmp/snowluma-<uid>` 都按可见的 uid 枚举一遍。
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
  return [...candidates].filter((dir) => {
    try {
      readdirSync(dir);
      return true;
    } catch {
      return false;
    }
  });
}

/** 在已知 runtime 目录里找指定 pid 的 control socket。 */
function findControlSocket(pid: number): string | null {
  const name = `mojo.${pid}.control.sock`;
  for (const dir of findRuntimeDirs()) {
    try {
      if (readdirSync(dir).includes(name)) return `${dir}/${name}`;
    } catch {}
  }
  return null;
}

/** 从 runtime 目录里的 `mojo.<pid>.control.sock` 推断 pid。 */
function discoverPid(): number | null {
  for (const dir of findRuntimeDirs()) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    const pids = entries
      .map((name) => /^mojo\.(\d+)\.control\.sock$/.exec(name)?.[1])
      .filter((value): value is string => Boolean(value))
      .map((value) => Number(value))
      .sort((a, b) => a - b);
    if (pids.length > 0) return pids[pids.length - 1]!;
  }
  return null;
}

async function probeOne(
  pipe: PipeClient,
  nt: NtHelperBinding,
  pid: number,
  probeCase: ProbeCase,
  requestId: number,
): Promise<ProbeResult> {
  const result: ProbeResult = {
    cmd: probeCase.wire,
    sent: false,
    secInfo: null,
    reservedTags: null,
  };

  // 同一命令最多发 3 次。抓包侧偶尔只投递「未解密」的副本（`cmd` 为空），单次采样
  // 会误判成「没发出去」；多试几次取第一个解出来的 c2s 帧。
  let cursor = (await nt.takeFrames(pid, { maxFrames: 1 })).nextCursor;
  const captured: CapturedFrame[] = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
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
    captured.push(...chunk.frames);
    const hit = captured.some(
      (frame) =>
        frame.direction === 'c2s' &&
        typeof frame.cmd === 'string' &&
        frame.cmd.toLowerCase() === probeCase.wire.toLowerCase() &&
        Boolean(frame.plain),
    );
    if (hit) break;
  }
  // 抓包层对同一帧可能投递两份（一份已解密、一份 `cmd` 为空），这里只认解出来的那份：
  // 带 `cmd` 且名字匹配的 c2s 帧才算「QQ 真的发出去了」。
  const wanted = probeCase.wire.toLowerCase();
  const sent = captured.filter(
    (frame: CapturedFrame) =>
      frame.direction === 'c2s' &&
      typeof frame.cmd === 'string' &&
      frame.cmd.toLowerCase() === wanted &&
      Boolean(frame.plain),
  );

  const error = pipe.find(PIPE_OP_ERROR, requestId);
  if (error) {
    result.error = `${error.status} ${error.msg}`;
    // hook 侧拒绝时不会产生帧；把它当成「未发出」并带上原因，别只看有没有帧。
    if (sent.length === 0) return result;
  }

  const reply = pipe.find(PIPE_OP_SEND_REPLY, requestId);
  if (reply) {
    result.replyStatus = reply.status;
    result.replyLength = reply.body.length;
  }

  if (sent.length === 0) return result;
  result.sent = true;

  const frame = sent[0]!;
  const reserved = frame.plain ? readReserved(frame.plain, frame.proto) : null;
  if (reserved) {
    const tags = decodeFields(reserved);
    result.reservedTags = tags ? [...tags.keys()].sort((a, b) => a - b) : null;
  }
  result.secInfo = readSecInfo(reserved);
  return result;
}

async function main(): Promise<void> {
  const explicitPid = opt('--pid');
  const pid = explicitPid ? Number(explicitPid) : discoverPid();
  if (!pid || !Number.isInteger(pid) || pid <= 0) {
    fail(
      '找不到运行中的 hook pipe。请先让 QQ 被注入并上线，或用 --pid 指定；' +
        `已查找目录：${findRuntimeDirs().join(', ')}`,
    );
  }

  const runtimeDir = opt('--runtime-dir');
  const controlPath = runtimeDir
    ? `${runtimeDir}/mojo.${pid}.control.sock`
    : (findControlSocket(pid) ??
      fail(
        `找不到 pid=${pid} 的 hook control socket；` +
          `已查找目录：${findRuntimeDirs().join(', ')}`,
      ));

  const loaded = loadNativeSafe();
  if (!loaded.ok) fail(`native 加载失败（先跑 \`pnpm native:fetch\`）：${loaded.message}`);
  const nt: NtHelperBinding = loaded.bundle.ntHelper;

  const cmdArgs = opts('--cmd');
  const cases: ProbeCase[] =
    cmdArgs.length > 0
      ? cmdArgs.map(parseCase)
      : [...DEFAULT_OIDB_CASES, ...DEFAULT_RAW_CASES].map(parseCase);

  log(`pid=${pid} control=${controlPath} 命令数=${cases.length}`);

  const support = nt.probeCaptureSupport();
  if (!support.available) fail(`抓包不可用：${support.hint}`);
  if (!support.elevated) {
    log(`⚠ ${support.hint}（抓包可能失败）`);
  }

  const material = await nt.scanSessionMaterial(pid).catch((error: unknown) => {
    fail(`读取会话物料失败：${error instanceof Error ? error.message : String(error)}`);
  });
  if (!material.d2Key) fail('没读到 d2key，抓包无法解密');
  await nt.startCapture(pid, { d2Key: material.d2Key, ringFrames: 16384 });
  // 网卡/BPF 就绪后第一条解密帧可能还没到，等一拍再发包，避免首包拿不到 `cmd`。
  await new Promise((resolve) => setTimeout(resolve, 600));

  const pipe = await PipeClient.connect(controlPath).catch((error: unknown) => {
    fail(`连接 ${controlPath} 失败：${error instanceof Error ? error.message : String(error)}`);
  });
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const hello = pipe.hello();
  if (!hello) fail('pipe 握手失败：没收到 hello 帧');
  log(`pipe 已连接（hello: ${hello.msg}）`);

  // 预热：首帧常以「未解密」形态入环（`cmd` 为空、`plain` 为密文长度），抓包读线程
  // 走热之后才稳定。先发一包非关键命令、把结果丢掉，代价最小。
  {
    const warmCursor = (await nt.takeFrames(pid, { maxFrames: 1 })).nextCursor;
    pipe.send({
      op: PIPE_OP_SEND_REQUEST,
      requestId: 9_999,
      flags: 0,
      cmd: 'OidbSvcTrpcTcp.0x102a_1',
      body: buildOidbEnvelope(0x102a, 1, Buffer.from([0x0a, 0x00])),
    });
    await nt.takeFrames(pid, { cursor: warmCursor, waitMs: 800, maxFrames: 4096 });
  }

  const results: ProbeResult[] = [];
  let requestId = 10_000;
  try {
    for (const probeCase of cases) {
      requestId += 1;
      const result = await probeOne(pipe, nt, pid, probeCase, requestId);
      results.push(result);
      const status = result.secInfo
        ? `签名 sign=${result.secInfo.sign} token=${result.secInfo.token} extra=${result.secInfo.extra}`
        : result.sent
          ? '不签名'
          : `未发出${result.error ? `（${result.error}）` : ''}`;
      console.log(`${result.cmd.padEnd(58)} ${status}`);
    }
  } finally {
    pipe.close();
    await nt.stopCapture(pid).catch(() => undefined);
  }

  const signed = results.filter((item) => item.secInfo);
  console.log('');
  log(
    `共 ${results.length} 条：签名 ${signed.length}，不签名 ${results.filter((r) => r.sent && !r.secInfo).length}，未发出 ${results.filter((r) => !r.sent).length}`,
  );
  if (signed.length > 0) {
    log('签名命令：');
    for (const item of signed) console.log(`  ${item.cmd}`);
  }

  const jsonPath = opt('--json');
  if (jsonPath) {
    writeFileSync(jsonPath, JSON.stringify(results, null, 1));
    log(`结果已写入 ${jsonPath}`);
  }
}

await main();
