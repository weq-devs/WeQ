/**
 * Weiyun collector.fcg network path for 收藏 (QQ favorites).
 *
 * 收藏 后端就是微云 collector 网关。凭据用 weiyun.com 的 p_skey,但鉴权不是标准
 * cookie jar,而是 collector 专用的 `uin/vt/vi/appid` 四段。报文包在一个固定 16
 * 字节信封里(magic + version + 长度 + head/body 两段 protobuf)。
 *
 * 分页游标是 timeStamp:初值 u64 max,每页取本页最小 modifyTime 作为下一页游标
 * (严格递减),直到已验证的 reachedBottom=1 或 215000。
 *
 * 输出统一映射成 `@weq/db` 的 `CollectionItem` 形状,让前端 / tRPC serde 零改动。
 */

import {
  type CollectionCachedContent,
  type CollectionFileInfo,
  type CollectionItem,
  type CollectionKind,
  type CollectionPicInfo,
  decodeMessage,
} from '@weq/db';
import { ProtoMsg, type ProtoDecodeStructType } from '@weq/codec';
import {
  CollectorReqHead,
  CollectorReqBody,
  CollectorRespHead,
  CollectorRespBody,
} from '@weq/codec/proto/collection/index';
import type { WebCredential } from './credential';
import { WEB_READ_RETRY, webRequestBytes, WebRequestError } from './http';

const ENDPOINT = 'https://collector.weiyun.com/collector.fcg';
const HOST = 'collector.weiyun.com';
const OPERATION_ID = 20_000;
const CONTENT_OPERATION_ID = 20_001;
const TICKET_TYPE = 27;
const APP_ID = 5_004;
const PAGE_SIZE = 50;
const MAX_PAGES = 100;
const REQUEST_TIMEOUT_MS = 10_000;
const OPERATION_TIMEOUT_MS = 60_000;
const CLIENT_VERSION = 0x6105f5e164fn;
const INITIAL_TIMESTAMP = 0xffff_ffff_ffff_ffffn;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_DETAIL_CIDS = 20;
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

/** Serializable continuation for a single collector request, safe to checkpoint. */
export interface CollectionNetworkCursor {
  timeStamp: string;
  sequence: number;
}

export interface CollectionHttpRequest {
  url: string;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
  signal: AbortSignal;
}

export type CollectionTransport = (request: CollectionHttpRequest) => Promise<Uint8Array>;

export interface CollectionNetworkOptions {
  transport?: CollectionTransport;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Awaited before decoding, so unknown fields and failed responses can be archived. */
  onRawResponse?: (capture: {
    sequence: number;
    requestTimeStamp: string;
    response: Uint8Array;
  }) => void | Promise<void>;
}

export interface CollectionDetailNetworkOptions
  extends Omit<CollectionNetworkOptions, 'onRawResponse'> {
  onRawResponse?: (capture: {
    cids: readonly string[];
    response: Uint8Array;
  }) => void | Promise<void>;
}

export interface CollectionNetworkDetail {
  cid: string;
  content: CollectionCachedContent;
}

export interface NetworkCollectionCursorPage extends NetworkCollectionPage {
  /** Null for the observed terminal markers 1 and 215000. */
  nextCursor: CollectionNetworkCursor | null;
  /** Server-reported list count, when present; not proof of complete content. */
  totalCount: number | null;
  /** Exact collector envelope used to build this page. */
  rawResponse: Uint8Array;
}

