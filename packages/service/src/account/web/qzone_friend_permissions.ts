import { computeBkn, cookieHeader, WebAuthError, type WebCredential } from './credential';
import { WEB_READ_RETRY, webRequestText } from './http';
import { parseQzoneCallback } from './qzone';

export type QzoneFriendPermission = 'blocked' | 'hidden';
const prefix = 'https://user.qzone.qq.com/proxy/domain/';
const endpoints = {
  blocked: [
    'base.qzone.qq.com/cgi-bin/buddy/cgi_get_black',
    'w.qzone.qq.com/cgi-bin/right/cgi_black_action_new',
  ],
  hidden: [
    'ic2.qzone.qq.com/cgi-bin/feeds/feeds2_shield_pannel_get',
    'w.qzone.qq.com/cgi-bin/tfriend/uncare_addfriend.cgi',
  ],
} as const;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('空间权限响应结构异常');
  return value as Record<string, unknown>;
}
function accepted(text: string) {
  const root = object(parseQzoneCallback<unknown>(text));
  if (root.code !== 0 || (root.subcode !== undefined && root.subcode !== 0)) {
    if (root.code === -3000 || root.code === -10000)
      throw new WebAuthError('空间权限登录态失效', root.code);
    throw new Error('空间权限请求未成功，请刷新核对');
  }
  return root;
}
export function parseQzonePermissionList(text: string, kind: QzoneFriendPermission) {
  const root = accepted(text);
  const data = object(root.data);
  const panel = kind === 'hidden' ? object(data.data) : data;
  const items = panel[kind === 'hidden' ? 'hide_uins' : 'items'];
  if (!Array.isArray(items) || (kind === 'hidden' && !Array.isArray(panel.hide_apps)))
    throw new Error('空间权限名单缺失');
  for (const scope of [root, data, panel]) {
    for (const key of ['hasMore', 'has_more', 'more'])
      if (scope[key] !== undefined && scope[key] !== false && scope[key] !== 0)
        throw new Error('空间权限名单未读取完整');
    for (const key of ['next', 'next_offset', 'next_cursor'])
      if (scope[key] !== undefined && scope[key] !== null && scope[key] !== '' && scope[key] !== 0)
        throw new Error('空间权限名单未读取完整');
  }
  const rows = items.map((item) => {
    const row = object(item);
    if (typeof row.uin === 'number' && !Number.isSafeInteger(row.uin))
      throw new Error('空间权限号码精度异常');
    const uin = String(row.uin ?? '');
    if (!/^[1-9]\d{4,11}$/.test(uin)) throw new Error('空间权限名单号码异常');
    return { uin, name: typeof row.nick === 'string' ? row.nick : '' };
  });
  if (new Set(rows.map((row) => row.uin)).size !== rows.length || rows.length > 1000)
    throw new Error('空间权限名单重复或超限');
  return rows;
}
export async function getQzonePermissionList(cred: WebCredential, kind: QzoneFriendPermission) {
  const query = new URLSearchParams({
    uin: cred.uin,
    fupdate: '1',
    useutf8: '1',
    g_tk: String(computeBkn(cred.pskey)),
  });
  return parseQzonePermissionList(
    await webRequestText(`${prefix}${endpoints[kind][0]}?${query}`, {
      cookie: cookieHeader(cred),
      headers: { Referer: `https://user.qzone.qq.com/${cred.uin}` },
      retry: WEB_READ_RETRY,
    }),
    kind,
  );
}
export async function setQzoneFriendPermission(
  cred: WebCredential,
  kind: QzoneFriendPermission,
  target: string,
  enabled: boolean,
  beforeSend: () => void,
) {
  if (!/^[1-9]\d{4,11}$/.test(target) || target === cred.uin) throw new Error('空间权限目标无效');
  const form = new URLSearchParams({
    uin: cred.uin,
    fupdate: '1',
    g_tk: String(computeBkn(cred.pskey)),
    ...(kind === 'blocked'
      ? { act_uin: target, action: enabled ? '1' : '2' }
      : { ouin: target, otype: enabled ? '0' : '1' }),
  });
  beforeSend();
  accepted(
    await webRequestText(`${prefix}${endpoints[kind][1]}`, {
      method: 'POST',
      cookie: cookieHeader(cred),
      headers: { Referer: `https://user.qzone.qq.com/${cred.uin}` },
      body: form.toString(),
    }),
  );
}
