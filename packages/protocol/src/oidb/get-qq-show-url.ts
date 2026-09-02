// 0xFE1_3 — fetch a user's QQ 秀 (QQ Show) URL.
//
// Same command family as GetUserQqLevel (0xFE1_2), sub-command 3. Only
// requests number-property key 47233 (QQ 秀); the reply nests the url at
// body → 1 → 2 → 2 → 2, and the property is absent (empty) when the user
// has no QQ 秀.
//
// `uinForm` is set (envelope reserved=1) so the server takes the UIN-form
// validation path, same as 0xFE1_2.

import { message } from '../protobuf';
import { toInt } from './shared';
import { invokeOidb, type OidbSpec } from './invoke';
import type { OidbNative } from '../transport';

/** QQ 秀 — OIDB 0xFE1_3 number-property key 47233. */
const QQ_SHOW_KEY = 47233;

const QQ_SHOW_KEY_FIELD = message([{ name: 'key', tag: 1, type: 'uint32' }]);

const QQ_SHOW_REQ = message([
  { name: 'uin', tag: 1, type: 'uint32' },
  { name: 'keys', tag: 3, type: QQ_SHOW_KEY_FIELD, repeated: true },
  { name: 'version', tag: 5, type: 'string', force: true },
]);

const QQ_SHOW_ENTRY = message([
  { name: 'key', tag: 1, type: 'uint32' },
  { name: 'url', tag: 2, type: 'string' },
]);

/** The 65-byte wrapper — only field 2 (the entry) carries data. */
const QQ_SHOW_DATA = message([{ name: 'entry', tag: 2, type: QQ_SHOW_ENTRY }]);

const QQ_SHOW_PROFILE = message([
  { name: 'uin', tag: 1, type: 'uint32' },
  { name: 'show', tag: 2, type: QQ_SHOW_DATA },
]);

const QQ_SHOW_RESP = message([{ name: 'profile', tag: 1, type: QQ_SHOW_PROFILE }]);

export interface QqShowInfo {
  uin: number;
  /** 是否有 QQ 秀;未命中时 false。 */
  hasShow: boolean;
  /** QQ 秀图片 URL,未命中时为空字符串。 */
  url: string;
}

export namespace GetQqShowUrl {
  export const command = 0xfe1;
  export const subCommand = 3;
  export const uinForm = true;
  export const reqSchema = QQ_SHOW_REQ;
  export const respSchema = QQ_SHOW_RESP;

  export interface Params {
    uin: number;
  }

  export const serialize = (p: Params): Record<string, unknown> => ({
    uin: p.uin,
    keys: [{ key: QQ_SHOW_KEY }],
    version: '',
  });

  export const deserialize = (body: Record<string, unknown>): QqShowInfo => {
    const profile = body.profile as Record<string, unknown> | undefined;
    if (!profile) throw new Error('qq show response body missing');

    // No-show replies put an empty message here (decodes to {}); with a show
    // the entry carries key 47233 + the image url.
    const entry = (profile.show as Record<string, unknown> | undefined)?.entry as
      | Record<string, unknown>
      | undefined;
    const key = toInt(entry?.key);
    const url = key === QQ_SHOW_KEY ? ((entry?.url as string | undefined) ?? '') : '';
    return { uin: toInt(profile.uin), hasShow: url !== '', url };
  };

  export const invoke = (nt: OidbNative, pid: number, params: Params): Promise<QqShowInfo> =>
    invokeOidb(nt, pid, GetQqShowUrl as OidbSpec<Params, QqShowInfo>, params);
}
