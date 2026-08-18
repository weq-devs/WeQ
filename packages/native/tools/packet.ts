/**
 * 裸包收发 tool：不构造任何业务逻辑，直接把 hex body 发给在线 QQ，返回收到的 hex。
 *
 * 底层能力（nt_helper.node 已支持，见 packages/native/src/types.ts）：
 *   - sendOidbPacket(pid, command, subCommand, body, isUid)
 *       把 body 包进 OIDB 信封，按 OidbSvcTrpcTcp.0x<cmd>_<sub> 命令发出，返回解包后的 inner reply body。
 *   - sendPacket(pid, cmd, body)
 *       用显式 SSO/trpc 命令字符串发裸 body（无 OIDB 信封），返回 raw reply body。
 *
 * body 除 hex 解析外不做任何构造/编码/加壳，收到的回复原样以 hex + hexdump 打印。
 * 唯一必须额外提供的是路由信息：OIDB 的 command/subCommand，或 raw 模式的 trpc 服务命令名，
 * 因为 QQ 的 MSF 层必须靠命令名寻址（这是发出去的包本身，不落在 body 上）。
 *
 * json 模式专用于回放 frida 脚本（../re/qq_msf_trace.js，配合 frida -o sends.jsonl）抓到的 SEND node：
 *   node 的 cmd 作为 SSO 命令名，hex 作为 body 发出，uin 直接用于注入。
 *
 * 包体嵌套说明（frida 抓包 → 本工具回放）：
 *   - frida 的 getWupBuffer() 自带 4 字节大端长度头（实测值 = 整包长度），
 *     json 模式会自动校验并剥离这 4 字节，否则头会污染 protobuf/JCE 解析。
 *   - OIDB 抓包在长度头之后还自带完整 OidbSvcTrpcTcpBase 信封
 *     （field1=command, field2=subCommand, field4=body）。json 模式走 sendPacket，
 *     不会再加信封，剥离长度头后整段信封可直接回放。
 *   - 不要拿抓包 hex 喂 oidb 模式：sendOidbPacket 会再包一层 OIDB 信封，
 *     双重嵌套必错；oidb 模式只接受内层 body（信封 field4 的内容）。
 *   - JCE 类命令（GDCTrpcProxy.service / SQQzoneSvc 等）剥离长度头后是 JCE 数据，
 *     sendPacket 走的是 trpc 通道，这类命令可能无法回放。
 *
 * 用法（需目标 QQ 正在运行且已登录）：
 *   pnpm tsx packages/native/tools/packet.ts oidb --cmd 0x9067 --sub 202 --hex "08c80210a001" [--uid] [--uin 123456] [--pid 12345]
 *   pnpm tsx packages/native/tools/packet.ts raw --sso "QunAlbum.trpc.qzone.webapp_qun_media.QunMedia.GetMediaList" --hex "0801120204" [--uin 123456] [--pid 12345]
 *   pnpm tsx packages/native/tools/packet.ts json --node sends.jsonl [--pid 12345]
 *   pnpm tsx packages/native/tools/packet.ts json --node '{"cmd":"GDCTrpcProxy.service","uin":"123456","appSeq":623,"ssoSeq":-1,"len":72,"hex":"00000048..."}' [--pid 12345]
 *
 * 进程选择：默认假设只有一个 QQ 进程；多个进程时优先按 node.uin / --uin 匹配，否则用第一个。
 * --node 可以是 JSON 对象文件、内联 JSON，或 JSONL（取第一条）。
 * hex 支持连续字符串、空格分隔、以及逐字节 0x 前缀（如 "0x08 0x01"）。
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadNative } from '../src/index';
import type { QqPortLoginInfo } from '../src/types';
import { testEnv } from '@weq/testkit';

type Mode = 'oidb' | 'raw' | 'json';

interface CliArgs {
  mode: Mode;
  cmd?: string;
  sub?: number;
  sso?: string;
  hex?: string;
  node?: string;
  uid: boolean;
  uin?: string;
  pid?: number;
}

/** frida 脚本抓到的 SEND node（qq_msf_trace.js + frida -o sends.jsonl 的每一行）。 */
interface JsonNode {
  /** 'send' 表示真正的发包节点；ready/miss/error 等诊断行会被 JSONL 解析跳过。 */
  kind?: string;
  cmd?: string;
  uin?: string;
  appSeq?: number;
  ssoSeq?: number;
  len?: number;
  hex?: string;
}

