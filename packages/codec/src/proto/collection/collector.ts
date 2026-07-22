/**
 * Weiyun collector.fcg wire schemas — the NETWORK path for 收藏.
 *
 * These are distinct from the `collection.db` blob schemas (common.ts /
 * summary.ts, tags 180xxx). The collector cgi speaks a compact protobuf with
 * low field tags, wrapped in a fixed 16-byte envelope (see service/web
 * collection.ts). Ported field-for-field from SnowLuma's proto-defs so the
 * request the server accepts and the response layout stay byte-compatible.
 *
 * Request  = envelope( head=CollectorReqHead, body=CollectorReqBody )
 * Response = envelope( head=CollectorRespHead, body=CollectorRespBody )
 */

import { ProtoField, ScalarType } from '../../core';

/** Common request header carried before every collector body. */
export const CollectorReqHead = {
  uin: ProtoField(1, ScalarType.UINT64, { optional: true }),
  sequence: ProtoField(2, ScalarType.UINT32, { optional: true }),
  commandType: ProtoField(3, ScalarType.UINT32, { optional: true }),
  operationId: ProtoField(4, ScalarType.UINT32, { optional: true }),
  clientVersion: ProtoField(5, ScalarType.UINT64, { optional: true }),
  platform: ProtoField(6, ScalarType.UINT32, { optional: true }),
  ticketType: ProtoField(7, ScalarType.UINT32, { optional: true }),
  reserved: ProtoField(10, ScalarType.UINT32, { optional: true }),
  /** p_skey for weiyun.com. */
  ticket: ProtoField(11, ScalarType.STRING, { optional: true }),
  field14: ProtoField(14, ScalarType.UINT32, { optional: true }),
  field15: ProtoField(15, ScalarType.UINT32, { optional: true }),
};

/** Body of operation 20000 (list collection items). */
export const GetCollectionListReq = {
  field1: ProtoField(1, ScalarType.UINT32, { optional: true }),
  field2: ProtoField(2, ScalarType.UINT32, { optional: true }),
  field3: ProtoField(3, ScalarType.UINT32, { optional: true }),
  /** Pagination cursor (starts at u64 max; strictly decreasing modifyTime). */
  timeStamp: ProtoField(4, ScalarType.UINT64, { optional: true }),
  orderType: ProtoField(5, ScalarType.UINT32, { optional: true }),
  groupId: ProtoField(6, ScalarType.UINT64, { optional: true }),
  count: ProtoField(7, ScalarType.UINT32, { optional: true }),
  searchDown: ProtoField(8, ScalarType.UINT32, { optional: true }),
  field9: ProtoField(9, ScalarType.UINT32, { optional: true }),
};

export const CollectorReqOperation = {
  getCollectionList: ProtoField(20000, () => GetCollectionListReq, { optional: true }),
};

export const CollectorReqBody = {
  operation: ProtoField(1, () => CollectorReqOperation, { optional: true }),
};

/** Common response header. */
export const CollectorRespHead = {
  trace: ProtoField(1, ScalarType.STRING, { optional: true }),
  retCode: ProtoField(101, ScalarType.INT32, { optional: true }),
  retMsg: ProtoField(102, ScalarType.STRING, { optional: true }),
  promptMsg: ProtoField(103, ScalarType.STRING, { optional: true }),
};

/** Author/owner identity in the network payload (low tags, not the db 18504+). */
export const CollectorAuthor = {
  type: ProtoField(1, ScalarType.UINT32, { optional: true }),
  numId: ProtoField(2, ScalarType.UINT64, { optional: true }),
  strId: ProtoField(3, ScalarType.STRING, { optional: true }),
  groupId: ProtoField(4, ScalarType.UINT64, { optional: true }),
  groupName: ProtoField(5, ScalarType.STRING, { optional: true }),
  uid: ProtoField(6, ScalarType.STRING, { optional: true }),
};

