// GetUrl —— 把 scid 换成真实 CDN 下载外链。trpc `scupdate.handle` 的 cmd=2 分支。
//
// 这是整条链路的关键一步:客户端本地能拼出 scid,但下载地址里带服务端生成的 UUID
// (`https://gxh.material.qq.com/zip/font/32824/<uuid>/<uuid>.zip`),本地推导不出,
// 只能问服务端要。换回来的地址是公开的 —— 鉴权只发生在这次请求(靠 QQ 进程的登录态),
// 拿到 url 之后直接 GET 即可,无需 cookie。
//
// 桌面 NTQQ 发这个包同样被受理:`comm.plat` 填 109(Android QQ)即可,服务端不校验
// 发起端真实平台。

import { decode, encode } from '../protobuf';
import { sendPacket, type TrpcNative } from '../transport';
import { bidFromScid } from './scid';
import {
  CODE_NOT_FOUND,
  SCUPDATE_CMD,
  SC_UPDATE_REQ,
  SC_UPDATE_RSP,
  STORAGE_MODE_FILE,
  ScUpdateOp,
  type VasBid,
} from './schemas';
import { buildReqComm, readRspStatus, type ScUpdateClient } from './session';

/** 要换取的一个资源。 */
export interface ScidRef {
  bid: VasBid | number;
  scid: string;
  /** 本地已有版本(dst_version)。留空 = 索取最新版。 */
  version?: string;
}

/** 一条换取结果。`ok` 为 true 时 {@link url} 必为可直接下载的完整地址。 */
export interface ResourceUrl {
  bid: number;
  scid: string;
  /** 下载地址。`ok=false` 时可能是无路径的占位域名或空串。 */
  url: string;
  /** 字节数。服务端未提供该资源时为 0。 */
  size: number;
  /** 资源版本(内容 md5)。 */
  version: string;
  /** 服务端错误码,0 为正常。 */
  code: number;
  /** 是否拿到了可用的下载地址。 */
  ok: boolean;
  /** `ok=false` 时的原因,便于调用方区分「没有这个包」和「资源不存在」。 */
  reason?: 'not-found' | 'no-such-part' | 'empty-response';
}

/**
 * 判断服务端是否真给了文件。
 *
 * 不能只看 url 非空 —— 参数不对或该款没有此分包时,服务端会回一个只有域名没有路径的
 * 占位地址(`https://gxh.material.qq.com/`)且 filesize 缺省。必须同时校验路径与大小。
 *
 * 导出供调用方复用:处理原始 `UpdateInfo` 时可以直接用同一套判定,不必各写一遍。
 */
export function isDownloadable(item: Record<string, unknown>): boolean {
  const url = String(item.url ?? '');
  const size = Number(item.filesize ?? 0);
  if (!url || size <= 0) return false;
  try {
    return new URL(url).pathname.replace(/^\/+/, '').length > 0;
  } catch {
    return false;
  }
}

function toResult(raw: Record<string, unknown>): ResourceUrl {
  const url = String(raw.url ?? '');
  const size = Number(raw.filesize ?? 0);
  const code = Number(raw.code ?? 0);
  const ok = code === 0 && isDownloadable(raw);

  const result: ResourceUrl = {
    bid: Number(raw.bid ?? 0),
    scid: String(raw.scid ?? ''),
    url,
    size,
    version: String(raw.dst_version ?? ''),
    code,
    ok,
  };
  if (!ok) result.reason = code === CODE_NOT_FOUND ? 'not-found' : 'no-such-part';
  return result;
}

/**
 * 批量把 scid 换成下载地址。一次请求可带多个 scid,返回顺序与服务端一致
 * (通常与请求同序,但不保证 —— 按 `scid` 字段匹配更稳妥)。
 */
export async function getResourceUrls(
  nt: TrpcNative,
  pid: number,
  refs: readonly ScidRef[],
  client: ScUpdateClient = {},
): Promise<ResourceUrl[]> {
  if (refs.length === 0) return [];

  const body = encode(SC_UPDATE_REQ, {
    cmd: ScUpdateOp.GetUrl,
    comm: buildReqComm(client),
    req0x02: {
      delta_mode: 0,
      storage_mode: STORAGE_MODE_FILE,
      compress_mode: 0,
      item_list: refs.map((r) => ({ bid: r.bid, scid: r.scid, version: r.version ?? '' })),
    },
  });

  const reply = await sendPacket(nt, pid, SCUPDATE_CMD, body);
  const rsp = decode(SC_UPDATE_RSP, reply);
  readRspStatus(rsp); // ret != 0 时抛错

  const inner = rsp.rsp0x02 as Record<string, unknown> | undefined;
  const list = (inner?.update_list as Record<string, unknown>[] | undefined) ?? [];

  if (list.length === 0) {
    // 服务端受理了但一条都没回 —— 让调用方能按 scid 对上号,而不是拿到空数组。
    return refs.map((r) => ({
      bid: Number(r.bid),
      scid: r.scid,
      url: '',
      size: 0,
      version: '',
      code: 0,
      ok: false,
      reason: 'empty-response' as const,
    }));
  }
  return list.map(toResult);
}

/** 换取单个 scid。找不到对应条目时返回 null。 */
export async function getResourceUrl(
  nt: TrpcNative,
  pid: number,
  ref: ScidRef,
  client: ScUpdateClient = {},
): Promise<ResourceUrl | null> {
  const all = await getResourceUrls(nt, pid, [ref], client);
  return all.find((r) => r.scid === ref.scid) ?? all[0] ?? null;
}

/**
 * 按 scid 换取,bid 从前缀自动推断。用于处理 {@link syncResourceList} 拉回的清单。
 * 无法识别前缀的 scid 会被跳过。
 */
export async function getUrlsByScid(
  nt: TrpcNative,
  pid: number,
  scids: readonly string[],
  client: ScUpdateClient = {},
): Promise<ResourceUrl[]> {
  const refs: ScidRef[] = [];
  for (const scid of scids) {
    const bid = bidFromScid(scid);
    if (bid !== undefined) refs.push({ bid, scid });
  }
  return getResourceUrls(nt, pid, refs, client);
}