const USAGE = `用法:
  pnpm tsx packages/native/tools/packet.ts oidb --cmd 0x9067 --sub 202 --hex "08c80210a001" [--uid] [--uin 123456] [--pid 12345]
  pnpm tsx packages/native/tools/packet.ts raw --sso "QunAlbum.trpc.qzone.webapp_qun_media.QunMedia.GetMediaList" --hex "0801120204" [--uin 123456] [--pid 12345]
  pnpm tsx packages/native/tools/packet.ts json --node sends.jsonl [--pid 12345]
  pnpm tsx packages/native/tools/packet.ts json --node '{"cmd":"GDCTrpcProxy.service","uin":"123456","appSeq":623,"ssoSeq":-1,"len":72,"hex":"..."}' [--pid 12345]`;

function fail(msg: string): never {
  console.error(`[packet] 失败: ${msg}`);
  console.error(USAGE);
  process.exit(1);
}

function parseArgs(argv: string[]): CliArgs {
  const mode = argv[0] as Mode;
  if (mode !== 'oidb' && mode !== 'raw' && mode !== 'json') {
    fail(`未知模式 "${String(mode)}"，只支持 oidb / raw / json`);
  }

  const args: CliArgs = { mode, uid: false };
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i]!;
    const eq = token.indexOf('=');
    const key = eq >= 0 ? token.slice(0, eq) : token;
    const inline = eq >= 0 ? token.slice(eq + 1) : undefined;

    if (key === '--uid') {
      args.uid = true;
      continue;
    }

    const value = inline ?? argv[i + 1];
    if (value === undefined || (inline === undefined && value.startsWith('--'))) {
      fail(`参数 ${key} 缺少值`);
    }
    if (inline === undefined) i++;
    switch (key) {
      case '--cmd':
        args.cmd = value;
        break;
      case '--sub':
        args.sub = parseNumber(value, '--sub');
        break;
      case '--sso':
        args.sso = value;
        break;
      case '--hex':
        args.hex = value;
        break;
      case '--node':
        args.node = value;
        break;
      case '--uin':
        args.uin = value;
        break;
      case '--pid':
        args.pid = parseNumber(value, '--pid');
        break;
      default:
        fail(`未知参数 ${key}`);
    }
  }

  if (mode === 'json') {
    if (!args.node) fail('json 模式缺少 --node（JSON 文件路径或内联 JSON）');
  } else {
    if (!args.hex) fail('缺少 --hex（要发送的 body，hex 字符串）');
    if (mode === 'oidb') {
      if (!args.cmd) fail('oidb 模式缺少 --cmd（如 0x9067）');
      if (args.sub === undefined) fail('oidb 模式缺少 --sub（如 202）');
    } else if (!args.sso) {
      fail('raw 模式缺少 --sso（trpc 服务命令名）');
    }
  }
  return args;
}

function parseNumber(raw: string, label: string): number {
  const value = /^0x/i.test(raw) ? Number.parseInt(raw, 16) : Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) fail(`${label} 不是合法数字: ${raw}`);
  return value;
}

/** 兼容 "08011202" / "08 01 12 02" / "0x08 0x01 0x12 0x02" 三种写法。 */
function parseHex(raw: string): Buffer {
  const compact = raw.replace(/\s+/g, '').replace(/0x/gi, '');
  if (compact.length === 0) return Buffer.alloc(0);
  if (compact.length % 2 !== 0) fail(`hex 长度必须是偶数，收到: ${compact}`);
  if (!/^[0-9a-fA-F]+$/.test(compact)) fail(`hex 含非法字符: ${compact}`);
  return Buffer.from(compact, 'hex');
}

// pnpm --filter 运行脚本时 cwd 是 packages/native，相对路径优先按仓库根目录解析，
// 这样从仓库根目录敲 `--node .\tmp\cad.jsonl` 也能命中。
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');

/**
 * 解析 --node：优先当文件读（JSON 对象，或 JSONL 逐行找第一条真 SEND），否则当内联 JSON。
 * JSONL 会跳过 kind 非 send 的诊断行（ready/miss/error 等）。
 */
