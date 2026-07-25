// SyncVCR —— 拉取服务端侧该账号可见的资源版本表。`scupdate.handle` 的 cmd=1 分支。
//
// 用处:不必猜 item_id。传空 item_list 时服务端会把整张表吐回来,里面的 scid 是权威
// 写法(比如字体 id 实际是 5 位的 `font.main.android.10060`,凭空猜不出来)。拿到清单
// 后交给 `getUrlsByScid` 换地址即可。

import { decode, encode } from '../protobuf';
import { sendPacket, type TrpcNative } from '../transport';
import { scanScids } from './scid';
import { SCUPDATE_CMD, SC_UPDATE_REQ, SC_UPDATE_RSP, ScUpdateOp } from './schemas';
import { buildReqComm, readRspStatus, type ScUpdateClient } from './session';

export interface ResourceListing {
  /** 扫出的全部 scid,已排序去重。 */
  scids: string[];
  /** 按业务前缀(scid 第一段)分组,如 `bubble` / `font` / `praise`。 */
  byBusiness: Map<string, string[]>;
  /** 服务端建议的下次同步间隔(秒)。 */
  polltime: number;
  /** 原始响应字节,便于排查解析遗漏。 */
  raw: Uint8Array;
}

/**
 * 拉取资源版本表。
 *
 * 版本表的嵌套 PB 结构没有建模 —— 我们只要里面的 scid 文本,直接扫裸字节
 * (见 {@link scanScids})比跟着嵌套层级走更抗服务端改版。
 */
export async function syncResourceList(
  nt: TrpcNative,
  pid: number,
  client: ScUpdateClient = {},
): Promise<ResourceListing> {
  const body = encode(SC_UPDATE_REQ, {
    cmd: ScUpdateOp.SyncVcr,
    comm: buildReqComm(client),
    req0x01: { seq: 0, sync_mode: 1, plver: 0, rpver: 0, item_list: [] },
  });

  const raw = await sendPacket(nt, pid, SCUPDATE_CMD, body);
  const rsp = decode(SC_UPDATE_RSP, raw);
  const status = readRspStatus(rsp);

  const scids = scanScids(raw);
  const byBusiness = new Map<string, string[]>();
  for (const scid of scids) {
    const business = scid.split('.')[0]!;
    const bucket = byBusiness.get(business);
    if (bucket) bucket.push(scid);
    else byBusiness.set(business, [scid]);
  }

  return { scids, byBusiness, polltime: status.polltime, raw };
}
