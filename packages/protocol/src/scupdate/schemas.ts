// SC 快更新(scupdate)的 protobuf 结构 + 常量。
//
// 字段号逐个取自 QQ 8.8.17 apk 的 `com.tencent.pb.scupdate.SCUpdatePB`,每个内部类的
// `initFieldMap(new int[]{...})` 数组即 wire tag(tag = 值 >> 3)。同一个 SSO 命令
// `scupdate.handle` 用 `SCUpdateReq.cmd` 分流两种操作:1 = SyncVCR(同步资源版本表)、
// 2 = GetUrl(换下载外链)。

import { message, type ProtoMessage } from '../protobuf';

/** SSO 命令字(手Q `ApolloExtensionHandler` 里 `a("scupdate.handle", ...)`)。 */
export const SCUPDATE_CMD = 'scupdate.handle';

/** `SCUpdateReq.cmd` 的取值。 */
export enum ScUpdateOp {
  SyncVcr = 1,
  GetUrl = 2,
}

/**
 * 业务 id。取自各 `BaseUpdateCallback.getBID()`,与 QQ 会员装扮页的 `appId` 同源
 * (见 `service/account/web/friend_dress.ts` 的 APP_KIND 表)。
 */
export enum VasBid {
  Bubble = 2,
  Theme = 3,
  Font = 5,
}

/**
 * `GetUrlReq.storage_mode` 必须为 1,否则 zip 类资源只回一个没有路径的占位 url
 * (`https://gxh.material.qq.com/`)且 `filesize=0` —— 看着像"资源不存在",实为参数不对。
 * `config.json` 不受影响,但统一传 1 无副作用。`delta_mode`/`compress_mode` 实测
 * 取 0/1/2 结果一致,固定 0。
 */
export const STORAGE_MODE_FILE = 1;

/** 服务端返回的"资源不存在"错误码(apk 里 `DownloadItemTask` 的 getUrl = -20002)。 */
export const CODE_NOT_FOUND = -20002;

/** 请求方平台标识。109 = Android QQ —— 桌面端发这个包也要用它,否则不被受理。 */
export const PLAT_ANDROID_QQ = 109;

/** 随包上报的客户端版本。保持与 apk 内硬编码一致。 */
export const QVER_ANDROID = '8.8.17.5770';

// ─────────────────────────── 请求 ───────────────────────────

/** `SCUpdatePB$ItemVersion` — tags {8,18,26,32,40,48}。 */
export const ITEM_VERSION: ProtoMessage = message([
  { name: 'bid', tag: 1, type: 'uint32' },
  { name: 'scid', tag: 2, type: 'string' },
  { name: 'version', tag: 3, type: 'string' },
  { name: 'flag', tag: 4, type: 'uint32' },
  { name: 'subappid', tag: 5, type: 'uint32' },
  { name: 'subitemid', tag: 6, type: 'uint32' },
]);

/**
 * `SCUpdatePB$SCUpdateReqComm` — tags {8,18,26,32,42,48,56,64,72}。
 *
 * plat/qver/osrelease/network/force 标 `force` —— 手Q 是显式 `set()` 的,而 proto3
 * 的默认值省略会让服务端收不到这些字段(`force=2` 尤其关键)。
 */
export const SC_UPDATE_REQ_COMM: ProtoMessage = message([
  { name: 'plat', tag: 1, type: 'uint32', force: true },
  { name: 'qver', tag: 2, type: 'bytes', force: true },
  { name: 'osrelease', tag: 3, type: 'bytes', force: true },
  { name: 'network', tag: 4, type: 'int32', force: true },
  { name: 'from', tag: 5, type: 'bytes' },
  { name: 'cookie', tag: 6, type: 'int64' },
  { name: 'appid', tag: 7, type: 'uint32' },
  { name: 'uid', tag: 8, type: 'uint64' },
  { name: 'force', tag: 9, type: 'uint32', force: true },
]);