function parseNode(raw: string): JsonNode {
  const trimmed = raw.trim();
  let text: string | null = null;
  if (!trimmed.startsWith('{')) {
    const candidates = [raw];
    if (!existsSync(raw)) {
      candidates.push(resolve(REPO_ROOT, raw));
    }
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        text = readFileSync(candidate, 'utf8');
        break;
      }
    }
  }
  if (text === null) text = raw;
  const tryParse = (s: string): JsonNode | null => {
    try {
      const v = JSON.parse(s) as JsonNode;
      return v && typeof v === 'object' ? v : null;
    } catch {
      return null;
    }
  };
  const direct = tryParse(text);
  if (direct) return direct;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const node = tryParse(trimmed);
    if (!node) continue;
    const isSend =
      node.cmd !== undefined &&
      node.hex !== undefined &&
      (node.kind === undefined || node.kind === 'send');
    if (isSend) return node;
  }
  fail(`无法解析 --node：既不是 JSON 对象，JSONL 里也没有 SEND 节点（${raw}）`);
}

/**
 * 通用 protobuf 结构扫描器（不依赖 schema）。
 * 现有 @weq/protocol 的 codec 是 schema 驱动的（decode 需要预定义 ProtoMessage），
 * 任意收到的包没有 schema，所以这里做轻量字段级解析：
 *   - 递归展开 wire 2（LEN）字段，子段能按 protobuf 解析就继续展开；
 *   - 解析失败（非法字段号/wire 类型/越界）返回 ok=false，调用方提示可能是 JCE 等其它编码。
 */
const PROTO_MAX_DEPTH = 8;
const PROTO_MAX_FIELDS = 100;
const PROTO_LEAF_PREVIEW = 48;

function readProtoVarint(buf: Buffer, offset: number): { value: bigint; next: number } | null {
  let value = 0n;
  let shift = 0n;
  let i = offset;
  while (i < buf.length) {
    const b = buf[i++]!;
    value |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value, next: i };
    shift += 7n;
    if (shift > 70n) return null;
  }
  return null;
}

/** 检查 Buffer 是否是一段可读的 UTF-8 字符串（支持中文/emoji等，过滤控制字符） */
function tryDecodeUtf8(buf: Buffer): string | null {
  if (buf.length === 0) return '';
  const text = buf.toString('utf8');
  // 重新编码比对，防止 invalid UTF-8 乱码
  if (Buffer.from(text, 'utf8').compare(buf) !== 0) return null;
  // 检查是否包含除了标准空白符（换行、制表符等）之外的 C0/C1 控制字符
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || (code >= 0x7f && code <= 0x9f)) {
      return null;
    }
  }
  return text;
}

function dumpProto(buf: Buffer, depth = 0): { ok: boolean; lines: string[] } {
  const lines: string[] = [];
  if (buf.length === 0) return { ok: true, lines: ['(空)'] };
  if (depth > PROTO_MAX_DEPTH) return { ok: true, lines: ['... (超过嵌套深度上限)'] };
  let offset = 0;
  let count = 0;
  while (offset < buf.length) {
    if (count++ >= PROTO_MAX_FIELDS) {
      lines.push('... (字段过多，截断)');
      break;
    }
    const key = readProtoVarint(buf, offset);
    if (!key) return { ok: false, lines };
    const field = Number(key.value >> 3n);
    const wire = Number(key.value & 7n);
    if (field < 1 || field > 0x1fffffff || (wire !== 0 && wire !== 1 && wire !== 2 && wire !== 5)) {
      return { ok: false, lines };
    }
    offset = key.next;
    const indent = '  '.repeat(depth + 1);
    if (wire === 0) {
      const r = readProtoVarint(buf, offset);
      if (!r) return { ok: false, lines };
      offset = r.next;
      lines.push(`${indent}${field}: varint ${r.value}`);
    } else if (wire === 2) {
      const r = readProtoVarint(buf, offset);
      if (!r || Number(r.value) > buf.length - r.next) return { ok: false, lines };
      const start = r.next;
      const end = start + Number(r.value);
      offset = end;
      const sub = buf.subarray(start, end);

      // --- 关键修改：识别 string / 递归嵌套 message / 兜底 bytes ---
      const utf8Str = tryDecodeUtf8(sub);
      const nested = sub.length > 0 && depth + 1 <= PROTO_MAX_DEPTH ? dumpProto(sub, depth + 1) : { ok: false, lines: [] };

      if (utf8Str !== null) {
        // 可转义展示换行等字符，防止破坏排版
        const formatted = JSON.stringify(utf8Str);
        lines.push(`${indent}${field}: string(${sub.length}) ${formatted}`);
      } else if (nested.ok && nested.lines.length > 0) {
        lines.push(`${indent}${field}: message(${sub.length}) →`);
        lines.push(...nested.lines);
      } else {
        const preview = sub.subarray(0, PROTO_LEAF_PREVIEW).toString('hex');
        lines.push(
            `${indent}${field}: bytes(${sub.length}) ${preview}${sub.length > PROTO_LEAF_PREVIEW ? '...' : ''}`,
        );
      }
    } else if (wire === 5) {
      if (offset + 4 > buf.length) return { ok: false, lines };
      lines.push(`${indent}${field}: fixed32 ${buf.readUInt32LE(offset)}`);
      offset += 4;
    } else {
      if (offset + 8 > buf.length) return { ok: false, lines };
      lines.push(`${indent}${field}: fixed64 ${buf.readBigUInt64LE(offset)}`);
      offset += 8;
    }
  }
  return { ok: true, lines };
}

