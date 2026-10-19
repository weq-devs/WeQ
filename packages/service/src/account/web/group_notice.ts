/**
 * 群公告查询 — `web.qun.qq.com/cgi-bin/announce/list_announce`.
 *
 * The cgi wants TWO bkns: the URL carries bkn(p_skey) and the POST body carries
 * bkn(skey). (Naming in the wild is inconsistent; this split is what actually
 * authenticates.) Response is `{ ec, feeds: { <fid>: feed } }`.
 */

import { computeBkn, cookieHeader, type WebCredential } from './credential';
import { WEB_READ_RETRY, webRequestJson, webRequestText } from './http';

export interface GroupNoticeImage {
  id: string;
  width: number;
  height: number;
}

export interface GroupNotice {
  /** Feed id (`fid`) — stable handle for the announcement. */
  noticeId: string;
  /** Publisher uin. */
  senderId: number;
  /** Publish time, unix seconds. */
  publishTime: number;
  text: string;
  images: GroupNoticeImage[];
  /** How many members have read it. */
  readNum: number;
}

interface RawNoticeFeed {
  fid: string;
  u: number;
  pubt: number;
  msg?: { text?: string; pics?: Array<{ id: string; w: number; h: number }> };
  read_num?: number;
}

interface RawNoticeRet {
  ec: number;
  em?: string;
  feeds?: Record<string, RawNoticeFeed>;
}

/**
 * Fetch a group's announcements. `start = -1` is the first page; `count` is the
 * page size. Returns `[]` when the cgi reports an error (expired cookie / no
 * permission) or the group has none.
 */
export async function getGroupNotice(
  cred: WebCredential,
  groupCode: string,
  start = -1,
  count = 20,
): Promise<GroupNotice[]> {
  const urlBkn = computeBkn(cred.pskey || cred.skey);
  const bodyBkn = computeBkn(cred.skey);

  const url = `https://web.qun.qq.com/cgi-bin/announce/list_announce?bkn=${urlBkn}`;
  const body = new URLSearchParams({
    qid: groupCode,
    bkn: String(bodyBkn),
    ft: '23',
    s: String(start),
    n: String(count),
    i: '1',
    ni: '1',
  }).toString();

  const ret = await webRequestJson<RawNoticeRet>(url, {
    method: 'POST',
    cookie: cookieHeader(cred),
    body,
    headers: { Referer: 'https://web.qun.qq.com/mannounce/index.html?_wv=1031&_bid=148' },
    retry: WEB_READ_RETRY,
  });

  if (ret.ec !== 0 || !ret.feeds) return [];

  return Object.values(ret.feeds).map((feed) => ({
    noticeId: feed.fid,
    senderId: feed.u,
    publishTime: feed.pubt,
    text: feed.msg?.text ?? '',
    images: (feed.msg?.pics ?? []).map((p) => ({ id: p.id, width: p.w, height: p.h })),
    readNum: feed.read_num ?? 0,
  }));
}

// ───────────────────────── 写操作：发送 / 删除 / 上传图片 ─────────────────────────

/** 公告类型：1 = 普通公告，20 = 新成员公告。 */
export const GROUP_NOTICE_TYPE_NORMAL = 1;
export const GROUP_NOTICE_TYPE_NEW_MEMBERS = 20;

export interface SetGroupNoticeOptions {
  /** 是否置顶（0/1），默认 0。 */
  pinned?: 0 | 1;
  /** 公告类型；与 `sendToNewMembers` 二选一，冲突时抛错。 */
  type?: number;
  /** 发到「新成员公告」而不是普通公告。 */
  sendToNewMembers?: boolean;
  /** 0 = 显示群昵称引导卡，1 = 不显示。 */
  isShowEditCard?: 0 | 1;
  /** QQ 语义反转：0 = 弹窗提醒，1 = 不弹。 */
  tipWindowType?: 0 | 1;
  /** 是否需要成员确认（0/1）。 */
  confirmRequired?: 0 | 1;
  /** 已上传图片 id（见 {@link uploadGroupNoticeImage}）。 */
  picId?: string;
  imgWidth?: number;
  imgHeight?: number;
}

