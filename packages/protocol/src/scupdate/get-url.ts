// GetUrl —— 把 scid 换成真实 CDN 下载外链。trpc `scupdate.handle` 的 cmd=2 分支。
//
// 这是整条链路的关键一步:客户端本地能拼出 scid,但下载地址里带服务端生成的 UUID
// (`https://gxh.material.qq.com/zip/font/32824/<uuid>/<uuid>.zip`),本地推导不出,
// 只能问服务端要。换回来的地址是公开的 —— 鉴权只发生在这次请求(靠 QQ 进程的登录态),
// 拿到 url 之后直接 GET 即可,无需 cookie。
//
// 身份默认走桌面 PC(见 session.ts 的 `PC_QQ_CLIENT`):`plat=111` / `from=pc_bubble`,
// 与真机抓包一致。同一个 scid 用 PC 身份与手Q 身份换回来的地址一模一样(2026-09-21
// 实测),所以身份只决定"像不像真的桌面客户端",不影响能不能拿到资源。

import { decode, encode } from '../protobuf';
import { sendPacket, type TrpcNative } from '../transport';
import { bidFromScid } from './scid';
import {
  CODE_NOT_FOUND,
  PLAT_PC_QQ,
  SCUPDATE_CMD,
  SC_UPDATE_REQ,
  SC_UPDATE_RSP,
  STORAGE_MODE_FILE,
  ScUpdateOp,
  type VasBid,
} from './schemas';
import { PC_QQ_CLIENT, buildReqComm, readRspStatus, type ScUpdateClient } from './session';

/** 要换取的一个资源。 */
export interface ScidRef {
  bid: VasBid | number;
  scid: string;
  /** 本地已有版本(dst_version)。留空 = 索取最新版。 */
  version?: string;
  /**
   * 装扮 itemId。PC 端会把 `bid`/`itemId` 冗余进 `subappid`/`subitemid`(抓包如此),
   * 传了就在 PC 身份下照带;不传(比如从 SyncVCR 清单来的 scid)就省略 —— 服务端并不要求。
   */
  itemId?: number | string;
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
 * 组装 cmd=2 的 GetUrl 请求体。
 *
 * 单独抽出来是为了能离线对着真机抓包做逐字节测试(见 protocol 的 `scupdate.test.ts`):
 * 报文形状是这套协议里最容易悄悄漂掉的部分,值得拿黄金样本守着。
 */
export function buildGetUrlRequest(
  refs: readonly ScidRef[],
  client: ScUpdateClient = PC_QQ_CLIENT,
): Uint8Array {
  // PC 身份才带 req0x02 的 tag 5 与 ItemVersion 的 flag/subappid/subitemid —— 这几个
  // 字段是照 PC 抓包补的,手Q 形状保持原样不动。
  const pc = (client.plat ?? PLAT_PC_QQ) === PLAT_PC_QQ;

  return encode(SC_UPDATE_REQ, {
    cmd: ScUpdateOp.GetUrl,
    comm: buildReqComm(client),
    req0x02: {
      delta_mode: 0,
      storage_mode: STORAGE_MODE_FILE,
      // compress_mode=1 会让服务端回压缩过的包:老 `/club/` 路径的 config.json 变成
      // `.json.zip`,2178B → 876B。PC 抓包里是 1,但我们一律用 0 —— 拿明文才不用自己解压。
      compress_mode: 0,
      ...(pc ? { flag: 0 } : {}),
      item_list: refs.map((r) => {
        // PC 端即使没有本地版本也显式发空串(`1a 00`);手Q 形状保持「空就不发」,
        // 不动已经在跑的报文。
        const version = r.version ?? (pc ? '' : undefined);
        return {
          bid: r.bid,
          scid: r.scid,
          ...(version !== undefined ? { version } : {}),
          ...(pc && r.itemId !== undefined
            ? { flag: 1, subappid: r.bid, subitemid: r.itemId }
            : {}),
        };
      }),
    },
  });
}

/**
 * 批量把 scid 换成下载地址。一次请求可带多个 scid,返回顺序与服务端一致
 * (通常与请求同序,但不保证 —— 按 `scid` 字段匹配更稳妥)。
 */
export async function getResourceUrls(
  nt: TrpcNative,
  pid: number,
  refs: readonly ScidRef[],
  client: ScUpdateClient = PC_QQ_CLIENT,
): Promise<ResourceUrl[]> {
  if (refs.length === 0) return [];

  const body = buildGetUrlRequest(refs, client);

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
  client: ScUpdateClient = PC_QQ_CLIENT,
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
  client: ScUpdateClient = PC_QQ_CLIENT,
): Promise<ResourceUrl[]> {
  const refs: ScidRef[] = [];
  for (const scid of scids) {
    const bid = bidFromScid(scid);
    if (bid !== undefined) refs.push({ bid, scid });
  }
  return getResourceUrls(nt, pid, refs, client);
}
