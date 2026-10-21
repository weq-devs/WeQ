// 点击内联按钮 — 0x112E_1。
//
// 把「某个机器人消息里的按钮被点击」这个事件回传给机器人，让机器人执行对应动作。
// 字段布局对照 SnowLuma `oidb-services/misc/click-inline-keyboard-button.ts`。
//
// 签名：LagrangeV2 白名单里有 `OidbSvcTrpcTcp.0x112e_1` → needSign = true（由
// `invokeOidb` 按白名单推导，无需显式标注）。

import { message } from '../../protobuf';
import { invokeOidb, type OidbSpec } from '../invoke';
import { toInt } from '../shared';
import type { OidbNative } from '../../transport';

const INLINE_BUTTON_REQ = message([
  { name: 'botAppid', tag: 3, type: 'uint64' },
  { name: 'msgSeq', tag: 4, type: 'uint64' },
  { name: 'buttonId', tag: 5, type: 'string' },
  { name: 'callbackData', tag: 6, type: 'string' },
  { name: 'unknown7', tag: 7, type: 'uint32' },
  { name: 'groupId', tag: 8, type: 'uint64' },
  { name: 'unknown9', tag: 9, type: 'uint32' },
]);

const INLINE_BUTTON_RESP = message([
  { name: 'result', tag: 3, type: 'uint32' },
  { name: 'promptText', tag: 4, type: 'string' },
  { name: 'errMsg', tag: 5, type: 'string' },
]);

export interface ClickInlineButtonResult {
  result: number;
  promptText: string;
  errMsg: string;
}

export interface ClickInlineButtonParams {
  groupId: number;
  /** 按钮所属机器人的 appid。 */
  botAppid: number | string;
  /** 按钮 id（机器人消息里的 `buttonId`）。 */
  buttonId: string;
  /** 按钮携带的 callback data；没有就传空串。 */
  callbackData?: string;
  /** 按钮所在消息的 msgSeq。 */
  msgSeq: number | string;
}

function toBigInt(value: number | string, what: string): bigint {
  const n = typeof value === 'bigint' ? value : BigInt(value);
  if (n <= 0n) throw new Error(`${what} 必须是正整数`);
  return n;
}

export namespace ClickInlineKeyboardButton {
  export const command = 0x112e;
  export const subCommand = 1;
  export const reqSchema = INLINE_BUTTON_REQ;
  export const respSchema = INLINE_BUTTON_RESP;

  export type Params = ClickInlineButtonParams;

  export const serialize = (p: Params): Record<string, unknown> => {
    if (!Number.isSafeInteger(p.groupId) || p.groupId <= 0) {
      throw new Error(`groupId 必须是正整数，收到 ${String(p.groupId)}`);
    }
    const buttonId = String(p.buttonId ?? '').trim();
    if (!buttonId) throw new Error('buttonId 不能为空');
    return {
      botAppid: toBigInt(p.botAppid, 'botAppid'),
      msgSeq: toBigInt(p.msgSeq, 'msgSeq'),
      buttonId,
      callbackData: p.callbackData ?? '',
      unknown7: 0,
      groupId: BigInt(p.groupId),
      // 0x112e_1 的固定判别位（抓包确认）。
      unknown9: 1,
    };
  };

  export const deserialize = (body: Record<string, unknown>): ClickInlineButtonResult => ({
    result: toInt(body.result),
    promptText: typeof body.promptText === 'string' ? body.promptText : '',
    errMsg: typeof body.errMsg === 'string' ? body.errMsg : '',
  });

  export const invoke = (
    nt: OidbNative,
    pid: number,
    params: Params,
  ): Promise<ClickInlineButtonResult> =>
    invokeOidb(
      nt,
      pid,
      ClickInlineKeyboardButton as OidbSpec<Params, ClickInlineButtonResult>,
      params,
    );
}
