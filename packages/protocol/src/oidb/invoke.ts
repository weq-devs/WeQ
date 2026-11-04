/**
 * OIDB / trpc call dispatch.
 *
 * Each command is modelled as a self-contained "spec" (a namespace whose
 * exports structurally match {@link OidbSpec} / {@link TrpcSpec}). The spec
 * owns its wire schemas + the (de)serialize transforms; these dispatchers do
 * the mechanical encode → send → decode → deserialize.
 *
 * The OIDB envelope (command/subCommand wrapping + error_code check) is handled
 * natively in `sendOidbPacket`, so a spec only describes the INNER request /
 * response body — no `OidbBase` schema needed on the TS side.
 */

import { decode, encode, type ProtoMessage } from '../protobuf';
import { sendOidb, sendPacket, type OidbNative, type TrpcNative } from '../transport';

/** A single OIDB command. */
export interface OidbSpec<TParams, TResult> {
  command: number;
  subCommand?: number;
  /**
   * 该命令是否需要签名（`SecSign/SecToken/SecExtra`）——**必填**。
   *
   * 取值来自真机抓包：用注入的 QQ 发该命令，看 QQ 自己在 SSO reserved 里写不写
   * tag 24（`SecInfo`）。2026-11-05 用 `scripts/probe-sign.ts` 对 WeQ 在用的 103 条
   * OIDB 命令复测（每条三次取一致结果），会签的有 13 条：`0x6d9_4`、`0x89a_0/15`、
   * `0x102a_0/1`、`0x10c8_1/2`、`0x112a_2`、`0x112e_1`、`0x11ec_1`、`0x9082_1/2`、
   * `0x93d7_1`。
   *
   * 不再有「按名单推导」的兜底：旧实现照抄 LagrangeV2 的 `WhiteListCommand`，
   * 与 PC 端实测不符（15 个只读命令被误判成要签），已随白名单一起移除。
   * 白名单**不能**当依据：`0x9082_1/2`、`0x6d9_4` 在名单外但 QQ 会签，
   * `0x5d6_6/19`、`0x8fc_3`、`0xa80_1`、`0x10c0_1/2` 在名单里但 QQ 不签。
   */
  needSign: boolean;
  /**
   * 从参数动态解析 sub-command（0x9082：1 = 贴表情，2 = 撤回）。优先于
   * {@link subCommand}。
   */
  resolveSubCommand?: (params: TParams) => number;
  uinForm?: boolean;
  reqSchema: ProtoMessage;
  respSchema: ProtoMessage;
  /** 同一字段有多种已确认 wire 形态时，由具体协议合并解码。 */
  decodeResponseBody?: (bytes: Uint8Array) => Record<string, unknown>;
  serialize(params: TParams): Record<string, unknown>;
  deserialize(body: Record<string, unknown>): TResult;
}

export async function invokeOidb<TParams, TResult>(
  nt: OidbNative,
  pid: number,
  spec: OidbSpec<TParams, TResult>,
  params: TParams,
): Promise<TResult> {
  const subCommand = spec.resolveSubCommand ? spec.resolveSubCommand(params) : spec.subCommand;
  if (subCommand === undefined) {
    throw new Error(
      `OIDB spec 0x${spec.command.toString(16)} 既没有 subCommand 也没有 resolveSubCommand`,
    );
  }
  const reqBytes = encode(spec.reqSchema, spec.serialize(params));
  const respBytes = await sendOidb(
    nt,
    pid,
    {
      command: spec.command,
      subCommand,
      body: reqBytes,
      isUid: spec.uinForm ?? false,
    },
    spec.needSign,
  );
  return spec.deserialize(
    spec.decodeResponseBody
      ? spec.decodeResponseBody(respBytes)
      : decode(spec.respSchema, respBytes),
  );
}

/** A trpc service reached via a raw SSO command string (no OIDB envelope). */
export interface TrpcSpec<TParams, TResult> {
  cmd: string;
  /** 同 {@link OidbSpec.needSign}：必填，取值来自真机抓包。 */
  needSign: boolean;
  reqSchema: ProtoMessage;
  respSchema: ProtoMessage;
  serialize(params: TParams): Record<string, unknown>;
  /**
   * 自定义请求体编码。用于运行时的 schema 表达不了的 wire 形态（例如 fixed32 字段）。
   * 提供了就跳过 `encode(reqSchema, serialize(params))`。
   */
  encodeRequest?(params: TParams): Uint8Array;
  deserialize(body: Record<string, unknown>): TResult;
  /**
   * 直接用原始回包字节解析，跳过 schema。字段含 fixed32 这类运行时表达不了的
   * wire 形态时用（schema 解码会把这类字段整段跳过，结果看起来「字段是空的」）。
   */
  decodeResponse?(bytes: Uint8Array): TResult;
}

export async function invokeTrpc<TParams, TResult>(
  nt: TrpcNative,
  pid: number,
  spec: TrpcSpec<TParams, TResult>,
  params: TParams,
): Promise<TResult> {
  const reqBytes = spec.encodeRequest
    ? spec.encodeRequest(params)
    : encode(spec.reqSchema, spec.serialize(params));
  const respBytes = await sendPacket(nt, pid, spec.cmd, reqBytes, spec.needSign);
  if (spec.decodeResponse) return spec.decodeResponse(respBytes);
  return spec.deserialize(decode(spec.respSchema, respBytes));
}
