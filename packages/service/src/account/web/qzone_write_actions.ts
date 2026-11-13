/** 普通说说的 Web 回复与转发；写入不做网络重试或端点降级。 */
import { computeBkn, cookieHeader, WebAuthError, type WebCredential } from './credential';
import { webRequestText } from './http';
import { parseQzoneCallback } from './qzone';

const WEB_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

export interface QzoneReplyTarget {
  rootId: string;
  rootUin: string;
  uin: string;
  nickname: string;
}

function identity(hostUin: string, tid: string): void {
  if (!/^[1-9]\d{4,19}$/.test(hostUin) || !/^[A-Za-z0-9_-]{1,128}$/.test(tid))
    throw new Error('空间动态身份无效。');
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function post(
  cred: WebCredential,
  cgi: string,
  params: Record<string, string>,
): Promise<void> {
  const text = await webRequestText(
    `https://h5.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/${cgi}?g_tk=${computeBkn(cred.pskey || cred.skey)}`,
    {
      method: 'POST',
      cookie: cookieHeader(cred),
      body: new URLSearchParams({
        code_version: '1',
        format: 'fs',
        out_charset: 'UTF-8',
        hostuin: cred.uin,
        qzreferrer: `https://user.qzone.qq.com/${cred.uin}`,
        ...params,
      }).toString(),
      headers: {
        'User-Agent': WEB_UA,
        Referer: `https://user.qzone.qq.com/${cred.uin}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    },
  );
  if (/<(?:!doctype|html|body)\b/i.test(text))
    throw new Error('空间返回了网页而非操作回执，请重新登录后核对结果。');
  const response = object(parseQzoneCallback<unknown>(text));
  const result = object(response.result),
    data = object(response.data);
  for (const layer of [response, result, data]) {
    if (
      (layer.needVerify !== undefined && layer.needVerify !== 0) ||
      layer.verifyurl ||
      layer.verifyUrl
    )
      throw new Error('QQ 空间要求验证，请在 QQ 空间完成验证后核对操作结果。');
    for (const key of ['code', 'subcode', 'ret']) {
      if (layer[key] !== undefined && layer[key] !== 0) {
        if (typeof layer[key] === 'number' && [-3000, -4009, -10001, -10003].includes(layer[key]))
          throw new WebAuthError('空间登录票据已失效。', layer[key]);
        throw new Error(`空间操作未被受理：${String(layer.msg ?? layer.message ?? layer[key])}`);
      }
    }
  }
  if (response.code !== 0 && response.ret !== 0 && result.code !== 0)
    throw new Error('空间操作响应格式无效，未确认结果，请核对后刷新。');
}

export async function replyQzoneMsg(
  cred: WebCredential,
  hostUin: string,
  tid: string,
  target: QzoneReplyTarget,
  content: string,
  imageUrl?: string,
): Promise<void> {
  identity(hostUin, tid);
  if (
    !/^\d{1,20}$/.test(target.rootId) ||
    !/^[1-9]\d{4,19}$/.test(target.rootUin) ||
    !/^[1-9]\d{4,19}$/.test(target.uin)
  )
    throw new Error('请重新读取评论后选择回复目标。');
  if (!content.trim() || content.length > 4096) throw new Error('回复内容为空或过长。');
  const encodedNick = (target.nickname || target.uin).replace(
    /[%,}{:]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  const params: Record<string, string> = {
    hostUin,
    format: 'json',
    uin: cred.uin,
    topicId: `${hostUin}_${tid}__1`,
    feedsType: '100',
    commentId: target.rootId,
    commentUin: target.rootUin,
    content: `@{uin:${target.uin},nick:${encodedNick},who:1,auto:1}${content}`,
    inCharset: 'utf-8',
    outCharset: 'utf-8',
    plat: 'qzone',
    source: 'ic',
    ref: 'feeds',
    private: '0',
    paramstr: '1',
    platformid: '52',
  };
  if (imageUrl) {
    params.richtype = '1';
    params.richval = imageUrl;
  }
  await post(cred, 'emotion_cgi_re_feeds', params);
}

export async function forwardQzoneMsg(
  cred: WebCredential,
  hostUin: string,
  tid: string,
  reason: string,
): Promise<void> {
  identity(hostUin, tid);
  if (reason.length > 4096) throw new Error('转发语过长。');
  await post(cred, 'emotion_cgi_forward_v6', {
    tid,
    t1_uin: hostUin,
    t1_source: '1',
    signin: '0',
    con: reason,
    with_cmt: '0',
    fwdToWeibo: '0',
    forward_source: '1',
  });
}
