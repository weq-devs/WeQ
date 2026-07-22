/**
 * Weiyun collector.fcg network path for 收藏 (QQ favorites).
 *
 * 收藏 后端就是微云 collector 网关。凭据用 weiyun.com 的 p_skey,但鉴权不是标准
 * cookie jar,而是 collector 专用的 `uin/vt/vi/appid` 四段。报文包在一个固定 16
 * 字节信封里(magic + version + 长度 + head/body 两段 protobuf)。
 *
 * 分页游标是 timeStamp:初值 u64 max,每页取本页最小 modifyTime 作为下一页游标
 * (严格递减),直到 reachedBottom=1。逻辑照 SnowLuma 复刻。
 *
 * 输出统一映射成 `@weq/db` 的 `CollectionItem` 形状,让前端 / tRPC serde 零改动。
 */

import { type CollectionItem, type CollectionKind, decodeMessage } from '@weq/db';
import { ProtoMsg, type ProtoDecodeStructType } from '@weq/codec';
import {
  CollectorReqHead,
  CollectorReqBody,
  CollectorRespHead,
  CollectorRespBody,
} from '@weq/codec/proto/collection/index';
import type { WebCredential } from './credential';

const ENDPOINT = 'https://collector.weiyun.com/collector.fcg';
const HOST = 'collector.weiyun.com';
const OPERATION_ID = 20_000;
const TICKET_TYPE = 27;
const APP_ID = 5_004;
const PAGE_SIZE = 50;
const MAX_PAGES = 100;
const REQUEST_TIMEOUT_MS = 10_000;
const OPERATION_TIMEOUT_MS = 60_000;
const CLIENT_VERSION = 0x6105f5e164fn;
const INITIAL_TIMESTAMP = 0xffff_ffff_ffff_ffffn;
const MAGIC = Uint8Array.from([0x20, 0x13, 0x03, 0x29]);
const VERSION = Uint8Array.from([0x00, 0x01]);

const reqHead = new ProtoMsg(CollectorReqHead);
const reqBody = new ProtoMsg(CollectorReqBody);
// 响应解码走 lenient assembler(@weq/db decodeMessage),不用 ProtoMsg.decode:
// collector 的 body(尤其 picList / locationSummary)带尾部 0x00 填充,strict
// protobuf-ts 会崩「unterminated group」;lenient walker 解不动就停,免疫填充。
type RespHead = ProtoDecodeStructType<typeof CollectorRespHead>;
type RespBody = ProtoDecodeStructType<typeof CollectorRespBody>;

const KIND_BY_TYPE: Record<number, CollectionKind> = {
  1: 'text',
  2: 'link',
  3: 'gallery',
  4: 'audio',
  5: 'video',
  6: 'file',
  7: 'location',
  8: 'richMedia',
};

export interface NetworkCollectionPage {
  items: CollectionItem[];
  hasMore: boolean;
}

function encodeEnvelope(head: Uint8Array, body: Uint8Array): Uint8Array {
  const total = 16 + head.length + body.length;
  const out = Buffer.allocUnsafe(total);
  out.set(MAGIC, 0);
  out.set(VERSION, 4);
  out.writeUInt32BE(total, 6);
  out.writeUInt32BE(body.length, 10);
  out.writeUInt16BE(0, 14);
  out.set(head, 16);
  out.set(body, 16 + head.length);
  return out;
}

function decodeEnvelope(bytes: Uint8Array): { head: RespHead; body: RespBody } {
  const input = Buffer.from(bytes);
  if (input.length <= 16) throw new Error('collection response is too short');
  if (!input.subarray(0, 4).equals(Buffer.from(MAGIC))) {
    throw new Error('collection response has invalid magic');
  }
  const total = input.readUInt32BE(6);
  if (total !== input.length) {
    throw new Error(`collection response length mismatch: ${total} != ${input.length}`);
  }
  const bodyLength = input.readUInt32BE(10);
  if (bodyLength === 0 || bodyLength >= total - 16) {
    throw new Error('collection response has invalid body length');
  }
  const bodyOffset = total - bodyLength;
  return {
    head: decodeMessage(input.subarray(16, bodyOffset), CollectorRespHead) as RespHead,
    body: decodeMessage(input.subarray(bodyOffset), CollectorRespBody) as RespBody,
  };
}

