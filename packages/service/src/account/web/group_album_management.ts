import { computeBkn, cookieHeader, WebAuthError, type WebCredential } from './credential';
import { WEB_READ_RETRY, webRequestText } from './http';
import { parseQzoneJson } from './qzone';

const ALBUM_CGI = 'https://h5.qzone.qq.com/proxy/domain/u.photo.qzone.qq.com/cgi-bin/upp/';
const AUTH_CODES = new Set([-3000, -10000]);

export interface GroupAlbumMutationScope {
  groupId: string;
  beforeSend?: () => void;
  signal?: AbortSignal;
}
export interface CreateGroupAlbumParams extends GroupAlbumMutationScope {
  title: string;
  description: string;
}
export interface DeleteGroupAlbumParams extends GroupAlbumMutationScope {
  albumId: string;
}
export interface ModifyGroupAlbumParams extends CreateGroupAlbumParams {
  albumId: string;
  /** 必须使用最新相册资料中的原值；未确认群相册权限枚举，不替调用方猜默认值。 */
  privacy: number;
}
export interface GroupAlbumUploadPermission {
  allowed: boolean;
  status: number;
  message: string;
}

function groupCode(value: string): string {
  if (typeof value !== 'string' || !/^[1-9]\d{0,9}$/.test(value) || BigInt(value) > 0xffffffffn)
    throw new Error('群号必须是有效的正整数');
  return value;
}
function albumId(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 1024 || value !== value.trim())
    throw new Error('相册标识无效');
  return value;
}
function albumText(params: CreateGroupAlbumParams): { title: string; desc: string } {
  if (typeof params.title !== 'string' || !params.title.trim() || params.title.trim().length > 30)
    throw new Error('相册名称不能为空且不能超过 30 个字');
  if (typeof params.description !== 'string' || params.description.trim().length > 2000)
    throw new Error('相册描述不能超过 2000 个字');
  return { title: params.title.trim(), desc: params.description.trim() };
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('群相册响应结构无法确认');
  return value as Record<string, unknown>;
}
function responseData(text: string): Record<string, unknown> {
  // 复用非执行 JSON 解析，兼容官方 formSender 的 frameElement.callback 外壳。
  const response = record(parseQzoneJson<unknown>(text));
  if (response.code !== 0) {
    if (typeof response.code !== 'number' || !Number.isSafeInteger(response.code))
      throw new Error('群相册响应缺少明确业务码，结果未确认');
    const message = typeof response.message === 'string' ? response.message.slice(0, 256) : '';
    const error = `群相册请求失败：code=${response.code}${message ? ` ${message}` : ''}`;
    throw AUTH_CODES.has(response.code) ? new WebAuthError(error, response.code) : new Error(error);
  }
  return response.data === undefined ? {} : record(response.data);
}

async function mutate(
  cred: WebCredential,
  operation: 'qun_add_album_v2' | 'qun_mod_album_v2' | 'qun_del_album_v2',
  params: GroupAlbumMutationScope,
  fields: Record<string, string>,
): Promise<Record<string, unknown>> {
  const form = new URLSearchParams({
    qunId: groupCode(params.groupId),
    uin: cred.uin,
    ...fields,
    platform: 'qzone',
    inCharset: 'utf-8',
    outCharset: 'utf-8',
    source: 'qzone',
    format: 'json',
  });
  params.signal?.throwIfAborted();
  params.beforeSend?.();
  const text = await webRequestText(
    `${ALBUM_CGI}${operation}?g_tk=${computeBkn(cred.pskey || cred.skey)}`,
    {
      method: 'POST',
      redirect: 'error',
      cookie: cookieHeader(cred),
      body: form.toString(),
      maxResponseBytes: 256 * 1024,
      ...(params.signal ? { signal: params.signal } : {}),
    },
  );
  return responseData(text);
}

/** 来源：官方 groupPhoto/util/index.js 的 addAblum；新建固定 priv=1，不推断其可见范围。 */
export async function createGroupAlbum(
  cred: WebCredential,
  params: CreateGroupAlbumParams,
): Promise<{ albumId: string }> {
  const data = await mutate(cred, 'qun_add_album_v2', params, { ...albumText(params), priv: '1' });
  if (typeof data.albumid !== 'string') throw new Error('新建回执缺少相册标识，结果未确认');
  return { albumId: albumId(data.albumid) };
}

/** 仅修改名称与描述，明确保留原 priv，不附带封面、密码或其他权限字段。 */
export async function modifyGroupAlbum(
  cred: WebCredential,
  params: ModifyGroupAlbumParams,
): Promise<void> {
  if (!Number.isSafeInteger(params.privacy) || params.privacy < 0 || params.privacy > 0xffffffff)
    throw new Error('缺少有效的原相册权限值，请重新读取相册');
  await mutate(cred, 'qun_mod_album_v2', params, {
    ...albumText(params),
    albumId: albumId(params.albumId),
    priv: String(params.privacy),
  });
}

/** 删除整个相册及其中媒体；调用方负责确认目标、权限和破坏范围，并在之后读回。 */
export async function deleteGroupAlbum(
  cred: WebCredential,
  params: DeleteGroupAlbumParams,
): Promise<void> {
  await mutate(cred, 'qun_del_album_v2', params, { albumId: albumId(params.albumId) });
}

/** 官方创建与上传按钮均查询此接口；只解释明确的 uploadRight=0，不外推其他状态含义。 */
export async function getGroupAlbumUploadPermission(
  cred: WebCredential,
  groupId: string,
): Promise<GroupAlbumUploadPermission> {
  const query = new URLSearchParams({
    qunId: groupCode(groupId),
    inCharset: 'utf-8',
    outCharset: 'utf-8',
    format: 'json',
    g_tk: String(computeBkn(cred.pskey || cred.skey)),
  });
  const text = await webRequestText(`${ALBUM_CGI}qun_query_upload_auth?${query}`, {
    method: 'GET',
    redirect: 'error',
    cookie: cookieHeader(cred),
    maxResponseBytes: 256 * 1024,
    retry: WEB_READ_RETRY,
  });
  const data = responseData(text);
  if (
    typeof data.uploadRight !== 'number' ||
    !Number.isSafeInteger(data.uploadRight) ||
    data.uploadRight < 0
  )
    throw new Error('未取得明确的相册上传权限');
  return {
    allowed: data.uploadRight === 0,
    status: data.uploadRight,
    message: typeof data.msg === 'string' ? data.msg.slice(0, 256) : '',
  };
}
