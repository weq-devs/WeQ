import { message } from '../../protobuf';
import { invokeOidb } from '../invoke';
import { requireUid } from '../write-validation';
import type { OidbNative } from '../../transport';

/** 单次批量范围，不是每日额度；每日限制由服务端决定。 */
export const PROFILE_LIKE_MAX_PER_REQUEST = 20;
export const PROFILE_LIKE_SOURCE_ID = 71;

/** 来源：SnowLuma SendLike / acidify SendProfileLike，UID 形态的 0x7e5_104。 */
export namespace SendProfileLike {
  export const command = 0x7e5;
  export const subCommand = 104;
  export const reqSchema = message([
    { name: 'targetUid', tag: 11, type: 'string' },
    { name: 'sourceId', tag: 12, type: 'uint32' },
    { name: 'count', tag: 13, type: 'uint32' },
  ]);
  export const respSchema = message([]);
  export interface Params {
    targetUid: string;
    count: number;
  }
  export const serialize = ({ targetUid, count }: Params): Record<string, unknown> => {
    requireUid(targetUid);
    if (!Number.isInteger(count) || count < 1 || count > PROFILE_LIKE_MAX_PER_REQUEST)
      throw new Error(`点赞次数须为 1–${PROFILE_LIKE_MAX_PER_REQUEST} 的整数`);
    return { targetUid, sourceId: PROFILE_LIKE_SOURCE_ID, count };
  };
  // 原生已核验 OIDB 外层业务码；非空内层暂未建模，不能据此声称点赞成功。
  export const decodeResponseBody = (bytes: Uint8Array): Record<string, unknown> => ({
    hasBody: bytes.length > 0,
  });
  export const deserialize = (body: Record<string, unknown>): 'accepted' | 'unconfirmed' =>
    body.hasBody === false ? 'accepted' : 'unconfirmed';
  export const invoke = (
    nt: OidbNative,
    pid: number,
    params: Params,
  ): Promise<'accepted' | 'unconfirmed'> => invokeOidb(nt, pid, SendProfileLike, params);
}
