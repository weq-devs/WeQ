// 群相册写操作 — 删除媒体 / 点赞 / 评论 / 取动态详情。
//
// 四条都走 QunAlbum 的 trpc 服务（不是 OIDB 信封）：
//   QunAlbum.trpc.qzone.webapp_qun_media.QunMedia.DeleteMedias
//   QunAlbum.trpc.qzone.webapp_qun_operation.FeedsWriter.DoQunLike
//   QunAlbum.trpc.qzone.webapp_qun_operation.FeedsWriter.DoQunComment
//   QunAlbum.trpc.qzone.webapp_qun_feeds.FeedsReader.GetQunFeedDetail
//
// 搬运自 SnowLuma `core/src/bridge/apis/group-album.ts` 与
// `proto-defs/oidb-actions/group-album.ts`。
//
// 签名：这些 trpc 服务都不在 LagrangeV2 白名单里 —— 不签（由 `invokeTrpc` 推导）。
//
// ⚠️ 评论依赖 `GetQunFeedDetail` 返回的三段**原始 cell 字节**：官方客户端先取
// 详情，再把 `feed.cellCommon` / `cellUserInfo` / `cellMedia` 的子报文原样塞进
// `DoQunComment.reqBody`。所以这里用 `raw-cells` 从整个响应里切字节，而不是走
// 类型化解码再重编码。

import { decode, encode, message } from '../../protobuf';
import { invokeTrpc, type TrpcSpec } from '../invoke';
import { toInt } from '../shared';
import type { TrpcNative } from '../../transport';
import { nonemptyBytes, protobufSubmessage } from './raw-cells';

const EXT_MAP_ENTRY = message([
  { name: 'key', tag: 1, type: 'string' },
  { name: 'value', tag: 2, type: 'string' },
]);

/** 官方客户端写死的来源标记。 */
const QUN_ALBUM_SOURCE = 'h5_test';
/** `fc-appid=100` 是 h5 相册入口。 */
const QUN_ALBUM_EXT = [{ key: 'fc-appid', value: '100' }];

function traceId(): string {
  return `_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
}

function clientKey(uin: string): string {
  return `${uin}_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
}

// ───────────────────────── 删除媒体 — QunMedia.DeleteMedias ─────────────────────────

const DELETE_MEDIAS_CMD = 'QunAlbum.trpc.qzone.webapp_qun_media.QunMedia.DeleteMedias';
const DELETE_MEDIAS_SEQ = 8694;

const DELETE_MEDIAS_BODY = message([
  { name: 'groupId', tag: 1, type: 'string' },
  { name: 'albumId', tag: 2, type: 'string' },
  { name: 'mediaIds', tag: 3, type: 'string', repeated: true },
  { name: 'batchIds', tag: 4, type: 'string', repeated: true },
]);
const DELETE_MEDIAS_REQ = message([
  { name: 'field1', tag: 1, type: 'int32' },
  { name: 'field2', tag: 2, type: 'string' },
  { name: 'field3', tag: 3, type: 'string' },
  { name: 'body', tag: 4, type: DELETE_MEDIAS_BODY },
  { name: 'traceId', tag: 5, type: 'string' },
  { name: 'extMap', tag: 10, type: EXT_MAP_ENTRY, repeated: true },
]);
const DELETE_MEDIAS_RESP = message([
  { name: 'field1', tag: 1, type: 'int32' },
  { name: 'field2', tag: 2, type: 'int32' },
  { name: 'field3', tag: 3, type: 'string' },
]);

export interface DeleteGroupAlbumMediaParams {
  groupId: string;
  albumId: string;
  /** 图片的 lloc；视频传封面的 lloc。 */
  mediaIds: string[];
  /** 与 `mediaIds` 一一对应的 batch id（Android 客户端总会带）。 */
  batchIds?: string[];
}

export namespace DeleteGroupAlbumMedia {
  export const cmd = DELETE_MEDIAS_CMD;
  export const reqSchema = DELETE_MEDIAS_REQ;
  export const respSchema = DELETE_MEDIAS_RESP;

