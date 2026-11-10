/**
 * Packet transport — sends protobuf-encoded request bodies over the native SSO
 * connection and returns the raw reply body.
 *
 * Two flavours, mirroring the two native entry points:
 *   - {@link sendOidb}   wraps the body in an OIDB envelope (command/subCommand).
 *   - {@link sendPacket} sends a raw SSO packet under an explicit command string
 *     (used for trpc services like the qun album media list).
 *
 * 两条路都只有 `(nt, pid, …)`：原生侧按 pid 找已登记的**会话物料**（由
 * `AccountMonitorService` 在 attach 后交给 `setSsoSession`），首次发包时才懒建连。
 * 也就是**借同机 QQ 的凭据直接发包** —— 不重跑登录，也不自己上线（在线状态与心跳由
 * QQ 本体维持）。所以所有调用方都拿得到 pid（它就是「哪个在线账号」），这里不需要把
 * 会话物料在整条协议栈里透传。
 *
 * **签名策略不在这里判断**：needSign / mode 全部来自 {@link resolveSign} 的中央表
 * （`sign-policy.ts`），按 wire 命令查。调用方默认什么都不用传；只有调试脚本之类
 * 需要强制覆盖时才用 `override`。
 *
 * Both take just the slice of the native binding they need, so callers can pass
 * a stub in tests.
 */

import type { NtHelperBinding } from '@weq/native';
import { signRedBagRequest as signRedBagRequestTs } from './redbag/sign';
import { oidbCommand, resolveSign, type ResolvedSign } from './sign-policy';

/** The native methods this layer uses. */
export type PacketNative = Pick<NtHelperBinding, 'sendOidbPacket' | 'sendPacket'>;
/** Narrow type — only the OIDB sender. */
export type OidbNative = Pick<NtHelperBinding, 'sendOidbPacket'>;
/** Narrow type — only the raw-packet sender. */
export type TrpcNative = Pick<NtHelperBinding, 'sendPacket'>;
/** Narrow type — only the red bag request signer. */
export type RedBagSignNative = Pick<NtHelperBinding, 'signRedBagRequest'>;

export interface OidbRequest {
  /** OIDB command, e.g. 0x9067. */
  command: number;
  /** OIDB sub-command, e.g. 202. */
  subCommand: number;
  /** Protobuf-encoded request body. */
  body: Uint8Array;
  /** Use the UIN-form variant (reserved=1). Defaults to false. */
  isUid?: boolean;
}

/**
 * 按命令查表得到要传给 native 的签名参数。
 *
 * `override` 只给调试开关用（`scripts/sso_send.ts` 的 `--sign` / `--no-sign`）；
 * 业务代码一律不要传，否则会把中央表绕过。
 */
function signArgs(cmd: string, override?: Partial<ResolvedSign>): ResolvedSign {
  return override ? { ...resolveSign(cmd), ...override } : resolveSign(cmd);
}

/**
 * Send an OIDB request and return the decoded inner reply body.
 *
 * 签名策略按 `OidbSvcTrpcTcp.0x<command>_<subCommand>` 查中央表。
 */
export async function sendOidb(
  nt: OidbNative,
  pid: number,
  req: OidbRequest,
  override?: Partial<ResolvedSign>,
): Promise<Uint8Array> {
  const { needSign, mode } = signArgs(oidbCommand(req.command, req.subCommand), override);
  const reply = await nt.sendOidbPacket(
    pid,
    req.command,
    req.subCommand,
    Buffer.from(req.body),
    req.isUid ?? false,
    needSign,
    mode,
  );
  return new Uint8Array(reply);
}

/**
 * Send a raw SSO packet under `cmd` (e.g. a trpc service name) and return the
 * raw reply body.
 *
 * 签名策略按 `cmd` 原样查中央表。
 */
export async function sendPacket(
  nt: TrpcNative,
  pid: number,
  cmd: string,
  body: Uint8Array,
  override?: Partial<ResolvedSign>,
): Promise<Uint8Array> {
  const { needSign, mode } = signArgs(cmd, override);
  const reply = await nt.sendPacket(pid, cmd, Buffer.from(body), needSign, mode);
  return new Uint8Array(reply);
}

/**
 * Sign a red bag pre-pack request (`hb_pc_pre_pack`) and return the 16-byte
 * plaintext `f101`.
 *
 * The signature algorithm deliberately lives in the native addon only — this
 * package just hands over `signInput` (the `sender` ‖ `pack` sub-message bytes)
 * and gets the value back.
 */
export function signRedBagRequest(nt: RedBagSignNative, signInput: Uint8Array): Uint8Array {
  // 原生导出优先（2026-09-30 才加进 nt_helper：`feat(sign): QQ钱包签名算法`），
  // 而仓库 pin 的构建可能还没有它 —— 那种情况下退到 TS 侧同一算法的实现
  // （`./redbag/sign`，固定向量与原生逐字节一致）。
  if (typeof nt?.signRedBagRequest === 'function') {
    return new Uint8Array(nt.signRedBagRequest(Buffer.from(signInput)));
  }
  return signRedBagRequestTs(signInput);
}
