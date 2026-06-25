// Voice (ptt) download URL — group 0x126E_200 / private (c2c) 0x126D_200.
// Both use the NTV2RichMedia shape; only the scene block + wire cmd differ.

import type { MediaIndexNode } from './media-schemas';
import { NTV2_RICH_MEDIA_REQ, NTV2_RICH_MEDIA_RESP } from './media-schemas';
import { buildNtv2DownloadReq, parseNtv2DownloadUrl } from './ntv2';
import { invokeOidb, type OidbSpec } from './invoke';
import type { OidbNative } from '../transport';

const PTT_REQUEST_ID = 4;

export namespace GetGroupPttUrl {
  export const command = 0x126e;
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
      PTT_REQUEST_ID,
      { requestType: 1, businessType: 3, sceneType: 2, group: { groupUin: p.groupId } },
      p.node,
    );

  export const deserialize = (body: Record<string, unknown>): string => parseNtv2DownloadUrl(body);

  export const invoke = (nt: OidbNative, pid: number, params: Params): Promise<string> =>
    invokeOidb(nt, pid, GetGroupPttUrl as OidbSpec<Params, string>, params);
}

export namespace GetPrivatePttUrl {
  export const command = 0x126d;
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
      PTT_REQUEST_ID,
      { requestType: 1, businessType: 3, sceneType: 1, c2c: { accountType: 2, targetUid: p.selfUid } },
      p.node,
    );

  export const deserialize = (body: Record<string, unknown>): string => parseNtv2DownloadUrl(body);

  export const invoke = (nt: OidbNative, pid: number, params: Params): Promise<string> =>
    invokeOidb(nt, pid, GetPrivatePttUrl as OidbSpec<Params, string>, params);
}