  export type Params = DeleteGroupAlbumMediaParams;

  export const serialize = (p: Params): Record<string, unknown> => {
    if (!p.mediaIds.length) throw new Error('mediaIds 不能为空');
    return {
      field1: DELETE_MEDIAS_SEQ,
      field2: QUN_ALBUM_SOURCE,
      field3: QUN_ALBUM_SOURCE,
      body: {
        groupId: p.groupId,
        albumId: p.albumId,
        mediaIds: p.mediaIds,
        batchIds: p.batchIds ?? [],
      },
      traceId: traceId(),
      extMap: QUN_ALBUM_EXT,
    };
  };

  export const deserialize = (body: Record<string, unknown>): void => {
    const seq = toInt(body.field1);
    const errCode = toInt(body.field2);
    if (seq !== DELETE_MEDIAS_SEQ || errCode !== 0) {
      const text = typeof body.field3 === 'string' ? body.field3 : '';
      throw new Error(`群相册删除失败：seq=${seq} code=${errCode}${text ? ` ${text}` : ''}`);
    }
  };

  export const invoke = (nt: TrpcNative, pid: number, params: Params): Promise<void> =>
    invokeTrpc(nt, pid, DeleteGroupAlbumMedia as TrpcSpec<Params, void>, params);
}

// ───────────────────────── 点赞 / 取消 — FeedsWriter.DoQunLike ─────────────────────────

const QUN_LIKE_CMD = 'QunAlbum.trpc.qzone.webapp_qun_operation.FeedsWriter.DoQunLike';
const QUN_LIKE_SEQ = 5495;

const QUN_LIKE_INFO = message([
  { name: 'id', tag: 1, type: 'string' },
  { name: 'status', tag: 3, type: 'uint32' },
]);
const QUN_LIKE_CELL_COMMON = message([
  { name: 'time', tag: 3, type: 'uint64' },
  { name: 'feedId', tag: 4, type: 'string' },
]);
const QUN_LIKE_CELL_USER = message([{ name: 'uin', tag: 13, type: 'string' }]);
const QUN_LIKE_CELL_USER_INFO = message([{ name: 'user', tag: 1, type: QUN_LIKE_CELL_USER }]);
const QUN_LIKE_CELL_MEDIA = message([
  { name: 'albumId', tag: 3, type: 'string' },
  { name: 'batchId', tag: 5, type: 'uint64' },
]);
const QUN_LIKE_CELL_QUN = message([{ name: 'qunId', tag: 1, type: 'string' }]);
const QUN_LIKE_PUBLISH = message([
  { name: 'cellCommon', tag: 1, type: QUN_LIKE_CELL_COMMON },
  { name: 'cellUserInfo', tag: 2, type: QUN_LIKE_CELL_USER_INFO },
  { name: 'cellMedia', tag: 5, type: QUN_LIKE_CELL_MEDIA },
  { name: 'cellQunInfo', tag: 12, type: QUN_LIKE_CELL_QUN },
]);
const QUN_LIKE_BODY = message([
  { name: 'type', tag: 2, type: 'uint32' },
  { name: 'like', tag: 3, type: QUN_LIKE_INFO },
  { name: 'publish', tag: 4, type: QUN_LIKE_PUBLISH },
  { name: 'clientKey', tag: 5, type: 'string' },
]);
const QUN_LIKE_REQ = message([
  { name: 'field1', tag: 1, type: 'int32' },
  { name: 'field2', tag: 2, type: 'string' },
  { name: 'field3', tag: 3, type: 'string' },
  { name: 'body', tag: 4, type: QUN_LIKE_BODY },
  { name: 'extMap', tag: 10, type: EXT_MAP_ENTRY, repeated: true },
]);
const QUN_LIKE_RESP = message([
  { name: 'field1', tag: 1, type: 'int32' },
  { name: 'body', tag: 4, type: message([{ name: 'like', tag: 2, type: QUN_LIKE_INFO }]) },
]);

