/**
 * GroupAlbumMediaService — thin service wrapper for the group album media list
 * (QunAlbum.trpc.qzone.webapp_qun_media.QunMedia.GetMediaList). Proto
 * definitions and trpc dispatch live in @weqbot/protocol; this layer only builds
 * the typed result and maps bigint → string for JSON friendliness.
 */
import type { AccountSession } from '@weq/account';
import type { NtHelperBinding } from '@weq/native';
import { albumCapabilities, type QQAlbumCapabilities } from '../common/qq_permissions';
import {
  CommentGroupAlbumMedia,
  DeleteGroupAlbumMedia,
  GetAlbumMediaList,
  GetGroupAlbumFeedDetail,
  SetGroupAlbumLike,
  type GroupAlbumLikeParams,
} from '@weqbot/protocol';

export interface AlbumMediaUrl {
  url: string;
  width: number;
  height: number;
}

export interface AlbumPhotoUrl {
  spec: number;
  url: AlbumMediaUrl | null;
}

export interface AlbumMediaImage {
  name: string;
  sloc: string;
  lloc: string;
  photoUrls: AlbumPhotoUrl[];
  defaultUrl: AlbumMediaUrl | null;
  isGif: boolean;
  hasRaw: boolean;
}

export interface AlbumMediaVideo {
  id: string;
  url: string;
  cover: AlbumMediaImage | null;
  width: number;
  height: number;
  /** Duration in seconds. */
  videoTime: string;
  videoUrls: AlbumPhotoUrl[];
}

export interface AlbumMedia {
  type: number;
  isLivePhoto?: boolean;
  image: AlbumMediaImage | null;
  video: AlbumMediaVideo | null;
  uploader: string;
  batchId: string;
  uploadTime: string;
}

export interface AlbumMediaPage {
  albumId: string;
  albumName: string;
  mediaList: AlbumMedia[];
  nextAttachInfo: string;
  nextHasMore?: boolean;
  capabilities: QQAlbumCapabilities | null;
}

// ─── decode helpers ───

type Rec = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
const bool = (v: unknown): boolean => v === true;
const big = (v: unknown): string =>
  typeof v === 'bigint' ? v.toString() : typeof v === 'number' ? String(v) : '0';

function mapUrl(v: unknown): AlbumMediaUrl | null {
  if (v == null || typeof v !== 'object') return null;
  const o = v as Rec;
  return { url: str(o.url), width: num(o.width), height: num(o.height) };
}

function mapPhotoUrls(v: unknown): AlbumPhotoUrl[] {
  return (Array.isArray(v) ? v : []).map((p) => {
    const po = p as Rec;
    return { spec: num(po.spec), url: mapUrl(po.url) };
  });
}

function mapImage(v: unknown): AlbumMediaImage | null {
  if (v == null || typeof v !== 'object') return null;
  const o = v as Rec;
  return {
    name: str(o.name),
    sloc: str(o.sloc),
    lloc: str(o.lloc),
    photoUrls: mapPhotoUrls(o.photoUrls),
    defaultUrl: mapUrl(o.defaultUrl),
    isGif: bool(o.isGif),
    hasRaw: bool(o.hasRaw),
  };
}

function mapVideo(v: unknown): AlbumMediaVideo | null {
  if (v == null || typeof v !== 'object') return null;
  const o = v as Rec;
  return {
    id: str(o.id),
    url: str(o.url),
    cover: mapImage(o.cover),
    width: num(o.width),
    height: num(o.height),
    videoTime: big(o.videoTime),
    videoUrls: mapPhotoUrls(o.videoUrl),
  };
}

function mapMedia(v: unknown): AlbumMedia {
  const o = (v ?? {}) as Rec;
  return {
    type: num(o.type),
    ...(typeof o.isLivePhoto === 'boolean' ? { isLivePhoto: o.isLivePhoto } : {}),
    image: mapImage(o.image),
    video: mapVideo(o.video),
    uploader: str(o.uploader),
    batchId: big(o.batchId),
    uploadTime: big(o.uploadTime),
  };
}

export class GroupAlbumMediaService {
  constructor(
    private readonly nt: Pick<NtHelperBinding, 'sendPacket'>,
    _session: AccountSession,
    private readonly resolvePid: () => number,
  ) {}

  async deleteMedia(
    groupId: string,
    albumId: string,
    mediaId: string,
    batchId: string,
  ): Promise<void> {
    await DeleteGroupAlbumMedia.invoke(this.nt, this.resolvePid(), {
      groupId,
      albumId,
      mediaIds: [mediaId],
      batchIds: [batchId],
    });
  }

  async setLike(params: GroupAlbumLikeParams): Promise<void> {
    await SetGroupAlbumLike.invoke(this.nt, this.resolvePid(), params);
  }

  async comment(
    groupId: string,
    albumId: string,
    batchId: string,
    lloc: string,
    selfUin: string,
    content: string,
    beforeSend: () => void,
  ): Promise<void> {
    const pid = this.resolvePid();
    const cells = await GetGroupAlbumFeedDetail.invoke(this.nt, pid, {
      groupId,
      albumId,
      batchId,
      lloc,
    });
    beforeSend();
    if (this.resolvePid() !== pid) throw new Error('QQ 运行时已改变，请重新打开相册');
    await CommentGroupAlbumMedia.invoke(this.nt, pid, { groupId, selfUin, cells, content });
  }

  async getMediaList(groupId: string, albumId: string, attachInfo = ''): Promise<AlbumMediaPage> {
    const resp = await GetAlbumMediaList.invoke(this.nt, this.resolvePid(), {
      groupId,
      albumId,
      attachInfo,
    });

    const retCode = resp.result;
    if (typeof retCode === 'number' && retCode !== 0)
      throw new Error(`getMediaList error: retCode ${retCode}`);

    const data = (resp.data ?? {}) as Rec;
    const albumInfo = (data.albumInfo ?? {}) as Rec;
    const returnedAlbumId = str(albumInfo.albumId);
    if (returnedAlbumId && returnedAlbumId !== albumId)
      throw new Error('相册权限返回与目标相册不一致');

    return {
      albumId: returnedAlbumId || albumId,
      albumName: str(albumInfo.name),
      mediaList: (Array.isArray(data.mediaList) ? data.mediaList : []).map(mapMedia),
      nextAttachInfo: str(data.nextAttachInfo),
      ...(typeof data.nextHasMore === 'boolean' ? { nextHasMore: data.nextHasMore } : {}),
      capabilities:
        data.right && typeof data.right === 'object'
          ? albumCapabilities(
              Array.isArray((data.right as Rec).operations)
                ? (data.right as { operations: number[] }).operations
                : [],
            )
          : null,
    };
  }
}