/** `SCUpdatePB$SyncVCRReq` — tags {8,16,24,32,42}。 */
export const SYNC_VCR_REQ: ProtoMessage = message([
  { name: 'seq', tag: 1, type: 'int64' },
  { name: 'sync_mode', tag: 2, type: 'int32' },
  { name: 'plver', tag: 3, type: 'int64' },
  { name: 'rpver', tag: 4, type: 'int64' },
  { name: 'item_list', tag: 5, type: ITEM_VERSION, repeated: true },
]);

/** `SCUpdatePB$GetUrlReq` — tags {8,16,24,34}。 */
export const GET_URL_REQ: ProtoMessage = message([
  { name: 'delta_mode', tag: 1, type: 'uint32' },
  { name: 'storage_mode', tag: 2, type: 'uint32' },
  { name: 'compress_mode', tag: 3, type: 'uint32' },
  { name: 'item_list', tag: 4, type: ITEM_VERSION, repeated: true },
]);

/** `SCUpdatePB$SCUpdateReq` — tags {8,18,26,34}。 */
export const SC_UPDATE_REQ: ProtoMessage = message([
  { name: 'cmd', tag: 1, type: 'int32', force: true },
  { name: 'comm', tag: 2, type: SC_UPDATE_REQ_COMM },
  { name: 'req0x01', tag: 3, type: SYNC_VCR_REQ },
  { name: 'req0x02', tag: 4, type: GET_URL_REQ },
]);

// ─────────────────────────── 响应 ───────────────────────────

/** `SCUpdatePB$ItemExtend` — tag {10}。 */
export const ITEM_EXTEND: ProtoMessage = message([{ name: 'app_version', tag: 1, type: 'string' }]);

/** `SCUpdatePB$UpdateInfo` — tags {8,18,26,34,40,48,56,66,72,82,88,98}。下载地址在 tag 8。 */
export const UPDATE_INFO: ProtoMessage = message([
  { name: 'bid', tag: 1, type: 'uint32' },
  { name: 'scid', tag: 2, type: 'string' },
  { name: 'dst_version', tag: 3, type: 'string' },
  { name: 'src_version', tag: 4, type: 'string' },
  { name: 'delta_mode', tag: 5, type: 'uint32' },
  { name: 'storage_mode', tag: 6, type: 'uint32' },
  { name: 'compress_mode', tag: 7, type: 'uint32' },
  { name: 'url', tag: 8, type: 'string' },
  { name: 'filesize', tag: 9, type: 'int64' },
  { name: 'filecontent', tag: 10, type: 'bytes' },
  { name: 'code', tag: 11, type: 'int32' },
  { name: 'extendinfo', tag: 12, type: ITEM_EXTEND },
]);

/** `SCUpdatePB$GetUrlRsp` — 仅 tag {18}。 */
export const GET_URL_RSP: ProtoMessage = message([
  { name: 'update_list', tag: 2, type: UPDATE_INFO, repeated: true },
]);

/** `SCUpdatePB$SCUpdateRspComm` — tags {8,16}。 */
export const SC_UPDATE_RSP_COMM: ProtoMessage = message([
  { name: 'polltime', tag: 1, type: 'int32' },
  { name: 'cookie', tag: 2, type: 'int64' },
]);

/**
 * `SCUpdatePB$SCUpdateRsp` — tags {8,18,24,34,42,50}。
 *
 * `rsp0x01`(SyncVCR 的版本表)结构未建模:它嵌套很深且我们只需要里面的 scid 文本,
 * 由 {@link scanScids} 直接扫裸字节,比跟着 PB 结构走更抗改版。
 */
export const SC_UPDATE_RSP: ProtoMessage = message([
  { name: 'ret', tag: 1, type: 'int64' },
  { name: 'msg', tag: 2, type: 'bytes' },
  { name: 'cmd', tag: 3, type: 'int32' },
  { name: 'comm', tag: 4, type: SC_UPDATE_RSP_COMM },
  { name: 'rsp0x01', tag: 5, type: message([]) },
  { name: 'rsp0x02', tag: 6, type: GET_URL_RSP },
]);