/** 尽力打印 protobuf 结构；解析失败时提示可能是 JCE 等其它编码。 */
function printProtoStructure(label: string, buf: Buffer): void {
  const { ok, lines } = dumpProto(buf);
  console.log(`[packet] ${label} protobuf 结构:`);
  if (ok) {
    console.log(lines.join('\n'));
  } else {
    console.log('(无法按 protobuf 解析——可能是 JCE/其它编码，请结合上面的 hexdump 判断)');
  }
}

/**
 * 剥离 frida getWupBuffer() 自带的 4 字节大端长度头。
 * 实测头值 = 整包长度（含头自身）；同时兼容“= 剩余长度”的另一种写法。
 * 只有头值校验通过才剥离，避免误伤正常 body。
 */
function stripWupHeader(body: Buffer): { body: Buffer; stripped: boolean } {
  if (body.length < 4) return { body, stripped: false };
  const head = body.readUInt32BE(0);
  if (head === body.length || head === body.length - 4) {
    return { body: body.subarray(4), stripped: true };
  }
  return { body, stripped: false };
}

/** 复刻 frida 脚本的 hexdump 格式：8位偏移 + 8/8 字节分组 + |ascii|。一次一包，不截断。 */
function formatHexdump(buf: Buffer): string {
  const lines: string[] = [];
  for (let off = 0; off < buf.length; off += 16) {
    const h: string[] = [];
    const t: string[] = [];
    for (let j = 0; j < 16; j++) {
      if (off + j < buf.length) {
        const v = buf[off + j]!;
        h.push(v.toString(16).padStart(2, '0'));
        t.push(v >= 0x20 && v <= 0x7e ? String.fromCharCode(v) : '.');
      } else {
        h.push('  ');
        t.push(' ');
      }
    }
    lines.push(
      off.toString(16).padStart(8, '0') +
        '  ' +
        h.slice(0, 8).join(' ') +
        '  ' +
        h.slice(8).join(' ') +
        '  |' +
        t.join('') +
        '|',
    );
  }
  return lines.join('\n');
}

