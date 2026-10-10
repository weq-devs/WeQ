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
 * QQ 本体维持）。所有调用方都拿得到 pid（它就是「哪个在线账号」），所以这里不需要把
 * 会话物料在整条协议栈里透传。
 *
 * Both take just the slice of the native binding they need, so callers can pass
 * a stub in tests.
 */

import type { NtHelperBinding } from '@weq/native';
import { signRedBagRequest as signRedBagRequestTs } from './redbag/sign';

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
 * Send an OIDB request and return the decoded inner reply body.
 *
 * `needSign` 由调用方按命令**逐个标注**（不在 native 里硬编码白名单）：`true` 表示
 * 该命令要附带 `SecToken/SecExtra/SecSign`，原生侧用 `wrapper.node` 的签名函数算。
 */
export async function sendOidb(
  nt: OidbNative,
  pid: number,
  req: OidbRequest,
  needSign: boolean,
): Promise<Uint8Array> {
  const reply = await nt.sendOidbPacket(
    pid,
    req.command,
    req.subCommand,
    Buffer.from(req.body),
    req.isUid ?? false,
    needSign,
  );
  return new Uint8Array(reply);
}

/**
 * Send a raw SSO packet under `cmd` (e.g. a trpc service name) and return the
 * raw reply body.
 *
 * `needSign` 同 {@link sendOidb}，按命令逐个标注。
 */
export async function sendPacket(
  nt: TrpcNative,
  pid: number,
  cmd: string,
  body: Uint8Array,
  needSign: boolean,
): Promise<Uint8Array> {
  const reply = await nt.sendPacket(pid, cmd, Buffer.from(body), needSign);
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
