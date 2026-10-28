/**
 * 老式图片上传的 SSO 申请 —— `LongConn.OffPicUp`。
 *
 * 这是闪照链路的第一跳（第二跳是把字节 `PicUp.DataUp` PUT 到 highway，见
 * `./legacy-image-upload`）。它不属于 OIDB，是一条原始 SSO 命令，body 是纯 protobuf。
 *
 * ⚠️ 抓包里前面那 4 字节（如 `00 00 00 80`）是 native **组好的 SSO 帧长度**，钩子挂在
 * Socket 层所以录进来了 —— **不要自己在 body 前面补**：多写这 4 字节会让服务端当成
 * 畸形 protobuf 直接不回包（实测 100% 超时）。`sendPacket` 交纯 body 即可。
 *
 * 抓包来源：`qqhook-20261028-051613.txt`（2026-10-28，私聊发一张 1080×505 的闪照）。
 * 请求逐字段解出来是：
 *
 *   field 1  = 1                       （命令类型，恒 1）
 *   field 2  {                        子消息（uin / md5 / 尺寸 / 文件名）
 *     1  = 2863253201                 自己 uin
 *     3  = 1
 *     4  = <16 字节>                  原图 md5（**二进制**，不是 hex）
 *     5  = 61296                      字节数
 *     6  = 'F7A7FF…A530.jpg'          文件名（大写 md5 + 扩展名）
 *     7  = 2
 *     8  = 8
 *     10 = 0
 *     12 = 8
 *     13 = 0
 *     14 = 1080                       **宽**
 *     15 = 505                        **高**
 *     16 = 1000                       图片格式码（jpg）
 *     22 = 0
 *     25 = 'u_mGIBTBW7gF4Wocw8zapc6w' 自己 uid（不是对方）
 *   }
 *   field 10 = 3                       （场景/类型，恒 3）
 *
 * 响应：
 *
 *   field 1 = 1
 *   field 2 {
 *     1  = 1
 *     2  = 4239636590                 服务端文件 id
 *     3  = 0、5 = 0
 *     7  = <4 个 uint32>               （未知，逐字节照抄）
 *     8  = <重复 4 个 80>              （未知，逐字节照抄）
 *     9  = <336 字节>                  highway 的 serviceTicket（`PicUp.DataUp` 要带）
 *     10 = '/2863253201-3206593187-F7A7…A530'   ← downloadPath / resId
 *     11 = 同一串
 *   }
 *   field 4 = 1
 */

import { message, type ProtoMessage } from '../protobuf';

const f = (
  name: string,
  tag: number,
  type: ProtoMessage['fields'][number]['type'],
  extra: Partial<{ repeated: boolean; force: boolean }> = {},
) => ({ name, tag, type, ...extra });

/** `LongConn.OffPicUp` —— 原始 SSO 命令名。 */
export const OFF_PIC_UP_CMD = 'LongConn.OffPicUp';

/** 请求体 field 2。 */
export const OFF_PIC_UP_REQ_BODY: ProtoMessage = message([
  f('uin', 1, 'uint32'),
  f('field3', 3, 'uint32'),
  /** 原图 md5，二进制 16 字节（抓包是 raw digest，不是 hex 字符串）。 */
  f('picMd5', 4, 'bytes'),
  f('fileSize', 5, 'uint32'),
  f('fileName', 6, 'string'),
  f('field7', 7, 'uint32'),
  f('field8', 8, 'uint32'),
  // 抓包里 10 / 13 / 22 是**显式写 0**（`50 00` / `68 00` / `b0 01 00`），
  // 不是 proto3 的缺省省略 —— 用 force 让编码器照写，字节才能与真机逐字节一致。
  f('field10', 10, 'uint32', { force: true }),
  f('field12', 12, 'uint32'),
  f('field13', 13, 'uint32', { force: true }),
  /** **宽**（抓包 1080）。 */
  f('width', 14, 'uint32'),
  /** **高**（抓包 505）。 */
  f('height', 15, 'uint32'),
  /** 图片格式码：1000 jpg / 1001 png …（与 `imgType` 同一套）。 */
  f('imgType', 16, 'uint32'),
  f('field22', 22, 'uint32', { force: true }),
  /** 自己 uid（抓包是发信人的，不是对方）。 */
  f('selfUid', 25, 'string'),
]);

export const OFF_PIC_UP_REQ: ProtoMessage = message([
  f('field1', 1, 'uint32'),
  f('body', 2, OFF_PIC_UP_REQ_BODY),
  f('field10', 10, 'uint32'),
]);

/** 响应体 field 2。 */
export const OFF_PIC_UP_RESP_BODY: ProtoMessage = message([
  f('field1', 1, 'uint32'),
  f('fileId', 2, 'uint32'),
  f('field3', 3, 'uint32'),
  f('field5', 5, 'uint32'),
  f('field7', 7, 'uint32', { repeated: true }),
  f('field8', 8, 'uint32', { repeated: true }),
  /** highway `PicUp.DataUp` 的 `msgSegHead.serviceTicket`。 */
  f('serviceTicket', 9, 'bytes'),
  /** 服务端签发的图片路径（闪照元素的 `downloadPath` / `resId`）。 */
  f('downloadPath', 10, 'string'),
  /** 同一串（抓包 10 与 11 完全一致）。 */
  f('resId', 11, 'string'),
  f('field12', 12, 'uint32'),
  f('field13', 13, 'uint32'),
  /** 4 字节，抓包原样。 */
  f('field27', 27, 'bytes'),
]);

export const OFF_PIC_UP_RESP: ProtoMessage = message([
  f('field1', 1, 'uint32'),
  f('body', 2, OFF_PIC_UP_RESP_BODY),
  f('field4', 4, 'uint32'),
]);
