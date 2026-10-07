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
   * 该命令是否需要签名（`SecSign/SecToken/SecExtra`）。不写时按**抓包为准**
   * 逐个标注；缺省 `true` 是保守默认（未知命令宁可带上）。
   */
  needSign?: boolean;
  /**
   * 从参数动态解析 sub-command（0x9082：1 = 贴表情，2 = 撤回）。优先于
   * {@link subCommand}。
   */
  resolveSubCommand?: (params: TParams) => number;
  uinForm?: boolean;
  reqSchema: ProtoMessage;
  respSchema: ProtoMessage;
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
  // 分发看不到静态命令，无法自行判定；由 spec 按抓包标注，缺省保守为 true。
  const respBytes = await sendOidb(
    nt,
    pid,
    {
      command: spec.command,
      subCommand,
      body: reqBytes,
      isUid: spec.uinForm ?? false,
    },
    spec.needSign ?? true,
  );
  return spec.deserialize(decode(spec.respSchema, respBytes));
}

/** A trpc service reached via a raw SSO command string (no OIDB envelope). */
export interface TrpcSpec<TParams, TResult> {
  cmd: string;
  /** 同 {@link OidbSpec.needSign}；缺省 `true`。 */
  needSign?: boolean;
  reqSchema: ProtoMessage;
  respSchema: ProtoMessage;
  serialize(params: TParams): Record<string, unknown>;
  deserialize(body: Record<string, unknown>): TResult;
}

export async function invokeTrpc<TParams, TResult>(
  nt: TrpcNative,
  pid: number,
  spec: TrpcSpec<TParams, TResult>,
  params: TParams,
): Promise<TResult> {
  const reqBytes = encode(spec.reqSchema, spec.serialize(params));
  // 同 invokeOidb：分发看不到静态命令，由 spec 标注，缺省保守为 true。
  const respBytes = await sendPacket(nt, pid, spec.cmd, reqBytes, spec.needSign ?? true);
  return spec.deserialize(decode(spec.respSchema, respBytes));
}
