// 0xFE1_2 — fetch a user's QQ level (QQ 等级)。
//
// Only requests property key 105 (QQ level); the server elides the uid
// echo on this UIN-form query path, so the response is parsed for the
// level number-property only (same deserialize path as SnowLuma's
// fetch-user-profile, minus the fields we don't need)。
//
// `uinForm` is set so the server takes the UIN-form validation path;
// without it newer NTQQ versions reject the request with
// `[oidb] one of uid/openid is invaild`.

import { message } from '../protobuf';
import { toInt } from './shared';
import { invokeOidb, type OidbSpec } from './invoke';
import type { OidbNative } from '../transport';

/** QQ 等级 — OIDB 0xFE1_2 number-property key 105. */
const QQ_LEVEL_KEY = 105;

const USER_INFO_KEY = message([{ name: 'key', tag: 1, type: 'uint32' }]);

const USER_INFO_REQ = message([
  { name: 'uin', tag: 1, type: 'uint32' },
  { name: 'keys', tag: 3, type: USER_INFO_KEY, repeated: true },
]);

const TWO_NUMBER = message([
  { name: 'number1', tag: 1, type: 'uint32' },
  { name: 'number2', tag: 2, type: 'uint32' },
]);

const USER_INFO_PROPERTY = message([
  { name: 'numberProperties', tag: 1, type: TWO_NUMBER, repeated: true },
]);

const USER_INFO_RESP = message([
  {
    name: 'body',
    tag: 1,
    type: message([
      { name: 'properties', tag: 2, type: USER_INFO_PROPERTY },
      { name: 'uin', tag: 3, type: 'uint32' },
    ]),
  },
]);

export interface QqLevelInfo {
  uin: number;
  /** QQ 等级,未命中/查询失败时为 0。 */
  level: number;
}

export namespace GetUserQqLevel {
  export const command = 0xfe1;
  export const subCommand = 2;
  export const uinForm = true;
  export const reqSchema = USER_INFO_REQ;
  export const respSchema = USER_INFO_RESP;

  export interface Params {
    uin: number;
  }

  export const serialize = (p: Params): Record<string, unknown> => ({
    uin: p.uin,
    keys: [{ key: QQ_LEVEL_KEY }],
  });

  /** The server sometimes elides its uin echo, so callers pass the requested
   *  uin as a fallback; `invoke` binds it via a per-call spec override. */
  export const deserializeWithFallback = (
    body: Record<string, unknown>,
    requestedUin: number,
  ): QqLevelInfo => {
    const respBody = body.body as Record<string, unknown> | undefined;
    if (!respBody) throw new Error('user info response body missing');

    let level = 0;
    const props = respBody.properties as Record<string, unknown> | undefined;
    for (const np of (props?.numberProperties as Record<string, unknown>[] | undefined) ?? []) {
      if (toInt(np.number1) === QQ_LEVEL_KEY) level = toInt(np.number2);
    }
    return { uin: toInt(respBody.uin) || requestedUin, level };
  };

  export const deserialize = (body: Record<string, unknown>): QqLevelInfo =>
    deserializeWithFallback(body, 0);

  export const invoke = (nt: OidbNative, pid: number, params: Params): Promise<QqLevelInfo> =>
    invokeOidb(
      nt,
      pid,
      {
        ...GetUserQqLevel,
        deserialize: (body: Record<string, unknown>) => deserializeWithFallback(body, params.uin),
      } as OidbSpec<Params, QqLevelInfo>,
      params,
    );
}
