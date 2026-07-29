// 0xFE1_2 — fetch a user's profile (nickname / qid / sex / age / sign
// / avatar / QQ level).
//
// `uinForm` is set so the server takes the UIN-form validation path;
// without it newer NTQQ versions reject the request with
// `[oidb] one of uid/openid is invaild`.
//
// Property key catalogue:
//   101   — avatar info (proto-encoded AvatarInfo)
//   102   — sign (signature)
//   103   — remark
//   105   — QQ level (numeric)
//   20002 — nickname
//   20009 — gender (1 male / 2 female / 255 unknown)
//   20037 — age
//   27394 — QID

import { decode, message } from '../protobuf';
import { toInt } from './shared';
import { invokeOidb, type OidbSpec } from './invoke';
import type { OidbNative } from '../transport';

const REQUESTED_KEYS = [
  20002, 27394, 20009, 20031, 101, 103, 102, 20020, 20003, 20026, 105, 27372, 27406, 20037,
];

const USER_INFO_KEY = message([{ name: 'key', tag: 1, type: 'uint32' }]);

const USER_INFO_REQ = message([
  { name: 'uin', tag: 1, type: 'uint32' },
  { name: 'keys', tag: 3, type: USER_INFO_KEY, repeated: true },
]);

const TWO_NUMBER = message([
  { name: 'number1', tag: 1, type: 'uint32' },
  { name: 'number2', tag: 2, type: 'uint32' },
]);

const BYTE_PROPERTY = message([
  { name: 'code', tag: 1, type: 'uint32' },
  { name: 'value', tag: 2, type: 'bytes' },
]);

const USER_INFO_PROPERTY = message([
  { name: 'numberProperties', tag: 1, type: TWO_NUMBER, repeated: true },
  { name: 'bytesProperties', tag: 2, type: BYTE_PROPERTY, repeated: true },
]);

const USER_INFO_RESP = message([
  {
    name: 'body',
    tag: 1,
    type: message([
      { name: 'uid', tag: 1, type: 'string' },
      { name: 'properties', tag: 2, type: USER_INFO_PROPERTY },
      { name: 'uin', tag: 3, type: 'uint32' },
    ]),
  },
]);

/** Avatar blob stored under property 101. */
const AVATAR_INFO = message([{ name: 'url', tag: 5, type: 'string' }]);

export interface UserProfileInfo {
  uin: number;
  uid: string;
  nickname: string;
  remark: string;
  qid: string;
  sex: 'male' | 'female' | 'unknown';
  age: number;
  sign: string;
  avatar: string;
  level: number;
}

export namespace FetchUserProfile {
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
    keys: REQUESTED_KEYS.map((k) => ({ key: k })),
  });

  /** The server sometimes elides its uin echo, so callers pass the requested
   *  uin as a fallback; `invoke` binds it via a per-call spec override. */
  export const deserializeWithFallback = (
    body: Record<string, unknown>,
    requestedUin: number,
  ): UserProfileInfo => {
    const respBody = body.body as Record<string, unknown> | undefined;
    if (!respBody) throw new Error('user info response body missing');

    const info: UserProfileInfo = {
      uin: toInt(respBody.uin) || requestedUin,
      uid: (respBody.uid as string) ?? '',
      nickname: '',
      remark: '',
      qid: '',
      sex: 'unknown',
      age: 0,
      sign: '',
      avatar: '',
      level: 0,
    };

    const props = respBody.properties as Record<string, unknown> | undefined;
    if (props) {
      const bytesMap = new Map<number, Uint8Array>();
      const numMap = new Map<number, number>();
      for (const bp of (props.bytesProperties as Record<string, unknown>[] | undefined) ?? []) {
        bytesMap.set(toInt(bp.code), (bp.value as Uint8Array) ?? new Uint8Array(0));
      }
      for (const np of (props.numberProperties as Record<string, unknown>[] | undefined) ?? []) {
        numMap.set(toInt(np.number1), toInt(np.number2));
      }
      const getString = (code: number): string => {
        const b = bytesMap.get(code);
        return b ? Buffer.from(b).toString('utf8') : '';
      };
      info.nickname = getString(20002);
      info.remark = getString(103);
      info.qid = getString(27394);
      info.sign = getString(102);

      const avatarBytes = bytesMap.get(101);
      if (avatarBytes && avatarBytes.length > 0) {
        const url = decode(AVATAR_INFO, avatarBytes).url;
        if (typeof url === 'string' && url) info.avatar = `${url}640`;
      }
      const sexNum = numMap.get(20009) ?? 0;
      info.sex = sexNum === 1 ? 'male' : sexNum === 2 ? 'female' : 'unknown';
      info.age = numMap.get(20037) ?? 0;
      info.level = numMap.get(105) ?? 0;
    }

    return info;
  };

  export const deserialize = (body: Record<string, unknown>): UserProfileInfo =>
    deserializeWithFallback(body, 0);

  export const invoke = (nt: OidbNative, pid: number, params: Params): Promise<UserProfileInfo> =>
    invokeOidb(
      nt,
      pid,
      {
        ...FetchUserProfile,
        deserialize: (body: Record<string, unknown>) => deserializeWithFallback(body, params.uin),
      } as OidbSpec<Params, UserProfileInfo>,
      params,
    );
}
