/**
 * 群精华消息查询 — `qun.qq.com/cgi-bin/group_digest/digest_list`.
 *
 * 返回群精华消息列表，包含消息序号（跳转关键）、发送者、设置者、消息内容等。
 */

import { computeBkn, cookieHeader, type WebCredential } from './credential';
import { webRequestJson } from './http';

export interface GroupEssenceContent {
  msg_type: number;
  text?: string;
  face_index?: number;
  image_url?: string;
  file_name?: string;
  file_bus_id?: number | string;
  file_id?: string;
  file_thumbnail_url?: string;
  file_size?: number | string;
}

export interface GroupEssenceMessage {
  group_code: string;
  msg_seq: number;
  msg_random: number;
  sender_uin: string;
  sender_nick: string;
  sender_time: number;
  add_digest_uin: string;
  add_digest_nick: string;
  add_digest_time: number;
  msg_content: GroupEssenceContent[];
  can_be_removed: boolean;
}

interface RawGroupEssenceRet {
  retcode: number;
  retmsg?: string;
  data?: {
    is_end?: boolean;
    msg_list?: Array<GroupEssenceMessage | null> | null;
    group_role?: number;
    config_page_url?: string;
  } | null;
}

/**
 * 分页获取群精华消息。
 * @param cred Web credential (skey/pskey)
 * @param groupCode 群号
 * @param pageStart 页码（从 0 开始）
 * @param pageLimit 每页条数（默认 50）
 */
export async function getGroupEssence(
  cred: WebCredential,
  groupCode: string,
  pageStart = 0,
  pageLimit = 50,
): Promise<GroupEssenceMessage[]> {
  const bkn = computeBkn(cred.skey);

  const url = `https://qun.qq.com/cgi-bin/group_digest/digest_list?${new URLSearchParams({
    bkn: String(bkn),
    page_start: String(pageStart),
    page_limit: String(pageLimit),
    group_code: groupCode,
  }).toString()}`;

  const ret = await webRequestJson<RawGroupEssenceRet>(url, {
    method: 'GET',
    cookie: cookieHeader(cred),
  });

  if (ret.retcode !== 0 || !ret.data) return [];

  // 处理边界情况：is_end=true 但 msg_list 为 null/undefined
  if (ret.data.is_end === true && ret.data.msg_list == null) {
    return [];
  }

  if (!Array.isArray(ret.data.msg_list)) return [];

  // 过滤掉 null 条目
  return ret.data.msg_list.filter((msg): msg is GroupEssenceMessage => msg !== null);
}
