// Group album media list — trpc QunAlbum.trpc.qzone.webapp_qun_media.QunMedia.GetMediaList

import { GET_MEDIA_LIST_REQUEST, GET_MEDIA_LIST_RESPONSE } from './media-schemas';
import { invokeTrpc, type TrpcSpec } from './invoke';
import type { TrpcNative } from '../transport';

const CMD = 'QunAlbum.trpc.qzone.webapp_qun_media.QunMedia.GetMediaList';

export namespace GetAlbumMediaList {
  export const cmd = CMD;
  export const reqSchema = GET_MEDIA_LIST_REQUEST;
  export const respSchema = GET_MEDIA_LIST_RESPONSE;

  export interface Params {
    groupId: string;
    albumId: string;
    attachInfo?: string;
  }

  export const serialize = (p: Params): Record<string, unknown> => ({
    reqInfo: { groupId: p.groupId, albumId: p.albumId, attachInfo: p.attachInfo ?? '' },
    traceId: `_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
    extMap: [{ key: 'fc-appid', value: '100' }],
  });

  export const deserialize = (body: Record<string, unknown>): Record<string, unknown> => body;

  export const invoke = (nt: TrpcNative, pid: number, params: Params): Promise<Record<string, unknown>> =>
    invokeTrpc(nt, pid, GetAlbumMediaList as TrpcSpec<Params, Record<string, unknown>>, params);
}