export interface ResolvedGroupNoticeOptions {
  pinned: 0 | 1;
  type: number;
  sendToNewMembers: boolean;
  isShowEditCard: 0 | 1;
  tipWindowType: 0 | 1;
  confirmRequired: 0 | 1;
  picId: string;
  imgWidth: number;
  imgHeight: number;
}

function binary(name: string, value: number | undefined, fallback: 0 | 1): 0 | 1 {
  const resolved = value ?? fallback;
  if (resolved !== 0 && resolved !== 1) {
    throw new RangeError(`${name} 只能是 0 或 1，收到 ${resolved}`);
  }
  return resolved;
}

/** 把兼容字段归一成真实的请求模式；纯函数，方便单测。 */
export function resolveGroupNoticeOptions(
  options: SetGroupNoticeOptions = {},
): ResolvedGroupNoticeOptions {
  if (options.sendToNewMembers !== undefined && typeof options.sendToNewMembers !== 'boolean') {
    throw new TypeError('sendToNewMembers 必须是布尔值');
  }
  if (
    options.type !== undefined &&
    options.type !== GROUP_NOTICE_TYPE_NORMAL &&
    options.type !== GROUP_NOTICE_TYPE_NEW_MEMBERS
  ) {
    throw new RangeError(
      `type 只能是 ${GROUP_NOTICE_TYPE_NORMAL}（普通）或 ${GROUP_NOTICE_TYPE_NEW_MEMBERS}（新成员）`,
    );
  }
  const semantic = options.sendToNewMembers;
  const byType =
    options.type === undefined ? undefined : options.type === GROUP_NOTICE_TYPE_NEW_MEMBERS;
  if (semantic !== undefined && byType !== undefined && semantic !== byType) {
    throw new RangeError('sendToNewMembers 与 type 冲突');
  }
  const sendToNewMembers = semantic ?? byType ?? false;
  return {
    pinned: binary('pinned', options.pinned, 0),
    type: sendToNewMembers ? GROUP_NOTICE_TYPE_NEW_MEMBERS : GROUP_NOTICE_TYPE_NORMAL,
    sendToNewMembers,
    isShowEditCard: binary('isShowEditCard', options.isShowEditCard, 1),
    tipWindowType: binary('tipWindowType', options.tipWindowType, 1),
    confirmRequired: binary('confirmRequired', options.confirmRequired, 1),
    picId: options.picId ?? '',
    imgWidth: options.imgWidth ?? 540,
    imgHeight: options.imgHeight ?? 300,
  };
}

interface SetNoticeRet {
  ec?: number;
  em?: string;
}

/**
 * 发送群公告。
 *
 * 认证细节：URL 的 bkn 用 p_skey（缺失回退 skey），body 的 bkn 用 skey ——
 * 两个 token 服务端分别校验。
 */
