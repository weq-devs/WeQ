/**
 * 通用 SSO 发包脚本：借同机在线 QQ 的凭据，直发一包**自己指定**的 SSO / OIDB 请求，
 * 把服务端回包按 hex 打出来。一条链路全部复用现有模块，不重写任何底层能力：
 *
 *   1. 探测 pid / 第一个登录的 uin —— `login.db` 解出账号表（uin + uid + 昵称），
 *      再用每个账号 `nt_msg.db` 的写锁反查 pid（`platform.resolveQqPid`），
 *      取第一个真正在线的账号。
 *   2. 扫描内存拿发包凭据 —— `scanSessionMaterial(pid)` 读出该会话的 a2 / d2 / d2key。
 *   3. 扫描需要的数据 —— 设备 guid（`readDeviceGuid`，离线读 QQ 数据根，不要权限）、
 *      `subAppId`（`resolveSubAppId`，扫运行中 QQ 的 `major.node`）。
 *   4. 按平台取配置 —— win32 / darwin / linux 各自的 `create*Platform`（数据根、
 *      `wrapper.node` / `major.node`、账号目录派生规则）。
 *   5. 登记 SSO 会话 —— `registerSsoSession`（native 的 `setSsoSession`，只存不连）。
 *   6. 发包 —— OIDB 走 `sendOidbPacket`，trpc 原始命令走 `sendPacket`；
 *      回包是解出来的内层 body，这里按 hex 原样打印。
 *
 * 用法：
 *   # OIDB：命令字 + 内层 body
 *   pnpm tsx scripts/sso_send.ts --cmd 0x9067_202 --body 0a 02 12 00
 *   # 抓包整帧直接贴进来（脚本自己剥 4 字节长度前缀 + OIDB 信封）
 *   pnpm tsx scripts/sso_send.ts --cmd OidbSvc.0xe07_0 --body "00 00 00 F8 08 87 1C ..."
 *   # 加签名 / 走 UIN-form / 指定账号 / 只看不发
 *   pnpm tsx scripts/sso_send.ts --cmd 0x9082_1 --body-file body.hex --sign --is-uid
 *   pnpm tsx scripts/sso_send.ts --cmd OidbSvc.0xe07_0 --body-file body.hex --dry-run
 *   pnpm tsx scripts/sso_send.ts --list
 *   # trpc 原始命令（不套 OIDB 信封）
 *   pnpm tsx scripts/sso_send.ts --cmd QunAlbum.trpc.qzone.webapp_qun_media.QunMedia.GetMediaList --body 0a 02 12 00
 *
 * 权限：读别的进程内存 = ptrace attach。Linux 要 root（或 `ptrace_scope=0` /
 * `CAP_SYS_PTRACE`），macOS 要 root 且 SIP 关掉，Windows 要管理员。被内核拒绝时脚本会
 * 打出怎么放行 / 怎么提权重跑。
 */

import { readFileSync } from 'node:fs';
import { loadNative } from '../packages/native/src';
import type { Platform } from '../packages/platform/src';
import {
  createDarwinPlatform,
  createLinuxPlatform,
  createWin32Platform,
} from '../packages/platform/src';
import {
  registerSsoSession,
  resolveDeviceGuid,
  resolveSubAppId,
} from '../packages/service/src/account/sso_session';
import { readLoginAccounts } from '../packages/service/src/bootstrap/login_db';
import { ensureAttached } from '../packages/testkit/src/attach';

const LABEL = 'sso-send';

function log(message: string): void {
  console.log(`[${LABEL}] ${message}`);
}

function warn(message: string): void {
  console.warn(`[${LABEL}] ⚠ ${message}`);
}

function fail(message: string): never {
  console.error(`[${LABEL}] 失败: ${message}`);
  process.exit(1);
}

// ─────────────────────────── 命令行 ───────────────────────────

