// Video download URL — group 0x11EA_200 / private (c2c) 0x11E9_200.
// Same NTV2RichMedia shape as the ptt fetchers; scene businessType=2.
// (Verified against a real 0x11ea_200 capture: requestType 2, businessType 2,
//  sceneType 2, group; node.fileUuid is the video's fileToken.)

import type { MediaIndexNode } from './media-schemas';
import { NTV2_RICH_MEDIA_REQ, NTV2_RICH_MEDIA_RESP } from './media-schemas';
import { buildNtv2DownloadReq, parseNtv2DownloadUrl } from './ntv2';
import { invokeOidb, type OidbSpec } from './invoke';
import type { OidbNative } from '../transport';

const VIDEO_REQUEST_ID = 1;

export namespace GetGroupVideoUrl {
  export const command = 0x11ea;
  export const subCommand = 200;
  export const uinForm = true;
  export const reqSchema = NTV2_RICH_MEDIA_REQ;
  export const respSchema = NTV2_RICH_MEDIA_RESP;

  export interface Params {
    groupId: number;
    node: MediaIndexNode;
  }

  export const serialize = (p: Params): Record<string, unknown> =>
    buildNtv2DownloadReq(
      VIDEO_REQUEST_ID,
      { requestType: 2, businessType: 2, sceneType: 2, group: { groupUin: p.groupId } },
      p.node,
    );

  export const deserialize = (body: Record<string, unknown>): string => parseNtv2DownloadUrl(body);

  export const invoke = (nt: OidbNative, pid: number, params: Params): Promise<string> =>
    invokeOidb(nt, pid, GetGroupVideoUrl as OidbSpec<Params, string>, params);
}

export namespace GetPrivateVideoUrl {
  export const command = 0x11e9;
  export const subCommand = 200;
  export const uinForm = true;
  export const reqSchema = NTV2_RICH_MEDIA_REQ;
  export const respSchema = NTV2_RICH_MEDIA_RESP;

  export interface Params {
    selfUid: string;
    node: MediaIndexNode;
  }

  export const serialize = (p: Params): Record<string, unknown> =>
    buildNtv2DownloadReq(
      VIDEO_REQUEST_ID,
      { requestType: 2, businessType: 2, sceneType: 1, c2c: { accountType: 2, targetUid: p.selfUid } },
      p.node,
    );

  export const deserialize = (body: Record<string, unknown>): string => parseNtv2DownloadUrl(body);

  export const invoke = (nt: OidbNative, pid: number, params: Params): Promise<string> =>
    invokeOidb(nt, pid, GetPrivateVideoUrl as OidbSpec<Params, string>, params);
}