/** Image descriptor (network payload). */
export const CollectorPicInfo = {
  url: ProtoField(1, ScalarType.STRING, { optional: true }),
  md5: ProtoField(2, ScalarType.BYTES, { optional: true }),
  sha1: ProtoField(3, ScalarType.BYTES, { optional: true }),
  name: ProtoField(4, ScalarType.STRING, { optional: true }),
  note: ProtoField(5, ScalarType.STRING, { optional: true }),
  width: ProtoField(6, ScalarType.UINT32, { optional: true }),
  height: ProtoField(7, ScalarType.UINT32, { optional: true }),
  size: ProtoField(8, ScalarType.UINT32, { optional: true }),
  type: ProtoField(9, ScalarType.UINT32, { optional: true }),
  owner: ProtoField(10, () => CollectorAuthor, { optional: true }),
  picId: ProtoField(11, ScalarType.STRING, { optional: true }),
};

/** Stored-file descriptor (network payload). */
export const CollectorFileInfo = {
  src: ProtoField(1, ScalarType.UINT32, { optional: true }),
  uid: ProtoField(2, ScalarType.UINT64, { optional: true }),
  bid: ProtoField(3, ScalarType.UINT32, { optional: true }),
  fid: ProtoField(4, ScalarType.STRING, { optional: true }),
  name: ProtoField(5, ScalarType.STRING, { optional: true }),
  size: ProtoField(6, ScalarType.UINT64, { optional: true }),
  md5: ProtoField(7, ScalarType.BYTES, { optional: true }),
  sha1: ProtoField(8, ScalarType.BYTES, { optional: true }),
  category: ProtoField(9, ScalarType.UINT32, { optional: true }),
  ntUid: ProtoField(10, ScalarType.STRING, { optional: true }),
};

/** type 1 — plain text. */
export const CollectorTextSummary = {
  text: ProtoField(1, ScalarType.STRING, { optional: true }),
  truncated: ProtoField(2, ScalarType.BOOL, { optional: true }),
};

/** type 8 — rich media. */
export const CollectorRichMediaSummary = {
  title: ProtoField(1, ScalarType.STRING, { optional: true }),
  subTitle: ProtoField(2, ScalarType.STRING, { optional: true }),
  brief: ProtoField(3, ScalarType.STRING, { optional: true }),
  picList: ProtoField(4, () => CollectorPicInfo, { optional: true, repeat: true }),
  contentType: ProtoField(5, ScalarType.UINT32, { optional: true }),
  originalUri: ProtoField(6, ScalarType.STRING, { optional: true }),
  publisher: ProtoField(7, ScalarType.STRING, { optional: true }),
  richMediaVersion: ProtoField(8, ScalarType.UINT32, { optional: true }),
};

/** type 3 — gallery. */
export const CollectorGallerySummary = {
  picList: ProtoField(1, () => CollectorPicInfo, { optional: true, repeat: true }),
  field2: ProtoField(2, ScalarType.STRING, { optional: true }),
};

/** type 4 — audio. */
export const CollectorAudioSummary = {
  duration: ProtoField(1, ScalarType.UINT32, { optional: true }),
  field2: ProtoField(2, ScalarType.STRING, { optional: true }),
  field3: ProtoField(3, ScalarType.STRING, { optional: true }),
};

/** type 5 — video. */
export const CollectorVideoSummary = {
  field1: ProtoField(1, ScalarType.STRING, { optional: true }),
  field2: ProtoField(2, ScalarType.UINT32, { optional: true }),
  field3: ProtoField(3, ScalarType.UINT32, { optional: true }),
  field10: ProtoField(10, ScalarType.UINT32, { optional: true }),
  field20: ProtoField(20, ScalarType.UINT32, { optional: true }),
  picture: ProtoField(21, () => CollectorPicInfo, { optional: true }),
  field30: ProtoField(30, ScalarType.UINT32, { optional: true }),
  file: ProtoField(31, () => CollectorFileInfo, { optional: true }),
};

/** type 6 — file. */
export const CollectorFileSummary = {
  first: ProtoField(1, () => CollectorFileInfo, { optional: true }),
  second: ProtoField(2, () => CollectorFileInfo, { optional: true }),
};