function requestBytes(uin: bigint, pskey: string, sequence: number, timeStamp: bigint): Uint8Array {
  const head = reqHead.encode({
    uin,
    sequence,
    commandType: 1,
    operationId: OPERATION_ID,
    clientVersion: CLIENT_VERSION,
    platform: 4,
    ticketType: TICKET_TYPE,
    ticket: pskey,
    field14: 8,
    field15: 9,
  });
  // collector 网关严格:多发零值字段会被判「缺少请求参数」(190013)。只发非零字段,
  // 与 SnowLuma(proto3 省略零值)的字节保持一致。
  const body = reqBody.encode({
    operation: {
      getCollectionList: {
        timeStamp,
        orderType: 2,
        count: PAGE_SIZE,
        searchDown: 1,
      },
    },
  });
  return encodeEnvelope(head, body);
}

type WireItem = NonNullable<
  NonNullable<NonNullable<RespBody['operation']>['getCollectionList']>['items']
>[number];
type WireSummary = NonNullable<WireItem['summary']>;
type WirePic = NonNullable<NonNullable<WireSummary['richMediaSummary']>['picList']>[number];
type WireFile = NonNullable<NonNullable<WireSummary['fileSummary']>['first']>;

/** Map a collector wire item onto the db `CollectionItem` shape (ms times). */
function mapItem(item: WireItem): CollectionItem {
  const type = Number(item.type ?? 0);
  const a = item.author;
  const author = a
    ? {
        groupId: a.groupId,
        groupName: a.groupName,
        uid: a.uid,
        type: a.type === undefined ? undefined : Number(a.type),
        numId: a.numId,
        strId: a.strId,
      }
    : null;

  const s = item.summary ?? {};
  const summary = {
    textSummary: s.textSummary ? { text: s.textSummary.text } : undefined,
    linkSummary: s.linkSummary
      ? {
          url: s.linkSummary.url,
          title: s.linkSummary.title,
          publisher: s.linkSummary.publisher,
          brief: s.linkSummary.brief,
          picList: (s.linkSummary.picList ?? []).map(mapPic),
          type: s.linkSummary.contentType === undefined ? undefined : Number(s.linkSummary.contentType),
        }
      : undefined,
    gallerySummary: s.gallerySummary
      ? { picList: (s.gallerySummary.picList ?? []).map(mapPic) }
      : undefined,
    audioSummary: s.audioSummary
      ? { duration: s.audioSummary.duration === undefined ? undefined : Number(s.audioSummary.duration) }
      : undefined,
    videoSummary: s.videoSummary
      ? {
          title: s.videoSummary.field1,
          previewPicInfo: s.videoSummary.picture ? mapPic(s.videoSummary.picture) : undefined,
          storeFileInfo: s.videoSummary.file ? mapFile(s.videoSummary.file) : undefined,
        }
      : undefined,
    fileSummary: s.fileSummary
      ? {
          fileInfo: s.fileSummary.first ? mapFile(s.fileSummary.first) : undefined,
          srcFileInfo: s.fileSummary.second ? mapFile(s.fileSummary.second) : undefined,
        }
      : undefined,
    locationSummary: s.locationSummary
      ? {
          name: s.locationSummary.name,
          latitude: s.locationSummary.latitude,
          longitude: s.locationSummary.longitude,
          altitude: s.locationSummary.altitude,
        }
      : undefined,
    richMediaSummary: s.richMediaSummary
      ? {
          title: s.richMediaSummary.title,
          subTitle: s.richMediaSummary.subTitle,
          brief: s.richMediaSummary.brief,
          picList: (s.richMediaSummary.picList ?? []).map(mapPic),
          contentType:
            s.richMediaSummary.contentType === undefined ? undefined : Number(s.richMediaSummary.contentType),
          originalUri: s.richMediaSummary.originalUri,
          publisher: s.richMediaSummary.publisher,
          richMediaVersion:
            s.richMediaSummary.richMediaVersion === undefined
              ? undefined
              : Number(s.richMediaSummary.richMediaVersion),
        }
      : undefined,
  };

  return {
    cid: item.cid ?? '',
    type,
    kind: KIND_BY_TYPE[type] ?? 'unknown',
    createTime: Number(item.createTime ?? 0n),
    collectTime: Number(item.collectTime ?? 0n),
    modifyTime: Number(item.modifyTime ?? 0n),
    author,
    summary,
  };
}