export async function setGroupNotice(
  cred: WebCredential,
  groupCode: string,
  content: string,
  options: SetGroupNoticeOptions = {},
): Promise<{ noticeId?: string }> {
  const text = String(content ?? '');
  if (!text.trim()) throw new Error('公告正文不能为空');
  const resolved = resolveGroupNoticeOptions(options);

  const urlBkn = computeBkn(cred.pskey || cred.skey);
  const bodyBkn = computeBkn(cred.skey);
  const settings = JSON.stringify({
    is_show_edit_card: resolved.isShowEditCard,
    tip_window_type: resolved.tipWindowType,
    confirm_required: resolved.confirmRequired,
  });
  const params: Record<string, string> = {
    qid: groupCode,
    bkn: String(bodyBkn),
    text,
    pinned: String(resolved.pinned),
    type: String(resolved.type),
    settings,
  };
  if (resolved.picId) {
    params.pic = resolved.picId;
    params.imgWidth = String(resolved.imgWidth);
    params.imgHeight = String(resolved.imgHeight);
  }

  const endpoint = resolved.sendToNewMembers ? 'add_qun_instruction' : 'add_qun_notice';
  const url = `https://web.qun.qq.com/cgi-bin/announce/${endpoint}?bkn=${urlBkn}`;
  const ret = await webRequestJson<SetNoticeRet & { fid?: string }>(url, {
    method: 'POST',
    cookie: cookieHeader(cred),
    body: new URLSearchParams(params).toString(),
    headers: {
      Referer: 'https://web.qun.qq.com/mannounce/index.html?_wv=1031&_bid=148',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  });
  if (ret.ec !== 0) {
    throw new Error(`发送群公告失败：ec=${ret.ec ?? 'missing'} ${ret.em ?? ''}`.trim());
  }
  return ret.fid ? { noticeId: String(ret.fid) } : {};
}

/** 删除一条群公告；`fid` 来自列表接口的 `noticeId`。 */
export async function deleteGroupNotice(
  cred: WebCredential,
  groupCode: string,
  fid: string,
): Promise<void> {
  const id = String(fid ?? '').trim();
  if (!id) throw new Error('fid 不能为空');
  const urlBkn = computeBkn(cred.pskey || cred.skey);
  const bodyBkn = computeBkn(cred.skey);
  const url = `https://web.qun.qq.com/cgi-bin/announce/del_feed?bkn=${urlBkn}`;
  const ret = await webRequestJson<SetNoticeRet>(url, {
    method: 'POST',
    cookie: cookieHeader(cred),
    body: new URLSearchParams({ bkn: String(bodyBkn), fid: id, qid: groupCode }).toString(),
    headers: {
      Referer: 'https://web.qun.qq.com/mannounce/index.html?_wv=1031&_bid=148',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  });
  if (ret.ec !== 0) {
    throw new Error(`删除群公告失败：ec=${ret.ec ?? 'missing'} ${ret.em ?? ''}`.trim());
  }
}

/** 解析上传接口返回的 HTML 转义 JSON 元数据（纯函数，便于单测）。 */
export function parseGroupNoticeImageUploadResponse(data: string): {
  id: string;
  width: number;
  height: number;
} {
  let result: { ec?: number; em?: string; id?: string };
  try {
    result = JSON.parse(data) as { ec?: number; em?: string; id?: string };
  } catch (cause) {
    throw new Error('群公告图片上传返回了非法 JSON', { cause });
  }
  if (result.ec !== 0 || !result.id) {
    throw new Error(
      `群公告图片上传失败：ec=${result.ec ?? 'missing'} em=${result.em ?? 'missing'}`,
    );
  }
  let meta: { id?: unknown; w?: unknown; h?: unknown };
  try {
    meta = JSON.parse(result.id.replace(/&quot;/g, '"')) as {
      id?: unknown;
      w?: unknown;
      h?: unknown;
    };
  } catch (cause) {
    throw new Error('群公告图片上传返回的元数据不是合法 JSON', { cause });
  }
  const width = Number(meta.w);
  const height = Number(meta.h);
  if (
    typeof meta.id !== 'string' ||
    meta.id.length === 0 ||
    !Number.isFinite(width) ||
    width <= 0 ||
    !Number.isFinite(height) ||
    height <= 0
  ) {
    throw new Error('群公告图片上传返回的元数据不完整');
  }
  return { id: meta.id, width, height };
}

/**
 * 上传一张公告图片，返回可直接传给 {@link setGroupNotice} 的 `picId` 与尺寸。
 *
 * 用 multipart/form-data；图片格式固定按 jpeg 声明（服务端只看字节）。
 */
export async function uploadGroupNoticeImage(
  cred: WebCredential,
  image: Uint8Array,
): Promise<{ id: string; width: number; height: number }> {
  if (!(image instanceof Uint8Array) || image.length === 0) {
    throw new Error('公告图片不能为空');
  }
  const boundary = `----WeQNotice${Date.now()}${Math.floor(Math.random() * 100000)}`;
  const field = (name: string, value: string): string =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  const head = Buffer.from(
    field('bkn', String(computeBkn(cred.skey))) +
      field('source', 'troopNotice') +
      field('m', '0') +
      `--${boundary}\r\nContent-Disposition: form-data; name="pic_up"; filename="image.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.length + image.length + tail.length);
  body.set(head, 0);
  body.set(image, head.length);
  body.set(tail, head.length + image.length);

  const text = await webRequestText('https://web.qun.qq.com/cgi-bin/announce/upload_img', {
    method: 'POST',
    cookie: cookieHeader(cred),
    body,
    headers: {
      Referer: 'https://web.qun.qq.com/mannounce/index.html?_wv=1031&_bid=148',
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
  });
  return parseGroupNoticeImageUploadResponse(text);
}