function probeSafe(
  nt: ReturnType<typeof loadNative>['ntHelper'],
  pid: number,
): QqPortLoginInfo | null {
  try {
    return nt.probeQqLoginInfo(pid);
  } catch (e) {
    console.warn(`[packet] probeQqLoginInfo(${pid}) 抛错:`, e);
    return null;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const node = args.mode === 'json' ? parseNode(args.node!) : undefined;
  if (node && (!node.cmd || node.hex === undefined)) {
    fail('JSON node 缺少 cmd 或 hex 字段');
  }
  const nt = loadNative().ntHelper;

  // ---- 选目标 pid：--pid > 唯一进程 > 按 uin 匹配（简单逻辑）----
  const pids = nt.getQqProcesses();
  console.log(`[packet] 运行中的 QQ 进程 pid: ${pids.length ? pids.join(', ') : '(无)'}`);
  if (pids.length === 0) {
    fail('没有运行中的 QQ.exe，请先打开并登录目标账号');
  }

  let targetPid: number;
  if (args.pid !== undefined) {
    if (!pids.includes(args.pid)) {
      fail(`指定的 --pid ${args.pid} 不在运行中的 QQ 进程列表里 (${pids.join(', ')})`);
    }
    targetPid = args.pid;
    console.log(`[packet] 使用 --pid 指定的 pid=${targetPid}`);
  } else if (pids.length === 1) {
    targetPid = pids[0]!;
    console.log(`[packet] 仅一个 QQ 进程，默认目标 pid=${targetPid}`);
  } else {
    const wantUin = args.uin ?? node?.uin;
    const matched = pids
      .map((pid) => ({ pid, info: probeSafe(nt, pid) }))
      .find((p) => p.info?.uin === wantUin)?.pid;
    targetPid = matched ?? pids[0]!;
    console.log(
      `[packet] 多个 QQ 进程，${matched !== undefined ? `按 uin=${wantUin} 匹配` : '未按 uin 匹配，默认使用'} pid=${targetPid}`,
    );
  }

  // ---- 确定注入用的 uin：--uin > node.uin > 进程探测 > 根 .env ----
  const probed = probeSafe(nt, targetPid);
  const uin = args.uin ?? node?.uin ?? probed?.uin ?? fallbackUin();
  if (!uin) {
    fail('无法确定该 QQ 进程的 uin，请用 --uin 传入');
  }
  console.log(`[packet] 使用 uin=${uin}`);

  // ---- 注入 hook（OIDB / raw 发包都依赖注入后的 mojo 控制管道）----
  console.log(`\n[packet] 注入 hook 到 pid=${targetPid} ...`);
  const status = await nt.injectAndGetStatusEmbedded(targetPid, uin);
  console.log(`[packet] 注入结果: pid=${status.pid} uin=${status.uin} loggedIn=${status.loggedIn}`);

  // ---- 组装 body 并发送 ----
  let body: Buffer;
  let describe: string;
  if (args.mode === 'json') {
    body = parseHex(node!.hex ?? '');
    describe = `raw cmd=${node!.cmd}`;
    if (typeof node!.len === 'number' && node!.len !== body.length) {
      console.warn(`[packet] 警告: node.len=${node!.len} 与 hex 实际长度 ${body.length} 不一致`);
    }
    const stripped = stripWupHeader(body);
    if (stripped.stripped) {
      console.log(
        `[packet] 已剥离 4 字节 WUP 长度头（${body.length} → ${stripped.body.length} 字节）`,
      );
      body = stripped.body;
    }
    console.log(
      `[packet] JSON node: cmd=${node!.cmd} uin=${node!.uin ?? '?'} appSeq=${node!.appSeq ?? '?'} ssoSeq=${node!.ssoSeq ?? '?'} len=${node!.len ?? '?'}`,
    );
  } else if (args.mode === 'oidb') {
    body = parseHex(args.hex!);
    describe = `OIDB cmd=${parseNumber(args.cmd!, '--cmd')} sub=${args.sub}`;
  } else {
    body = parseHex(args.hex!);
    describe = `raw cmd=${args.sso}`;
  }
  console.log(`[packet] ${describe} body 长度=${body.length} 字节`);
  if (body.length > 0) {
    console.log(`[packet] 请求 hexdump:\n${formatHexdump(body)}`);
    printProtoStructure('请求', body);
  }

  const reply =
    args.mode === 'oidb'
      ? await nt.sendOidbPacket(
          targetPid,
          parseNumber(args.cmd!, '--cmd'),
          args.sub!,
          body,
          args.uid,
        )
      : await nt.sendPacket(targetPid, args.mode === 'json' ? node!.cmd! : args.sso!, body);

  // ---- 打印收到的回复 ----
  console.log(`\n[packet] === 收到的回复 ===`);
  console.log(`长度: ${reply.length} 字节`);
  console.log(`hex: ${reply.toString('hex')}`);
  if (reply.length > 0) {
    console.log(`hexdump:\n${formatHexdump(reply)}`);
    printProtoStructure('回复', reply);
  }
}

function fallbackUin(): string | undefined {
  try {
    return testEnv.uin;
  } catch {
    return undefined;
  }
}

main().catch((e) => {
  console.error('[packet] 失败:', e);
  process.exit(1);
});
