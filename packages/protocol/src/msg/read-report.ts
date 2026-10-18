// 标记已读 — `trpc.msg.msg_svc.MsgService.SsoReadedReport`。
//
// 官方语义（对照 SnowLuma `core/src/bridge/apis/message.ts`）：
//   1. 第一条只报 0 水位，读回服务端当前的 `readSeq/latestSeq` 对（纯探测，不倒退）；
//   2. 第二条只推进落后于 `latestSeq` 的会话；
//   3. 每个包最多 100 个群 + 100 个私聊，等回包再发下一页。
//
// 单条 spec 只负责「一个包」，批量探测/推进的逻辑在 service 层。
//
// 签名：LagrangeV2 白名单里有 `trpc.msg.msg_svc.MsgService.SsoReadedReport` → 签。

import { message } from '../protobuf';
import { invokeTrpc, type TrpcSpec } from '../oidb/invoke';
import { toInt } from '../oidb/shared';
import type { TrpcNative } from '../transport';

export const READ_REPORT_CMD = 'trpc.msg.msg_svc.MsgService.SsoReadedReport';

/** 每个包最多 100 个会话（官方上限，超出服务端会拒）。 */
export const READ_REPORT_BATCH_SIZE = 100;

const GROUP_READ_ITEM = message([
  { name: 'groupUin', tag: 1, type: 'uint64' },
  { name: 'lastReadSeq', tag: 2, type: 'uint64' },
]);
const C2C_READ_ITEM = message([
  { name: 'uid', tag: 2, type: 'string' },
  { name: 'lastReadTime', tag: 3, type: 'uint64' },
  { name: 'lastReadSeq', tag: 4, type: 'uint64' },
]);
const READ_REQ = message([
  { name: 'groupList', tag: 1, type: GROUP_READ_ITEM, repeated: true },
  { name: 'c2cList', tag: 2, type: C2C_READ_ITEM, repeated: true },
]);

// 响应故意用不同的 tag：f3 = 群结果、f4 = 私聊结果。
const GROUP_READ_RESP_ITEM = message([
  { name: 'resultCode', tag: 1, type: 'uint32' },
  { name: 'errorMessage', tag: 2, type: 'string' },
  { name: 'groupUin', tag: 3, type: 'uint64' },
  { name: 'readSeq', tag: 4, type: 'uint64' },
  { name: 'latestSeq', tag: 5, type: 'uint64' },
]);
const C2C_READ_RESP_ITEM = message([
  { name: 'resultCode', tag: 1, type: 'uint32' },
  { name: 'errorMessage', tag: 2, type: 'string' },
  { name: 'targetUin', tag: 3, type: 'uint64' },
  { name: 'uid', tag: 4, type: 'string' },
  { name: 'readSeq', tag: 5, type: 'uint64' },
  { name: 'latestSeq', tag: 6, type: 'uint64' },
  { name: 'lastMsgTime', tag: 7, type: 'uint64' },
]);
const READ_RESP = message([
  { name: 'resultCode', tag: 1, type: 'uint32' },
  { name: 'errorMessage', tag: 2, type: 'string' },
  { name: 'groupList', tag: 3, type: GROUP_READ_RESP_ITEM, repeated: true },
  { name: 'c2cList', tag: 4, type: C2C_READ_RESP_ITEM, repeated: true },
]);

export interface GroupReadTarget {
  groupId: number;
  /** 上报的已读水位；探测阶段传 0。 */
  lastReadSeq?: number | bigint;
}

export interface C2cReadTarget {
  /** 对方 uid（必填；私聊读水位以 uid 定位）。 */
  uid: string;
  /** 上报的已读时间（秒）；探测阶段传 0。 */
  lastReadTime?: number | bigint;
  /** 上报的已读序号；探测阶段传 0。 */
  lastReadSeq?: number | bigint;
}

export interface ReadReportParams {
  groups?: GroupReadTarget[];
  c2c?: C2cReadTarget[];
}

export interface GroupReadResult {
  groupId: number;
  resultCode: number;
  errorMessage: string;
  readSeq: number;
  latestSeq: number;
}

export interface C2cReadResult {
  targetUin: number;
  uid: string;
  resultCode: number;
  errorMessage: string;
  readSeq: number;
  latestSeq: number;
  lastMsgTime: number;
}

export interface ReadReportResult {
  resultCode: number;
  errorMessage: string;
  groups: GroupReadResult[];
  c2c: C2cReadResult[];
}

function toSeq(value: number | bigint | undefined): bigint {
  if (value === undefined) return 0n;
  return typeof value === 'bigint' ? value : BigInt(value);
}

export namespace ReadedReport {
  export const cmd = READ_REPORT_CMD;
  export const reqSchema = READ_REQ;
  export const respSchema = READ_RESP;

  export type Params = ReadReportParams;

  export const serialize = (p: Params): Record<string, unknown> => {
    const groups = p.groups ?? [];
    const c2c = p.c2c ?? [];
    if (groups.length > READ_REPORT_BATCH_SIZE) {
      throw new Error(`单个包最多 ${READ_REPORT_BATCH_SIZE} 个群，收到 ${groups.length}`);
    }
    if (c2c.length > READ_REPORT_BATCH_SIZE) {
      throw new Error(`单个包最多 ${READ_REPORT_BATCH_SIZE} 个私聊，收到 ${c2c.length}`);
    }
    return {
      ...(groups.length > 0
        ? {
            groupList: groups.map((g) => ({
              groupUin: g.groupId,
              lastReadSeq: toSeq(g.lastReadSeq),
            })),
          }
        : {}),
      ...(c2c.length > 0
        ? {
            c2cList: c2c.map((c) => {
              if (!c.uid) throw new Error('私聊已读目标缺少 uid');
              return {
                uid: c.uid,
                lastReadTime: toSeq(c.lastReadTime),
                lastReadSeq: toSeq(c.lastReadSeq),
              };
            }),
          }
        : {}),
    };
  };

  export const deserialize = (body: Record<string, unknown>): ReadReportResult => ({
    resultCode: toInt(body.resultCode),
    errorMessage: typeof body.errorMessage === 'string' ? body.errorMessage : '',
    groups: ((body.groupList as Record<string, unknown>[] | undefined) ?? []).map((item) => ({
      groupId: toInt(item.groupUin),
      resultCode: toInt(item.resultCode),
      errorMessage: typeof item.errorMessage === 'string' ? item.errorMessage : '',
      readSeq: toInt(item.readSeq),
      latestSeq: toInt(item.latestSeq),
    })),
    c2c: ((body.c2cList as Record<string, unknown>[] | undefined) ?? []).map((item) => ({
      targetUin: toInt(item.targetUin),
      uid: typeof item.uid === 'string' ? item.uid : '',
      resultCode: toInt(item.resultCode),
      errorMessage: typeof item.errorMessage === 'string' ? item.errorMessage : '',
      readSeq: toInt(item.readSeq),
      latestSeq: toInt(item.latestSeq),
      lastMsgTime: toInt(item.lastMsgTime),
    })),
  });

  export const invoke = (nt: TrpcNative, pid: number, params: Params): Promise<ReadReportResult> =>
    invokeTrpc(nt, pid, ReadedReport as TrpcSpec<Params, ReadReportResult>, params);
}