/** type 7 — location. lat/lng/alt are doubles. */
export const CollectorLocationSummary = {
  name: ProtoField(1, ScalarType.STRING, { optional: true }),
  latitude: ProtoField(2, ScalarType.DOUBLE, { optional: true }),
  longitude: ProtoField(3, ScalarType.DOUBLE, { optional: true }),
  altitude: ProtoField(4, ScalarType.DOUBLE, { optional: true }),
  field5: ProtoField(5, ScalarType.STRING, { optional: true }),
  field6: ProtoField(6, ScalarType.STRING, { optional: true }),
};

/** type 2 — link. Real wire layout verified against 9 live samples:
 *  f1=url  f2=title  f3=publisher  f4=brief(string)  f5=picList(msg)  f6=contentType  f7=field7 */
export const CollectorLinkSummary = {
  url: ProtoField(1, ScalarType.STRING, { optional: true }),
  title: ProtoField(2, ScalarType.STRING, { optional: true }),
  publisher: ProtoField(3, ScalarType.STRING, { optional: true }),
  brief: ProtoField(4, ScalarType.STRING, { optional: true }),
  picList: ProtoField(5, () => CollectorPicInfo, { optional: true, repeat: true }),
  contentType: ProtoField(6, ScalarType.UINT32, { optional: true }),
  field7: ProtoField(7, ScalarType.STRING, { optional: true }),
};

/**
 * Content union. **Field tag == collection `type`** —— 真机验证(50 条):type 2
 * 的数据在 field 2、type 8 在 field 8,与 db 侧 union(180649+type)自洽。注意
 * SnowLuma proto-defs 把 field 2/8 命名反了(标成 richMedia/link),照抄会导致
 * link↔richMedia 错位、前端读 null 崩溃。这里按 tag=type 修正。
 */
export const CollectorSummary = {
  textSummary: ProtoField(1, () => CollectorTextSummary, { optional: true }),
  linkSummary: ProtoField(2, () => CollectorLinkSummary, { optional: true }),
  gallerySummary: ProtoField(3, () => CollectorGallerySummary, { optional: true }),
  audioSummary: ProtoField(4, () => CollectorAudioSummary, { optional: true }),
  videoSummary: ProtoField(5, () => CollectorVideoSummary, { optional: true }),
  fileSummary: ProtoField(6, () => CollectorFileSummary, { optional: true }),
  locationSummary: ProtoField(7, () => CollectorLocationSummary, { optional: true }),
  richMediaSummary: ProtoField(8, () => CollectorRichMediaSummary, { optional: true }),
};

/** One collection item as returned by collector.fcg. */
export const CollectorItem = {
  cid: ProtoField(1, ScalarType.STRING, { optional: true }),
  type: ProtoField(2, ScalarType.UINT32, { optional: true }),
  status: ProtoField(3, ScalarType.UINT32, { optional: true }),
  author: ProtoField(4, () => CollectorAuthor, { optional: true }),
  bid: ProtoField(5, ScalarType.UINT32, { optional: true }),
  category: ProtoField(8, ScalarType.UINT32, { optional: true }),
  createTime: ProtoField(9, ScalarType.UINT64, { optional: true }),
  collectTime: ProtoField(10, ScalarType.UINT64, { optional: true }),
  modifyTime: ProtoField(11, ScalarType.UINT64, { optional: true }),
  sequence: ProtoField(12, ScalarType.UINT64, { optional: true }),
  summary: ProtoField(15, () => CollectorSummary, { optional: true }),
  shareUrl: ProtoField(18, ScalarType.STRING, { optional: true }),
  customGroupId: ProtoField(20, ScalarType.UINT32, { optional: true }),
  securityBeat: ProtoField(21, ScalarType.BOOL, { optional: true }),
};

/** Body of operation 20000 in a response. */
export const GetCollectionListResp = {
  items: ProtoField(1, () => CollectorItem, { optional: true, repeat: true }),
  totalCount: ProtoField(2, ScalarType.UINT32, { optional: true }),
  reachedBottom: ProtoField(3, ScalarType.UINT32, { optional: true }),
};

export const CollectorRespOperation = {
  getCollectionList: ProtoField(20000, () => GetCollectionListResp, { optional: true }),
};

/** Response operation lives under field 2 (request uses field 1). */
export const CollectorRespBody = {
  operation: ProtoField(2, () => CollectorRespOperation, { optional: true }),
};
