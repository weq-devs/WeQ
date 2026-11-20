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

import type {
  CollectionCachedContent,
  CollectionFileInfo,
  CollectionItem,
  CollectionKind,
  CollectionPicInfo,
} from '@weq/db';
import type { ProtoDecodeStructType } from '@weq/codec';
import type { CollectorRespBody } from '@weq/codec/proto/collection/index';
import {
  readCollectionDetails,
  readCollectionPage,
  WebRequestError as ProtocolWebRequestError,
  type CollectionHttpRequest,
  type CollectionNetworkCursor,
  type CollectionTransport,
} from '@weqbot/protocol';
import type { WebCredential } from './credential';
import { WEB_READ_RETRY, webRequestBytes, WebRequestError } from './http';

export { encodeCollectionEnvelope as encodeEnvelope } from '@weqbot/protocol';
export type { CollectionHttpRequest, CollectionNetworkCursor, CollectionTransport };

const MAX_PAGES = 100;
const REQUEST_TIMEOUT_MS = 10_000;
const OPERATION_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
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

function defaultTransport(request: CollectionHttpRequest): Promise<Uint8Array> {
  const { Cookie, ...headers } = request.headers;
  return webRequestBytes(request.url, {
    method: 'POST',
    cookie: Cookie ?? '',
    headers,
    body: request.body,
    signal: request.signal,
    timeoutMs: request.timeoutMs,
    maxResponseBytes: MAX_RESPONSE_BYTES,
    retry: WEB_READ_RETRY,
  });
}

/** 保留应用的网络传输、重试和诊断分类。 */
export async function withCollectionTransport<T>(
  options: Pick<CollectionNetworkOptions, 'transport' | 'signal' | 'timeoutMs'>,
  request: (options: {
    transport: CollectionTransport;
    signal?: AbortSignal | undefined;
    timeoutMs?: number | undefined;
  }) => Promise<T>,
): Promise<T> {
  try {
    return await request({ ...options, transport: options.transport ?? defaultTransport });
  } catch (error) {
    if (error instanceof ProtocolWebRequestError)
      throw new WebRequestError(error.kind, error.message, error.options);
    throw error;
  }
}

export async function getCollectionDetailsNetwork(
  cred: WebCredential,
  cids: readonly string[],
  opts: CollectionDetailNetworkOptions = {},
): Promise<CollectionNetworkDetail[]> {
  const details = await withCollectionTransport(opts, (transport) =>
    readCollectionDetails({ ...cred, cids, ...opts, ...transport }),
  );
  // 共享解码器使用相同的 collector 字段；这里保留数据库模型所需的原始类型和缺失状态。
  return details.map(({ cid, content }) => ({ cid, content: mapDetail(content as WireDetail) }));
}

export async function getCollectionPageNetwork(
  cred: WebCredential,
  cursor: CollectionNetworkCursor | null = null,
  opts: CollectionNetworkOptions = {},
): Promise<NetworkCollectionCursorPage> {
  const { items, hasMore, nextCursor, totalCount, rawResponse } = await withCollectionTransport(
    opts,
    (transport) => readCollectionPage({ ...cred, cursor, ...opts, ...transport }),
  );
  return {
    items: items.map((item) => mapItem(item as WireItem)),
    hasMore,
    nextCursor,
    totalCount,
    rawResponse,
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