export interface GroupAlbumLikeParams {
  groupId: string;
  albumId: string;
  /** 媒体所属 batch id（列表里每项的 `batchId`）。 */
  batchId: string;
  /** 媒体上传者 uin（列表里的 `uploader`）。 */
  uploaderUin: string;
  /** 媒体上传时间（unix 秒，列表里的 `uploadTime`）。 */
  uploadTime: number;
  /** 图片 lloc / 视频 id，写入 `like.id`。 */
  mediaId: string;
  /** 当前账号 uin（写进 `clientKey`）。 */
  selfUin: string;
  /** true = 点赞，false = 取消。 */
  like: boolean;
}

/**
 * 点赞 cell id：`421_1_0_{groupId}|{albumId}|{batchId}`，带 lloc 时再拼一段。
 * 与 SnowLuma `qunFeedCellId` 一致。
 */
export function groupAlbumCellId(
  groupId: string,
  albumId: string,
  batchId: string,
  lloc?: string,
): string {
  const head = `421_1_0_${groupId}|${albumId}|${batchId}`;
  return lloc ? `${head}^||^421_1_0_${groupId}|${albumId}|${lloc}^||^0` : head;
}

export namespace SetGroupAlbumLike {
  export const cmd = QUN_LIKE_CMD;
  export const reqSchema = QUN_LIKE_REQ;
  export const respSchema = QUN_LIKE_RESP;

  export type Params = GroupAlbumLikeParams;

  export const serialize = (p: Params): Record<string, unknown> => {
    if (!p.groupId) throw new Error('groupId 不能为空');
    if (!p.albumId) throw new Error('albumId 不能为空');
    if (!p.mediaId) throw new Error('mediaId 不能为空');
    if (!p.batchId) throw new Error('batchId 不能为空');
    return {
      field1: QUN_LIKE_SEQ,
      field2: QUN_ALBUM_SOURCE,
      field3: QUN_ALBUM_SOURCE,
      body: {
        // type 2 = 点赞、1 = 取消；like.status 0 = 赞、1 = 取消。
        type: p.like ? 2 : 1,
        like: {
          id: groupAlbumCellId(p.groupId, p.albumId, p.batchId, p.mediaId),
          status: p.like ? 0 : 1,
        },
        publish: {
          cellCommon: { time: p.uploadTime, feedId: `422_0_${p.batchId}` },
          cellUserInfo: { user: { uin: p.uploaderUin } },
          cellMedia: { albumId: p.albumId, batchId: p.batchId },
          cellQunInfo: { qunId: p.groupId },
        },
        clientKey: clientKey(p.selfUin),
      },
      extMap: QUN_ALBUM_EXT,
    };
  };

  export const deserialize = (body: Record<string, unknown>): void => {
    const seq = toInt(body.field1);
    if (seq !== QUN_LIKE_SEQ) throw new Error(`群相册点赞响应异常：seq=${seq}`);
  };

  export const invoke = (nt: TrpcNative, pid: number, params: Params): Promise<void> =>
    invokeTrpc(nt, pid, SetGroupAlbumLike as TrpcSpec<Params, void>, params);
}

// ───────────────────────── 动态详情 — FeedsReader.GetQunFeedDetail ─────────────────────────

const QUN_FEED_DETAIL_CMD = 'QunAlbum.trpc.qzone.webapp_qun_feeds.FeedsReader.GetQunFeedDetail';

