// File download URL — group 0x6D6_2 / private (c2c) 0xE37_1200.
// These are plain OIDB cmds (not NTV2). Group returns a dns + hex-key blob the
// caller composes into a ftn_handler URL; private returns a server/port/url
// triple composed into an http URL.

import {
  OIDB_GROUP_FILE_REQ,
  OIDB_GROUP_FILE_RESP,
  OIDB_PRIVATE_FILE_DOWNLOAD_REQ,
  OIDB_PRIVATE_FILE_DOWNLOAD_RESP,
} from './media-schemas';
import { invokeOidb, type OidbSpec } from './invoke';
import { bytesToHexUpper, ensureRetCodeZero } from './shared';
import type { OidbNative } from '../transport';

/** Resolved group-file download endpoint — caller composes the final URL with
 *  the file's display name (`?fname=`). */
export interface GroupFileDownload {
  /** Download host (dns preferred, ip fallback). */
  dns: string;
  /** Hex-encoded download key blob, uppercase. */
  urlHex: string;
  /** Server-suggested save name (may be empty). */
  saveFileName: string;
}

export function composeGroupFileDownloadUrl(download: GroupFileDownload): string {
  return `https://${download.dns}/ftn_handler/${download.urlHex}/?fname=`;
}

function composePrivateFileDownloadUrl(server: string, port: number, url: string): string {
  const [pathWithQuery = '', fragment = ''] = url.replace('/asn.com', '').split('#', 2);
  const [path = '', query = ''] = pathWithQuery.split('?', 2);
  const params = query ? query.split('&').filter((p) => p !== '' && p !== 'isthumb=0') : [];
  params.push('isthumb=0');
  const suffix = fragment ? `#${fragment}` : '';
  return `http://${server}:${port}${path}?${params.join('&')}${suffix}`;
}

export namespace GetGroupFileUrl {
  export const command = 0x6d6;
  export const subCommand = 2;
  export const uinForm = true;
  export const reqSchema = OIDB_GROUP_FILE_REQ;
  export const respSchema = OIDB_GROUP_FILE_RESP;

  export interface Params {
    groupId: number;
    fileId: string;
    busId: number;
  }

  export const serialize = (p: Params): Record<string, unknown> => ({
    download: { groupUin: p.groupId, appId: 7, busId: p.busId, fileId: p.fileId },
  });

  export const deserialize = (body: Record<string, unknown>): GroupFileDownload => {
    const download = body.download as Record<string, unknown> | undefined;
    if (!download) throw new Error('group file url response missing');
    ensureRetCodeZero('group file url', download.retCode, download.retMsg, download.clientWording);

    const dns =
      (typeof download.downloadDns === 'string' && download.downloadDns) ||
      (typeof download.downloadIp === 'string' && download.downloadIp) ||
      '';
    const urlBytes = download.downloadUrl instanceof Uint8Array ? download.downloadUrl : new Uint8Array(0);
    const urlHex = bytesToHexUpper(urlBytes);
    if (!dns || !urlHex) throw new Error('group file url response invalid');

    return {
      dns,
      urlHex,
      saveFileName: typeof download.saveFileName === 'string' ? download.saveFileName : '',
    };
  };

  export const invoke = (nt: OidbNative, pid: number, params: Params): Promise<GroupFileDownload> =>
    invokeOidb(nt, pid, GetGroupFileUrl as OidbSpec<Params, GroupFileDownload>, params);
}

/** Magic 4-byte tail the 0xE37_1200 server deserializer requires (same constant
 *  as Lagrange/NapCat). */
const PRIVATE_FILE_MAGIC = new Uint8Array([0xc0, 0x85, 0x2c, 0x01]);

export namespace GetPrivateFileUrl {
  export const command = 0xe37;
  export const subCommand = 1200;
  export const reqSchema = OIDB_PRIVATE_FILE_DOWNLOAD_REQ;
  export const respSchema = OIDB_PRIVATE_FILE_DOWNLOAD_RESP;

  export interface Params {
    selfUid: string;
    fileId: string;
    fileHash: string;
  }

  export const serialize = (p: Params): Record<string, unknown> => ({
    subCommand: 1200,
    field2: 1,
    body: { receiverUid: p.selfUid, fileUuid: p.fileId, type: 2, fileHash: p.fileHash, t2: 0 },
    field101: 3,
    field102: 1,
    field200: 1,
    field99999: PRIVATE_FILE_MAGIC,
  });

  /** Returns the composed `http://<server>:<port><url>&isthumb=0` download URL. */
  export const deserialize = (body: Record<string, unknown>): string => {
    const inner = body.body as Record<string, unknown> | undefined;
    const result = inner?.result as Record<string, unknown> | undefined;
    if (!result) throw new Error('private file url response invalid');
    const server = typeof result.server === 'string' ? result.server : '';
    const port = typeof result.port === 'number' ? result.port : 0;
    const url = typeof result.url === 'string' ? result.url : '';
    if (!server || !url) throw new Error('private file url response invalid');
    return composePrivateFileDownloadUrl(server, port, url);
  };

  export const invoke = (nt: OidbNative, pid: number, params: Params): Promise<string> =>
    invokeOidb(nt, pid, GetPrivateFileUrl as OidbSpec<Params, string>, params);
}