const argv = process.argv.slice(2);
const has = (flag: string): boolean => argv.includes(flag);
const opt = (name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

const HELP = `${LABEL} —— 借同机在线 QQ 的凭据发一包自己指定的 SSO / OIDB 请求，打印回包 hex。

用法:
  pnpm tsx scripts/sso_send.ts --cmd <命令字> [--body <hex> | --body-file <路径>] [选项]

选项:
  --cmd <字>      必填。OIDB 支持 0xe07_0 / OidbSvc.0xe07_0 / OidbSvcTrpcTcp.0xe07_0
                  / 9067_202（缺 0x 前缀也认）；其它一律当 trpc 原始命令字符串。
  --body <hex>    SSO body 的 hex；空格 / 换行 / 逗号 / 冒号随便夹，不加引号也行
                  （会把 --body 之后到下一个 --参数 之间的片段拼起来）。
                  --body - 从标准输入读；--body-file <路径> 从文件读。缺省空 body。
  --sign          带上 SecToken/SecExtra/SecSign（默认【不签名】）。
  --is-uid        按 UIN-form 变体发包（sendOidbPacket 的 isUid=true，信封 reserved=1）。
  --uin <uin>     指定账号（缺省 = login.db 里第一个在线的）。
  --list          只列出 login.db 账号与在线状态，不发包。
  --dry-run       只解析命令字 / body 并打印，不碰进程、不发包。
  --help          看这段。

抓包整帧可以直接贴：脚本会自动剥掉开头的 4 字节长度前缀，以及外层 OIDB 信封
（命令 / 子命令 / reserved 对不上会警告），只把内层 body 交给 native —— native
自己会组信封，贴整帧不会双重包装。`;

if (argv.length === 0 || has('--help') || has('-h')) {
  console.log(HELP);
  process.exit(0);
}

// ─────────────────────────── 命令字 ───────────────────────────

interface OidbCommand {
  kind: 'oidb';
  command: number;
  subCommand: number;
}

interface RawCommand {
  kind: 'raw';
  cmd: string;
}

type ParsedCommand = OidbCommand | RawCommand;

/** `0xe07_0` / `OidbSvc.0xe07_0` / `OidbSvcTrpcTcp.0xe07_0`。 */
const OIDB_WITH_PREFIX = /^(?:oidbsvc(?:trpctcp)?\.)?0x([0-9a-f]{1,8})(?:_(\d{1,10}))?$/i;
/** 丢了 `0x` 前缀的写法：`9067_202` / `9067`。 */
const OIDB_BARE = /^([0-9]{1,5})(?:_([0-9]{1,10}))?$/;

function parseCommand(raw: string): ParsedCommand {
  const text = raw.trim();
  const prefixed = OIDB_WITH_PREFIX.exec(text);
  if (prefixed) {
    return {
      kind: 'oidb',
      command: Number.parseInt(prefixed[1]!, 16),
      subCommand: prefixed[2] ? Number(prefixed[2]) : 0,
    };
  }
  const bare = OIDB_BARE.exec(text);
  if (bare) {
    warn(
      `--cmd ${text} 没有 0x 前缀，按 hex 的 OIDB 命令解析（本意若不是 OIDB，请改用完整命令串）`,
    );
    return {
      kind: 'oidb',
      command: Number.parseInt(bare[1]!, 16),
      subCommand: bare[2] ? Number(bare[2]) : 0,
    };
  }
  return { kind: 'raw', cmd: text };
}

const hex16 = (value: number): string => value.toString(16);

function describeCommand(cmd: ParsedCommand): string {
  if (cmd.kind === 'raw') return `trpc「${cmd.cmd}」（sendPacket，不套 OIDB 信封）`;
  const sub = cmd.subCommand;
  return (
    `OIDB 命令 0x${hex16(cmd.command)}_${sub}（native 拼成 ` +
    `OidbSvcTrpcTcp.0x${hex16(cmd.command)}_${sub}）`
  );
}

// ─────────────────────────── body 解析 ───────────────────────────

/**
 * 去掉 hex 里常见的分隔/装饰：空白、逗号、冒号、分号、竖线、下划线、连字符、
 * 以及每个字节前的 `0x`。留着它们只是为了好贴。
 */
function parseHex(raw: string, what: string): Buffer {
  const cleaned = raw.replace(/0[xX]/g, '').replace(/[\s,;:_|-]+/g, '');
  if (cleaned.length === 0) return Buffer.alloc(0);
  const bad = /[^0-9a-fA-F]/.exec(cleaned);
  if (bad) fail(`${what} 不是合法 hex（非法字符 ${JSON.stringify(bad[0])}）`);
  if (cleaned.length % 2 !== 0)
    fail(`${what} 的 hex 是奇数长度（${cleaned.length}），少了半个字节`);
  return Buffer.from(cleaned, 'hex');
}

/** `--body` 后面直到下一个 `--参数` 的所有片段（不加引号也能贴）。 */
function bodyTokens(): string[] | undefined {
  const start = argv.lastIndexOf('--body');
  if (start < 0) return undefined;
  const tokens: string[] = [];
  for (let i = start + 1; i < argv.length; i++) {
    const token = argv[i]!;
    if (token.startsWith('--')) break;
    tokens.push(token);
  }
  return tokens;
}

function readBody(): Buffer {
  const file = opt('--body-file');
  if (file !== undefined) return parseHex(readFileSync(file, 'utf8'), `--body-file ${file}`);
  const tokens = bodyTokens();
  if (tokens === undefined) return Buffer.alloc(0);
  const joined = tokens.join('');
  if (joined === '-') return parseHex(readFileSync(0, 'utf8'), '标准输入里的 body');
  return parseHex(joined, '--body');
}

// ── 极简 protobuf 读取器（只够读 OIDB 信封）───────────────────

class ProtoReader {
  private offset = 0;

  constructor(private readonly buf: Buffer) {}

  get done(): boolean {
    return this.offset >= this.buf.length;
  }

  varint(): number | null {
    let value = 0;
    let scale = 1;
    for (let i = 0; i < 10; i++) {
      if (this.offset >= this.buf.length) return null;
      const byte = this.buf[this.offset++]!;
      value += (byte & 0x7f) * scale;
      if ((byte & 0x80) === 0) return value;
      scale *= 128;
    }
    return null;
  }

  bytes(length: number): Buffer | null {
    if (length < 0 || this.offset + length > this.buf.length) return null;
    const slice = this.buf.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }

  /** 读一个字段头：字段号 + wire type。 */
  tag(): { field: number; wire: number } | null {
    const key = this.varint();
    if (key === null) return null;
    return { field: Math.floor(key / 8), wire: key % 8 };
  }
}

interface OidbEnvelope {
  command: number;
  subCommand: number;
  /** 信封字段 3 = reserved（`isUid=true` 时 native 写 1）。 */
  reserved?: number;
  body: Buffer;
  /** 信封里除 1/2/3/4 之外的字段（native 组包时不会带上的那些）。 */
  extras: string[];
}

/** 把信封里“多余”的字段描述成人看得懂的短句（可打印就显示文本，否则给 hex）。 */
function describeExtra(field: number, payload: Buffer): string {
  const printable = payload.length > 0 && [...payload].every((b) => b >= 0x20 && b < 0x7f);
  if (printable) return `字段 ${field} = ${JSON.stringify(payload.toString('latin1'))}`;
  return payload.length > 0
    ? `字段 ${field} (${payload.length} 字节 = ${payload.toString('hex')})`
    : `字段 ${field}`;
}

/**
 * 试着把一段字节读成 OIDB 信封：`08 <cmd> 10 <sub> [18 <reserved>] 22 <len> <body> ...`。
 * 读不出来（字段顺序 / wire type 不对）返回 `null`。
 */
function parseOidbEnvelope(buf: Buffer): OidbEnvelope | null {
  const reader = new ProtoReader(buf);
  const first = reader.tag();
  if (first?.field !== 1 || first.wire !== 0) return null;
  const command = reader.varint();
  if (command === null) return null;
  const second = reader.tag();
  if (second?.field !== 2 || second.wire !== 0) return null;
  const subCommand = reader.varint();
  if (subCommand === null) return null;

  let reserved: number | undefined;
  let body: Buffer | null = null;
  const extras: string[] = [];
  let guard = 0;
  while (!reader.done) {
    if (guard++ > 64) return null;
    const tag = reader.tag();
    if (!tag) return null;
    if (tag.field === 3 && tag.wire === 0) {
      const value = reader.varint();
      if (value === null) return null;
      reserved = value;
      continue;
    }
    if (tag.field === 4 && tag.wire === 2 && body === null) {
      const length = reader.varint();
      if (length === null) return null;
      const slice = reader.bytes(length);
      if (!slice) return null;
      body = slice;
      continue;
    }
    // 其它字段：按 wire type 跳过去，顺手记下来（这些是 native 组包时不会带上的）。
    if (tag.wire === 0) {
      const value = reader.varint();
      if (value === null) return null;
      extras.push(`字段 ${tag.field} (varint) = ${value}`);
    } else if (tag.wire === 2) {
      const length = reader.varint();
      if (length === null) return null;
      const payload = reader.bytes(length);
      if (!payload) return null;
      extras.push(describeExtra(tag.field, payload));
    } else if (tag.wire === 1) {
      if (reader.bytes(8) === null) return null;
      extras.push(`字段 ${tag.field} (fixed64)`);
    } else if (tag.wire === 5) {
      if (reader.bytes(4) === null) return null;
      extras.push(`字段 ${tag.field} (fixed32)`);
    } else {
      return null;
    }
  }
  if (!body) return null;
  return { command, subCommand, ...(reserved !== undefined ? { reserved } : {}), body, extras };
}

interface BodyPlan {
  /** 真正交给 native 的内层 body（native 自己组 OIDB 信封）。 */
  body: Buffer;
  notes: string[];
  warnings: string[];
}

/**
 * 把用户贴的 hex 归一成 native 要的内层 body：
 *   ① 贴的是抓包整帧时，剥掉开头 4 字节大端长度前缀；
 *   ② 剥掉与 `--cmd` 对得上的外层 OIDB 信封。
 * 对不上的（比如内层 body 恰好也以 0x08 开头）就原样发送，只记一条说明。
 */
function planBody(input: Buffer, cmd: ParsedCommand, isUid: boolean): BodyPlan {
  const notes: string[] = [];
  const warnings: string[] = [];
  let buf = input;

  if (buf.length >= 4) {
    const prefix = buf.readUInt32BE(0);
    if (prefix === buf.length || prefix === buf.length - 4) {
      notes.push(
        `剥掉开头 4 字节大端长度前缀（0x${hex16(prefix)} = ${prefix}），剩 ${buf.length - 4} 字节`,
      );
      buf = buf.subarray(4);
    }
  }

  if (cmd.kind === 'raw') {
    notes.push('trpc 原始命令：body 原样发送，不套也不剥 OIDB 信封');
    return { body: buf, notes, warnings };
  }

  const envelope = parseOidbEnvelope(buf);
  if (envelope && envelope.command === cmd.command && envelope.subCommand === cmd.subCommand) {
    notes.push(
      `剥掉 OIDB 信封（命令 0x${hex16(envelope.command)}_${envelope.subCommand}），` +
        `内层 body ${envelope.body.length} 字节`,
    );
    if (envelope.reserved !== undefined) {
      const matches = (envelope.reserved === 1) === isUid;
      notes.push(
        `信封 reserved=${envelope.reserved}（本次 isUid=${isUid}${matches ? '，一致' : '，不一致'}）`,
      );
      if (!matches) {
        warnings.push(
          `信封的 reserved=${envelope.reserved} 与 isUid=${isUid} 对不上：native 会写 ` +
            `reserved=${isUid ? 1 : 0}。要按抓包原样发就${isUid ? '去掉' : '加上'} --is-uid。`,
        );
      }
    }
    for (const extra of envelope.extras) {
      warnings.push(
        `信封里还有 native 组包不会带上的 ${extra} —— 重放会丢掉它，服务端若校验平台/版本字段就会失败`,
      );
    }
    return { body: envelope.body, notes, warnings };
  }

  if (envelope && envelope.command >= 0x100) {
    warnings.push(
      `这段字节看着是 OIDB 信封，但读出来是 0x${hex16(envelope.command)}_${envelope.subCommand}，` +
        `跟 --cmd 的 0x${hex16(cmd.command)}_${cmd.subCommand} 不一致 —— 仍按内层 body 原样发送；` +
        '若你是在重放另一条命令的抓包，先把 --cmd 改对',
    );
  } else {
    notes.push('没识别出 OIDB 信封，按内层 body 原样发送');
  }
  return { body: buf, notes, warnings };
}

// ─────────────────────────── 目标账号 / 平台 ───────────────────────────

/** OIDB 里平台配置的落点：win32 / darwin / linux 各自一套路径规则。 */
function createPlatform(
  native: ReturnType<typeof loadNative>,
  getUidForUin: (uin: string) => string | null,
): Platform {
  if (process.platform === 'linux') return createLinuxPlatform(native, () => null, getUidForUin);
  if (process.platform === 'darwin') return createDarwinPlatform(native, () => null, getUidForUin);
  // win32 的账号目录直接用 uin，不需要 uid；第三个参数是 tencent:// 协议处理程序路径。
  return createWin32Platform(
    native,
    () => null,
    () => null,
  );
}

interface OnlineTarget {
  uin: string;
  uid: string;
  pid: number;
  nick?: string;
}

/**
 * 探测 pid + 第一个登录的 uin：`login.db` 给账号表（uin / uid / 昵称），
 * 每个账号再按 `nt_msg.db` 的写锁反查 pid，返回第一个真正在线的。
 *
 * linux / macOS 的账号目录 = `nt_qq_<md5(md5(uid) + "nt_kernel")>`，而 `Platform` 接口按 uin
 * 取路径 —— 所以 `uidByUin` 必须在查 pid 之前先填好（它就是 platform 的 uid 解析器）。
 */
async function pickTarget(
  platform: Platform,
  uidByUin: Map<string, string>,
  wantedUin?: string,
  allowNone = false,
): Promise<OnlineTarget | null> {
  const accounts = await readLoginAccounts(platform);
  if (accounts.length === 0) {
    fail('login.db 里读不出任何账号：确认 QQ 登录过、数据目录没被改过（可先用 --list 看）');
  }
  for (const account of accounts) uidByUin.set(account.uin, account.uid);

  const online: OnlineTarget[] = [];
  log(`login.db 账号 ${accounts.length} 个：`);
  for (const account of accounts) {
    const pid = platform.resolveQqPid(account.uin);
    log(
      `  ${account.uin}${account.userName ? `（${account.userName}）` : ''} ` +
        `uid=${account.uid || '<空>'} → ${pid === null ? '未登录' : `pid=${pid}`}`,
    );
    if (pid === null) continue;
    online.push({
      uin: account.uin,
      uid: account.uid,
      pid,
      ...(account.userName ? { nick: account.userName } : {}),
    });
  }

  const target = wantedUin ? online.find((item) => item.uin === wantedUin) : online[0];
  if (!target) {
    if (allowNone) return null;
    fail(
      wantedUin
        ? `--uin ${wantedUin} 当前不在线（别只看 login.db，要点是 nt_msg.db 被 QQ 持有）`
        : 'login.db 里的账号当前都没登录：先把 QQ 打开并登录',
    );
  }
  if (!target.uid)
    fail(`账号 ${target.uin} 的 uid 是空的（login.db 没解出 uid），没法登记 SSO 会话`);
  return target;
}

// ─────────────────────────── main ───────────────────────────

async function main(): Promise<void> {
  const cmdText = opt('--cmd');
  const list = has('--list');
  if (!cmdText && !list) fail('缺少 --cmd（命令字）。用 --help 看用法。');
  const cmd = cmdText ? parseCommand(cmdText) : null;
  const sign = has('--sign');
  const isUid = has('--is-uid');

  let plan: BodyPlan | null = null;
  if (cmd) {
    log(`平台 ${process.platform}/${process.arch}`);
    log(`命令字 ${describeCommand(cmd)}`);
    log(`签名 ${sign ? '开（--sign）' : '关（默认不签名）'}；isUid=${isUid}`);
    plan = planBody(readBody(), cmd, isUid);
    for (const note of plan.notes) log(`body: ${note}`);
    for (const warning of plan.warnings) warn(warning);
    log(`交给 native 的内层 body（${plan.body.length} 字节）:`);
    console.log(plan.body.toString('hex'));
  } else {
    log(`平台 ${process.platform}/${process.arch}`);
  }

  if (has('--dry-run') && plan) {
    log('--dry-run：解析完就停，没碰进程、也没发包');
    return;
  }

  const native = loadNative();
  const nt = native.ntHelper;
  // 账号表读出来之前还不知道 uid，所以 uid 解析器是个先空后填的 map。
  const uidByUin = new Map<string, string>();
  const platform = createPlatform(native, (uin) => uidByUin.get(uin) ?? null);
  const target = await pickTarget(platform, uidByUin, opt('--uin'), list);
  if (list) {
    log(target ? '--list：只列账号，不发包' : '--list：没有在线账号，到此为止');
    return;
  }
  if (!target || !cmd || !plan) fail('内部错误：命令字 / body / 目标账号缺一，没法发包');
  log(`目标账号：uin=${target.uin} uid=${target.uid} pid=${target.pid}`);

  // ② 扫描内存，取本场会话的发包凭据（a2 / d2 / d2key）。
  const material = await ensureAttached(nt, target.pid, target.uin, { label: LABEL });

  // ③ 扫描需要的数据：设备 guid（离线）+ 当前 QQ 构建的 appid（subAppId）。
  const guid = resolveDeviceGuid(nt, platform);
  if (!guid) fail('读不到设备 guid（QQ 数据根不可用），没法登记 SSO 会话');
  const subAppId = resolveSubAppId(nt, platform, target.pid);
  log(`设备 guid=${guid}   subAppId=${subAppId}`);
  log(`wrapper.node = ${platform.qqWrapperNodePath(target.pid) ?? '<没有找到；--sign 会失败>'}`);
  log(`major.node  = ${platform.qqMajorNodePath(target.pid) ?? '<没有找到>'}`);

  // ④ 登记 SSO 会话（只登记，不建连；TCP 等第一包才连）。
  const registered = await registerSsoSession(
    nt,
    platform,
    target.pid,
    { uin: target.uin, uid: target.uid, guid, subAppId },
    material,
  );
  if (!registered) fail('会话物料不齐（缺 a2 / d2 / d2key），没登记上 SSO 会话');
  log('SSO 会话已登记');

  // ⑤ 发包。
  const startedAt = Date.now();
  const reply =
    cmd.kind === 'oidb'
      ? await nt.sendOidbPacket(target.pid, cmd.command, cmd.subCommand, plan.body, isUid, sign)
      : await nt.sendPacket(target.pid, cmd.cmd, plan.body, sign);
  const elapsed = Date.now() - startedAt;

  log(`已发包（${elapsed}ms），回包 ${reply.length} 字节`);
  if (reply.length === 0) warn('回包是空的：服务端多半静默拒绝了（命令 / 身份 / 参数不认）');
  log('回包 hex:');
  console.log(reply.toString('hex'));
}

main().catch((error: unknown) => {
  console.error(`[${LABEL}] 失败:`, error instanceof Error ? error.message : error);
  process.exit(1);
});