const FEED_DETAIL_REQ_DATA = message([
  { name: 'groupId', tag: 2, type: 'string' },
  { name: 'feedId', tag: 3, type: 'string' },
  { name: 'commentCount', tag: 4, type: 'int32' },
  { name: 'attachInfo', tag: 5, type: 'string' },
  { name: 'albumId', tag: 6, type: 'string' },
  { name: 'batchId', tag: 7, type: 'string' },
  { name: 'lloc', tag: 8, type: 'string' },
]);
const FEED_DETAIL_REQ = message([
  { name: 'seq', tag: 1, type: 'int32' },
  { name: 'data', tag: 4, type: FEED_DETAIL_REQ_DATA },
  { name: 'traceId', tag: 5, type: 'string' },
  { name: 'extMap', tag: 10, type: EXT_MAP_ENTRY, repeated: true },
]);
/** `data.feed.feed.cellCommon.feedId` 只需要这一条路径，其余原字节透传。 */
const FEED_DETAIL_RESP = message([
  { name: 'seq', tag: 1, type: 'int32' },
  { name: 'result', tag: 2, type: 'int32' },
  { name: 'errorText', tag: 3, type: 'string' },
  {
    name: 'data',
    tag: 4,
    type: message([
      {
        name: 'feed',
        tag: 2,
        type: message([
          {
            name: 'feed',
            tag: 1,
            type: message([
              {
                name: 'cellCommon',
                tag: 1,
                type: message([{ name: 'feedId', tag: 4, type: 'string' }]),
              },
              {
                name: 'cellUserInfo',
                tag: 2,
                type: message([
                  {
                    name: 'user',
                    tag: 1,
                    type: message([{ name: 'uin', tag: 13, type: 'string' }]),
                  },
                ]),
              },
              {
                name: 'cellMedia',
                tag: 5,
                type: message([
                  { name: 'albumId', tag: 3, type: 'string' },
                  { name: 'batchId', tag: 5, type: 'uint64' },
                ]),
              },
            ]),
          },
        ]),
      },
    ]),
  },
]);

export interface GroupAlbumFeedDetailParams {
  groupId: string;
  albumId: string;
  /** 媒体 batch id。 */
  batchId: string;
  /** 图片 lloc / 视频 id。 */
  lloc: string;
  /** 一次拉多少条评论（官方默认 20）。 */
  commentCount?: number;
}

export interface GroupAlbumFeedCells {
  /** 三段 cell 的原始字节；用于原样透传给 {@link CommentGroupAlbumMedia}。 */
  cellCommon: Uint8Array;
  cellUserInfo?: Uint8Array;
  cellMedia?: Uint8Array;
  feedId: string;
  /** 媒体上传者 uin（cellUserInfo 里读出，供评论兜底）。 */
  ownerUin: string;
}

/**
 * 取一条相册动态的原始 cell 子报文。
 *
 * 返回的 `cellCommon` / `cellUserInfo` / `cellMedia` 是服务端响应里的**原始字节**，
 * 评论时必须原样回传。
 */
export namespace GetGroupAlbumFeedDetail {
  export const cmd = QUN_FEED_DETAIL_CMD;
  export const reqSchema = FEED_DETAIL_REQ;
  export const respSchema = FEED_DETAIL_RESP;

  export type Params = GroupAlbumFeedDetailParams;

  export const serialize = (p: Params): Record<string, unknown> => ({
    seq: 0,
    data: {
      groupId: p.groupId,
      feedId: '',
      commentCount: p.commentCount ?? 20,
      attachInfo: '',
      albumId: p.albumId,
      batchId: p.batchId,
      lloc: p.lloc,
    },
    traceId: traceId(),
    extMap: QUN_ALBUM_EXT,
  });

  export const deserialize = (body: Record<string, unknown>): GroupAlbumFeedCells => {
    const result = toInt(body.result);
    if (result !== 0) {
      const text = typeof body.errorText === 'string' ? body.errorText : '';
      throw new Error(`群相册动态详情失败：code=${result}${text ? ` ${text}` : ''}`);
    }
    const feedId = readFeedId(body.data);
    if (!feedId) throw new Error('群相册动态详情缺少 feedId');
    return {
      // 这里用的是**解码后的对象**；原始字节由 `invokeRaw` 另行切出。
      cellCommon: new Uint8Array(0),
      feedId,
      ownerUin: readOwnerUin(body.data),
    };
  };