function mapPic(p: WirePic) {
  return {
    uri: p.url,
    md5: p.md5,
    sha1: p.sha1,
    name: p.name,
    note: p.note,
    width: p.width === undefined ? undefined : Number(p.width),
    height: p.height === undefined ? undefined : Number(p.height),
    size: p.size === undefined ? undefined : Number(p.size),
    type: p.type === undefined ? undefined : Number(p.type),
    picId: p.picId,
  };
}

function mapFile(f: WireFile) {
  return {
    src: f.src === undefined ? undefined : Number(f.src),
    uid: f.uid,
    bid: f.bid === undefined ? undefined : Number(f.bid),
    fid: f.fid,
    name: f.name,
    size: f.size,
    md5: f.md5,
    sha1: f.sha1,
    category: f.category === undefined ? undefined : Number(f.category),
    ntUid: f.ntUid,
  };
}

async function postCollector(body: Uint8Array, uin: string, pskey: string, timeoutMs: number): Promise<Uint8Array> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        Cookie: `uin=${uin};vt=${TICKET_TYPE};vi=${pskey};appid=${APP_ID}`,
        Host: HOST,
        Range: 'bytes=0-',
      },
      body: Buffer.from(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`collection cgi ${res.status} ${res.statusText}`);
    return new Uint8Array(await res.arrayBuffer());
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`collection request timed out after ${timeoutMs}ms`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pull the account's 收藏 from the collector network path, following the
 * timeStamp cursor until `wanted` items are collected or the server reports
 * bottom. Throws on any network / service error (no silent fallback — the
 * caller decides db fallback based on credential availability).
 *
 * `wanted` is the number of items the caller ultimately needs (offset+limit),
 * so a paged UI backed by network can request everything up to its window.
 */
export async function getCollectionListNetwork(
  cred: WebCredential,
  wanted: number,
): Promise<NetworkCollectionPage> {
  if (!cred.pskey) throw new Error('collection p_skey is empty (weiyun.com)');
  const uin = BigInt(cred.uin);
  const target = Math.max(1, wanted);

  const items: CollectionItem[] = [];
  const seen = new Set<string>();
  let sequence = 1;
  let timeStamp = INITIAL_TIMESTAMP;
  let serverHasMore = true;
  let pages = 0;
  const deadline = Date.now() + OPERATION_TIMEOUT_MS;

  while (items.length < target && serverHasMore) {
    if (pages >= MAX_PAGES) throw new Error(`collection pagination exceeded ${MAX_PAGES} pages`);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`collection pagination exceeded ${OPERATION_TIMEOUT_MS}ms`);
    pages += 1;

    const responseBytes = await postCollector(
      requestBytes(uin, cred.pskey, sequence, timeStamp),
      cred.uin,
      cred.pskey,
      Math.min(REQUEST_TIMEOUT_MS, remaining),
    );
    const { head, body } = decodeEnvelope(responseBytes);
    const retCode = head.retCode ?? 0;
    if (retCode !== 0) {
      throw new Error(`collection service error ${retCode}: ${head.retMsg || head.promptMsg || 'unknown'}`);
    }

    const page = body.operation?.getCollectionList;
    if (!page) throw new Error('collection response is missing operation 20000');
    const wireItems = page.items ?? [];
    serverHasMore = (page.reachedBottom ?? 0) === 0;

    let nextCursor: bigint | null = null;
    for (const wireItem of wireItems) {
      const modifyTime = wireItem.modifyTime ?? 0n;
      if (nextCursor === null || modifyTime < nextCursor) nextCursor = modifyTime;
      const cid = wireItem.cid ?? '';
      if (!cid || seen.has(cid)) continue;
      seen.add(cid);
      items.push(mapItem(wireItem));
    }

    if (items.length >= target || !serverHasMore) break;
    if (wireItems.length === 0 || nextCursor === null || nextCursor === 0n) {
      throw new Error('collection pagination made no progress while more data was reported');
    }
    if (nextCursor >= timeStamp) {
      throw new Error(`collection pagination cursor did not decrease: ${nextCursor}`);
    }
    timeStamp = nextCursor;
    sequence += 1;
  }

  return { items, hasMore: serverHasMore || items.length > target };
}
