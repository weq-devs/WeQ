// trpc.qq_lbs.qq_lbs_ark.LocationArk.SsoSendMessage —— 发送「位置」Ark 卡片。
//
// 私聊 / 群聊都走同一条 trpc（裸 SSO，无 OIDB 信封），请求 body 布局由真机抓包
// RE 得到：
//
//   field 1  targetUin  uint64  目标 QQ 号（私聊）或群号（群聊）
//   field 2  peerType   uint32  0 = 私聊，1 = 群聊（0 也必须上 wire → force）
//   field 3  address    string  详细地址（街道，如「XX区XX路东100米」）
//   field 4  region     string  地址第一行（省市区）
//   field 5  latitude   string  纬度（十进制字符串，如 "31.763573"）
//   field 6  longitude  string  经度（十进制字符串，如 "104.736101"）
//
// 抓包样本最前面的 4 字节大端长度（`00 00 00 70` = 整包 112 字节）是 SSO 传输层
// 的封帧，由 native `sendPacket` 负责，**不在**本模块编码的 body 里 —— 本模块只
// 编码上面这 6 个字段。黄金字节见 `test/send_location_ark.test.ts`（地址已脱敏）。
//
// 响应目前没有抓到样本，所以 {@link SendLocationArk.invoke} 原样返回响应字节，
// **不臆造** schema、也不假装成功；调用方拿到字节后自行判定。

import { encode, message } from '../protobuf';
import { sendPacket, type TrpcNative } from '../transport';

/** 位置 Ark 的 SSO 命令字。 */
export const LOCATION_ARK_CMD = 'trpc.qq_lbs.qq_lbs_ark.LocationArk.SsoSendMessage';

const LOCATION_ARK_REQ = message([
  { name: 'targetUin', tag: 1, type: 'uint64' },
  { name: 'peerType', tag: 2, type: 'uint32', force: true },
  { name: 'address', tag: 3, type: 'string' },
  { name: 'region', tag: 4, type: 'string' },
  { name: 'latitude', tag: 5, type: 'string' },
  { name: 'longitude', tag: 6, type: 'string' },
]);

export interface SendLocationArkParams {
  /** 目标 QQ 号（peerType=0）或群号（peerType=1）。 */
  targetUin: number | bigint | string;
  /** 0 = 私聊，1 = 群聊。 */
  peerType: 0 | 1;
  /** 详细地址（街道）。 */
  address: string;
  /** 地址第一行（省市区）。 */
  region: string;
  /** 纬度（十进制字符串）。 */
  latitude: string;
  /** 经度（十进制字符串）。 */
  longitude: string;
}

function requireNonEmpty(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`位置 Ark 的 ${field} 不能为空`);
  }
}

export namespace SendLocationArk {
  export const cmd = LOCATION_ARK_CMD;
  export const reqSchema = LOCATION_ARK_REQ;

  /** 校验 + 拼出请求字段（peerType 为 0 时也保留在对象里，编码层 force 上 wire）。 */
  export const serialize = (p: SendLocationArkParams): Record<string, unknown> => {
    if (p.peerType !== 0 && p.peerType !== 1) {
      throw new Error(
        `位置 Ark 的 peerType 只能是 0（私聊）或 1（群聊），收到 ${String(p.peerType)}`,
      );
    }
    requireNonEmpty(p.address, 'address');
    requireNonEmpty(p.region, 'region');
    requireNonEmpty(p.latitude, 'latitude');
    requireNonEmpty(p.longitude, 'longitude');
    return {
      targetUin: p.targetUin,
      peerType: p.peerType,
      address: p.address,
      region: p.region,
      latitude: p.latitude,
      longitude: p.longitude,
    };
  };

  /**
   * 发送位置卡片，返回**原始响应字节**。
   *
   * 响应格式尚未抓到样本，这里不臆造 schema、也不假设「能返回就是成功」；
   * 调用方拿到字节后可自行解析 / 记录。
   */
  export const invoke = (
    nt: TrpcNative,
    pid: number,
    params: SendLocationArkParams,
  ): Promise<Uint8Array> => {
    const bytes = encode(reqSchema, serialize(params));
    return sendPacket(nt, pid, cmd, bytes);
  };
}