  /**
   * 直接返回原始 cell 字节的入口。
   *
   * `invokeTrpc` 只给解码后的对象，而评论需要原字节，所以这里自己发包 + 切字节。
   */
  export const invoke = async (
    nt: TrpcNative,
    pid: number,
    params: Params,
  ): Promise<GroupAlbumFeedCells> => {
    const reqBytes = encode(FEED_DETAIL_REQ, serialize(params));
    // 该 trpc 不在白名单里 → 不签名。
    const raw = await nt.sendPacket(pid, QUN_FEED_DETAIL_CMD, Buffer.from(reqBytes), false);
    const response = new Uint8Array(raw);
    const decoded = decodeHead(response);

    const result = toInt(decoded.result);
    if (result !== 0) {
      const text = typeof decoded.errorText === 'string' ? decoded.errorText : '';
      throw new Error(`群相册动态详情失败：code=${result}${text ? ` ${text}` : ''}`);
    }

    const cellCommon = nonemptyBytes(protobufSubmessage(response, [4, 2, 1, 1]));
    if (!cellCommon) throw new Error('群相册动态详情缺少 cellCommon');

    return {
      cellCommon,
      cellUserInfo: nonemptyBytes(protobufSubmessage(response, [4, 2, 1, 2])),
      cellMedia: nonemptyBytes(protobufSubmessage(response, [4, 2, 1, 5])),
      feedId: readFeedId(decoded.data),
      ownerUin: readOwnerUin(decoded.data),
    };
  };
}

function decodeHead(response: Uint8Array): Record<string, unknown> {
  return decode(FEED_DETAIL_RESP, response);
}

function readFeedId(data: unknown): string {
  const d = (data ?? {}) as Record<string, unknown>;
  const feed = ((d.feed ?? {}) as Record<string, unknown>).feed as
    | Record<string, unknown>
    | undefined;
  const common = (feed?.cellCommon ?? {}) as Record<string, unknown>;
  return typeof common.feedId === 'string' ? common.feedId : '';
}

function readOwnerUin(data: unknown): string {
  const d = (data ?? {}) as Record<string, unknown>;
  const feed = ((d.feed ?? {}) as Record<string, unknown>).feed as
    | Record<string, unknown>
    | undefined;
  const userInfo = (feed?.cellUserInfo ?? {}) as Record<string, unknown>;
  const user = (userInfo.user ?? {}) as Record<string, unknown>;
  return typeof user.uin === 'string' ? user.uin : '';
}

// ───────────────────────── 评论 — FeedsWriter.DoQunComment ─────────────────────────

const QUN_COMMENT_CMD = 'QunAlbum.trpc.qzone.webapp_qun_operation.FeedsWriter.DoQunComment';
const QUN_COMMENT_SEQ = 8527;

const COMMENT_CONTENT = message([
  { name: 'type', tag: 1, type: 'uint32', force: true },
  { name: 'content', tag: 2, type: 'string' },
]);
const COMMENT_USER = message([
  { name: 'uin', tag: 13, type: 'string' },
  { name: 'uinNum', tag: 14, type: 'uint64' },
]);
const COMMENT_CONTENT_BLOCK = message([
  { name: 'user', tag: 2, type: COMMENT_USER },
  { name: 'contents', tag: 3, type: COMMENT_CONTENT, repeated: true },
  { name: 'clientKey', tag: 7, type: 'string' },
]);
/** 三段 cell 一律按 bytes 原样透传。 */
const COMMENT_REQ_BODY = message([
  { name: 'cellCommon', tag: 1, type: 'bytes' },
  { name: 'cellUserInfo', tag: 2, type: 'bytes' },
  { name: 'cellMedia', tag: 5, type: 'bytes' },
]);
const COMMENT_BODY = message([
  { name: 'groupId', tag: 2, type: 'string' },
  { name: 'field3', tag: 3, type: 'uint32' },
  { name: 'reqBody', tag: 4, type: COMMENT_REQ_BODY },
  { name: 'content', tag: 5, type: COMMENT_CONTENT_BLOCK },
]);
const COMMENT_REQ = message([
  { name: 'field1', tag: 1, type: 'int32' },
  { name: 'field2', tag: 2, type: 'bytes' },
  { name: 'field3', tag: 3, type: 'bytes' },
  { name: 'body', tag: 4, type: COMMENT_BODY },
  { name: 'traceId', tag: 5, type: 'string' },
  { name: 'extMap', tag: 10, type: EXT_MAP_ENTRY, repeated: true },
]);
const COMMENT_RESP = message([
  { name: 'field1', tag: 1, type: 'int32' },
  { name: 'result', tag: 2, type: 'int32' },
  { name: 'errorText', tag: 3, type: 'string' },
  {
    name: 'comment',
    tag: 4,
    type: message([
      { name: 'id', tag: 1, type: 'string' },
      {
        name: 'data',
        tag: 2,
        type: message([
          { name: 'id', tag: 1, type: 'string' },
          { name: 'time', tag: 4, type: 'uint64' },
          { name: 'clientKey', tag: 7, type: 'string' },
        ]),
      },
    ]),
  },
]);