export function encodeEnvelope(head: Uint8Array, body: Uint8Array): Uint8Array {
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

function requestHeadBytes(
  uin: bigint,
  pskey: string,
  sequence: number,
  operationId: number,
): Uint8Array {
  return reqHead.encode({
    uin,
    sequence,
    commandType: 1,
    operationId,
    clientVersion: CLIENT_VERSION,
    platform: 4,
    ticketType: TICKET_TYPE,
    ticket: pskey,
    field14: 8,
    field15: 9,
  });
}

function requestBytes(uin: bigint, pskey: string, sequence: number, timeStamp: bigint): Uint8Array {
  const head = requestHeadBytes(uin, pskey, sequence, OPERATION_ID);
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

function detailRequestBytes(uin: bigint, pskey: string, cids: readonly string[]): Uint8Array {
  const head = requestHeadBytes(uin, pskey, 1, CONTENT_OPERATION_ID);
  const body = reqBody.encode({
    operation: { getCollectionContent: { cidList: [...cids] } },
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
    textSummary: s.textSummary
      ? { text: s.textSummary.text, truncated: s.textSummary.truncated }
      : undefined,
    linkSummary: s.linkSummary
      ? {
          url: s.linkSummary.url,
          title: s.linkSummary.title,
          publisher: s.linkSummary.publisher,
          brief: s.linkSummary.brief,
          picList: (s.linkSummary.picList ?? []).map(mapPic),
          type:
            s.linkSummary.contentType === undefined ? undefined : Number(s.linkSummary.contentType),
        }
      : undefined,
    gallerySummary: s.gallerySummary
      ? { picList: (s.gallerySummary.picList ?? []).map(mapPic) }
      : undefined,
    audioSummary: s.audioSummary
      ? {
          duration:
            s.audioSummary.duration === undefined ? undefined : Number(s.audioSummary.duration),
        }
      : undefined,
    videoSummary: s.videoSummary
      ? {
          title: s.videoSummary.field1,
          duration: s.videoSummary.field2,
          format: s.videoSummary.field3,
          category: s.videoSummary.field10,
          previewType: s.videoSummary.field20,
          storeType: s.videoSummary.field30,
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
            s.richMediaSummary.contentType === undefined
              ? undefined
              : Number(s.richMediaSummary.contentType),
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
    sequence: item.sequence?.toString(),
    nativeModifyTime: item.modifyTime?.toString(),
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

type WireDetail = NonNullable<
  NonNullable<NonNullable<RespBody['operation']>['getCollectionContent']>['contents']
>[number];

function decodeUtf8(bytes: Uint8Array | undefined): string | undefined {
  if (!bytes) return undefined;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function mapDetail(content: WireDetail): CollectionCachedContent {
  const detail: CollectionCachedContent = { recordTime: Date.now() };
  if (content.textContent) {
    detail.textContent = {
      data: content.textContent.data ?? '',
      hasEmoji: content.textContent.hasEmoji,
    };
  }
  if (content.linkContent) detail.link = content.linkContent;
  if (content.galleryContent) detail.gallery = content.galleryContent;
  if (content.audioContent?.data) {
    detail.audio = content.audioContent.data;
    const data = decodeUtf8(content.audioContent.data);
    if (data !== undefined) detail.audioContent = { data };
  }
  if (content.videoContent) detail.video = content.videoContent;
  if (content.fileContent) detail.file = content.fileContent;
  if (content.locationContent) detail.location = content.locationContent;
  if (content.richMediaContent) {
    const rich = content.richMediaContent;
    // Retain structured content even when the service supplies no HTML body.
    // A successful structured response must not look like an empty detail.
    if (rich.rawData ?? rich.richMedia) detail.richMedia = rich.rawData ?? rich.richMedia;
    detail.richMediaContent = {
      rawData: decodeUtf8(rich.rawData),
      bizDataList: (rich.bizDataList ?? [])
        .map(decodeUtf8)
        .filter((value): value is string => value !== undefined),
      picList: (rich.picList ?? []).map(mapPic) as CollectionPicInfo[],
      fileList: (rich.fileList ?? []).map(mapFile) as CollectionFileInfo[],
    };
  }
  return detail;
}

async function defaultTransport(
  request: CollectionHttpRequest,
  timeoutMs: number,
): Promise<Uint8Array> {
  const { Cookie, ...headers } = request.headers;
  return webRequestBytes(request.url, {
    method: 'POST',
    cookie: Cookie ?? '',
    headers,
    body: request.body,
    signal: request.signal,
    timeoutMs,
    maxResponseBytes: MAX_RESPONSE_BYTES,
    retry: WEB_READ_RETRY,
  });
}

export async function postCollector(
  body: Uint8Array,
  cred: WebCredential,
  opts: Pick<CollectionNetworkOptions, 'transport' | 'signal' | 'timeoutMs'>,
): Promise<Uint8Array> {
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('collection timeout must be a positive integer');
  }
  opts.signal?.throwIfAborted();
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(opts.signal?.reason);
  opts.signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error(`collection request timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  let rejectOnAbort: (() => void) | undefined;
  try {
    const request: CollectionHttpRequest = {
      url: ENDPOINT,
      headers: {
        'Content-Type': 'application/octet-stream',
        Cookie: `uin=${cred.uin};vt=${TICKET_TYPE};vi=${cred.pskey};appid=${APP_ID}`,
        Host: HOST,
        Range: 'bytes=0-',
      },
      body,
      signal: controller.signal,
    };
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectOnAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', rejectOnAbort, { once: true });
    });
    const response = await Promise.race([
      opts.transport ? opts.transport(request) : defaultTransport(request, timeoutMs),
      aborted,
    ]);
    controller.signal.throwIfAborted();
    if (response.length > MAX_RESPONSE_BYTES)
      throw new Error('collection response exceeds size limit');
    return response;
  } catch (error) {
    if (controller.signal.aborted) {
      if (opts.signal?.aborted)
        throw new WebRequestError('cancelled', '收藏请求已取消。', { cause: opts.signal.reason });
      throw new WebRequestError('timeout', `collection request timed out after ${timeoutMs}ms`, {
        cause: error,
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (rejectOnAbort) controller.signal.removeEventListener('abort', rejectOnAbort);
    opts.signal?.removeEventListener('abort', abortFromCaller);
  }
}

/** Fetch one bounded batch of full collection bodies (operation 20001). */
export async function getCollectionDetailsNetwork(
  cred: WebCredential,
  cids: readonly string[],
  opts: CollectionDetailNetworkOptions = {},
): Promise<CollectionNetworkDetail[]> {
  if (!/^[1-9]\d*$/.test(cred.uin)) throw new Error('collection uin must be a positive integer');
  const uin = BigInt(cred.uin);
  if (uin > INITIAL_TIMESTAMP) throw new Error('collection uin exceeds uint64');
  if (!cred.pskey || /[\r\n;]/.test(cred.pskey))
    throw new Error('collection p_skey is empty or invalid (weiyun.com)');
  if (cids.length < 1 || cids.length > MAX_DETAIL_CIDS) {
    throw new Error(`collection detail batch must contain 1-${MAX_DETAIL_CIDS} ids`);
  }
  const unique = new Set<string>();
  for (const cid of cids) {
    const hasControl = [...cid].some((char) => {
      const code = char.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    });
    if (!cid || cid.length > 256 || hasControl) throw new Error('collection detail cid is invalid');
    if (unique.has(cid)) throw new Error('collection detail batch contains duplicate ids');
    unique.add(cid);
  }

  const response = await postCollector(detailRequestBytes(uin, cred.pskey, cids), cred, opts);
  await opts.onRawResponse?.({ cids, response });
  const { head, body } = decodeEnvelope(response);
  const retCode = head.retCode ?? 0;
  if (retCode !== 0) {
    throw new Error(
      `collection service error ${retCode}: ${head.retMsg || head.promptMsg || 'unknown'}`,
    );
  }
  const contents = body.operation?.getCollectionContent?.contents;
  if (!contents) throw new Error('collection response is missing operation 20001');
  if (contents.length !== cids.length) {
    throw new Error(`collection detail count mismatch: ${contents.length} != ${cids.length}`);
  }
  return contents.map((content, index) => ({ cid: cids[index]!, content: mapDetail(content) }));
}

/**
 * One authenticated POST, with a resumable cursor and no local-db fallback.
 * This endpoint returns list summaries; raw protobuf preserves additional fields,
 * but it does not establish that favorite bodies or attachment originals are complete.
 */
export async function getCollectionPageNetwork(
  cred: WebCredential,
  cursor: CollectionNetworkCursor | null = null,
  opts: CollectionNetworkOptions = {},
): Promise<NetworkCollectionCursorPage> {
  if (!/^[1-9]\d*$/.test(cred.uin)) throw new Error('collection uin must be a positive integer');
  const uin = BigInt(cred.uin);
  if (uin > INITIAL_TIMESTAMP) throw new Error('collection uin exceeds uint64');
  if (!cred.pskey || /[\r\n;]/.test(cred.pskey))
    throw new Error('collection p_skey is empty or invalid (weiyun.com)');
  const timeStampText = cursor?.timeStamp ?? INITIAL_TIMESTAMP.toString();
  if (!/^\d+$/.test(timeStampText)) throw new Error('collection cursor timestamp is invalid');
  const timeStamp = BigInt(timeStampText);
  if (timeStamp <= 0n || timeStamp > INITIAL_TIMESTAMP)
    throw new Error('collection cursor timestamp exceeds uint64');
  const sequence = cursor?.sequence ?? 1;
  if (!Number.isSafeInteger(sequence) || sequence <= 0 || sequence >= 0xffff_ffff) {
    throw new Error('collection cursor sequence is invalid');
  }
  const response = await postCollector(
    requestBytes(uin, cred.pskey, sequence, timeStamp),
    cred,
    opts,
  );
  await opts.onRawResponse?.({ sequence, requestTimeStamp: timeStamp.toString(), response });
  const { head, body } = decodeEnvelope(response);
  const retCode = head.retCode ?? 0;
  if (retCode !== 0) {
    throw new Error(
      `collection service error ${retCode}: ${head.retMsg || head.promptMsg || 'unknown'}`,
    );
  }
  const page = body.operation?.getCollectionList;
  if (!page) throw new Error('collection response is missing operation 20000');
  if (page.reachedBottom !== undefined && ![0, 1, 215000].includes(page.reachedBottom)) {
    throw new Error('collection response has an invalid reachedBottom flag');
  }
  // The real final page returns 215000 (20 remaining items), whereas synthetic
  // and older responses use one. Unknown nonzero markers remain reviewable.
  const hasMore = page.reachedBottom !== 1 && page.reachedBottom !== 215000;
  const wireItems = page.items ?? [];
  const seen = new Set<string>();
  const items: CollectionItem[] = [];
  let nextTimeStamp: bigint | null = null;
  for (const item of wireItems) {
    const modifyTime = item.modifyTime ?? 0n;
    if (nextTimeStamp === null || modifyTime < nextTimeStamp) nextTimeStamp = modifyTime;
    if (!item.cid) throw new Error('collection response contains an item with no cid');
    if (!seen.has(item.cid)) {
      seen.add(item.cid);
      items.push(mapItem(item));
    }
  }
  if (hasMore && (nextTimeStamp === null || nextTimeStamp <= 0n || nextTimeStamp >= timeStamp)) {
    throw new Error('collection pagination made no progress while more data was reported');
  }
  return {
    items,
    hasMore,
    nextCursor: hasMore ? { timeStamp: nextTimeStamp!.toString(), sequence: sequence + 1 } : null,
    totalCount: page.totalCount === undefined ? null : Number(page.totalCount),
    rawResponse: response,
  };
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
  opts: CollectionNetworkOptions = {},
): Promise<NetworkCollectionPage> {
  if (!Number.isSafeInteger(wanted)) throw new Error('collection wanted count must be an integer');
  const target = Math.max(1, wanted);

  const items: CollectionItem[] = [];
  const seen = new Set<string>();
  let cursor: CollectionNetworkCursor | null = null;
  let serverHasMore = true;
  let pages = 0;
  const deadline = Date.now() + OPERATION_TIMEOUT_MS;

  while (items.length < target && serverHasMore) {
    if (pages >= MAX_PAGES) throw new Error(`collection pagination exceeded ${MAX_PAGES} pages`);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`collection pagination exceeded ${OPERATION_TIMEOUT_MS}ms`);
    pages += 1;

    const page = await getCollectionPageNetwork(cred, cursor, {
      ...opts,
      timeoutMs: Math.min(opts.timeoutMs ?? REQUEST_TIMEOUT_MS, remaining),
    });
    serverHasMore = page.hasMore;
    cursor = page.nextCursor;

    for (const item of page.items) {
      const cid = item.cid;
      if (!cid || seen.has(cid)) continue;
      seen.add(cid);
      items.push(item);
    }
    if (items.length >= target || !serverHasMore) break;
  }

  return { items, hasMore: serverHasMore || items.length > target };
}