export interface CommentGroupAlbumMediaParams {
  groupId: string;
  /** 当前账号 uin（评论者）。 */
  selfUin: string;
  /** `GetGroupAlbumFeedDetail` 的返回值。 */
  cells: GroupAlbumFeedCells;
  /** 评论文本。 */
  content: string;
}

export interface GroupAlbumCommentResult {
  /** 服务端签发的评论 id。 */
  id: string;
  clientKey: string;
  time: number;
}

/**
 * 评论一条相册媒体。
 *
 * 先调 {@link GetGroupAlbumFeedDetail} 拿 `cells`，这里把三段原始 cell 透传，
 * 再把评论内容放进 `field5`。
 */
export namespace CommentGroupAlbumMedia {
  export const cmd = QUN_COMMENT_CMD;
  export const reqSchema = COMMENT_REQ;
  export const respSchema = COMMENT_RESP;

  export type Params = CommentGroupAlbumMediaParams;

  export const serialize = (p: Params): Record<string, unknown> => {
    const content = String(p.content ?? '');
    if (!content.trim()) throw new Error('评论内容不能为空');
    if (!p.cells.cellCommon.length)
      throw new Error('缺少 cellCommon，先调用 GetGroupAlbumFeedDetail');
    const uinNum = /^\d+$/.test(p.selfUin) ? BigInt(p.selfUin) : undefined;
    return {
      field1: QUN_COMMENT_SEQ,
      field2: new Uint8Array(0),
      field3: new Uint8Array(0),
      body: {
        groupId: p.groupId,
        field3: 2,
        reqBody: {
          cellCommon: p.cells.cellCommon,
          ...(p.cells.cellUserInfo ? { cellUserInfo: p.cells.cellUserInfo } : {}),
          ...(p.cells.cellMedia ? { cellMedia: p.cells.cellMedia } : {}),
        },
        content: {
          user: { uin: p.selfUin, ...(uinNum !== undefined ? { uinNum } : {}) },
          contents: [{ type: 0, content }],
          clientKey: clientKey(p.selfUin),
        },
      },
      traceId: traceId(),
      extMap: QUN_ALBUM_EXT,
    };
  };

  export const deserialize = (body: Record<string, unknown>): GroupAlbumCommentResult => {
    const result = toInt(body.result);
    if (result !== 0) {
      const text = typeof body.errorText === 'string' ? body.errorText : '';
      throw new Error(`群相册评论失败：code=${result}${text ? ` ${text}` : ''}`);
    }
    const comment = (body.comment ?? {}) as Record<string, unknown>;
    const data = (comment.data ?? {}) as Record<string, unknown>;
    const id =
      (typeof data.id === 'string' && data.id) ||
      (typeof comment.id === 'string' ? comment.id : '');
    if (!id) throw new Error('群相册评论响应缺少评论 id');
    return {
      id,
      clientKey: typeof data.clientKey === 'string' ? data.clientKey : '',
      time: toInt(data.time),
    };
  };

  export const invoke = (
    nt: TrpcNative,
    pid: number,
    params: Params,
  ): Promise<GroupAlbumCommentResult> =>
    invokeTrpc(
      nt,
      pid,
      CommentGroupAlbumMedia as TrpcSpec<Params, GroupAlbumCommentResult>,
      params,
    );
}
