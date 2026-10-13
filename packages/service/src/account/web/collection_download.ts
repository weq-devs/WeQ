import { ProtoMsg, ProtoField, ScalarType, type ProtoDecodeStructType } from '@weq/codec';
import { decodeMessage, type CollectionFileInfo } from '@weq/db';
import { CollectorFileInfo, CollectorRespHead } from '@weq/codec/proto/collection/index';
import type { WebCredential } from './credential';
import { encodeEnvelope, postCollector, type CollectionNetworkOptions } from './collection';
import { collectionMediaUrl } from '../collection_media';

/** Collector's own header version is independent of the QQ SSO version. */
export const COLLECTION_DOWNLOAD_BUILDS = new Set(['7.0.1-52892', '7.0.2-53644']);
const P = ProtoField;
const S = ScalarType;
function hasControl(value: string, spaces = false): boolean {
  return [...value].some(
    (char) => char.charCodeAt(0) <= (spaces ? 32 : 31) || char.charCodeAt(0) === 127,
  );
}
// Observed in macOS arm64 QQ's EncodeWeiyunMsgHead and EncodeApplyDownloadFileMsgReq.
const DownloadHead = {
  uin: P(1, S.UINT64, { optional: true }),
  sequence: P(2, S.UINT32, { optional: true }),
  command: P(3, S.UINT32, { optional: true }),
  operation: P(4, S.UINT32, { optional: true }),
  version: P(5, S.UINT32, { optional: true }),
  client: P(6, S.UINT32, { optional: true }),
  platform: P(7, S.UINT32, { optional: true }),
  ticketType: P(10, S.UINT32, { optional: true }),
  ticket: P(11, S.STRING, { optional: true }),
  field14: P(14, S.UINT32, { optional: true }),
  field15: P(15, S.UINT32, { optional: true }),
};
const ApplyRequest = {
  cid: P(1, S.STRING, { optional: true }),
  file: P(2, () => CollectorFileInfo, { optional: true }),
  thumbnail: P(3, S.BOOL, { optional: true }),
};
const RequestBody = {
  operation: P(1, () => ({ apply: P(20014, () => ApplyRequest, { optional: true }) }), {
    optional: true,
  }),
};
const ApplyResponse = {
  // Native hex-encodes these exact bytes for /ftn_handler/. They are not UTF-8 text.
  key: P(1, S.BYTES, { optional: true }),
  host: P(2, S.STRING, { optional: true }),
  port: P(3, S.UINT32, { optional: true }),
  cookieName: P(4, S.STRING, { optional: true }),
  cookieValue: P(5, S.STRING, { optional: true }),
  route: P(6, () => ({ type: P(1, S.UINT32, { optional: true }) }), { optional: true }),
  httpsHost: P(7, S.STRING, { optional: true }),
  httpsPort: P(8, S.UINT32, { optional: true }),
};
const ResponseOperation = { apply: P(20014, () => ApplyResponse, { optional: true }) };
const ResponseBody = {
  operation: P(2, () => ResponseOperation, {
    optional: true,
  }),
};

export interface CollectionDownloadResource {
  /** Ephemeral URL and download-specific cookie; never persist in a receipt or export. */
  url: string;
  cookie: string;
}

export async function applyCollectionFileDownload(
  cred: WebCredential,
  cid: string,
  file: CollectionFileInfo,
  clientBuild: string,
  options: CollectionNetworkOptions = {},
): Promise<CollectionDownloadResource> {
  options.signal?.throwIfAborted();
  if (!COLLECTION_DOWNLOAD_BUILDS.has(clientBuild))
    throw new Error('当前 QQ 版本的收藏附件下载尚未验证。');
  if (
    !/^[1-9]\d*$/.test(cred.uin) ||
    BigInt(cred.uin) > 0xffffffffffffffffn ||
    !cred.pskey ||
    /[\r\n;]/.test(cred.pskey) ||
    !cid ||
    cid.length > 256 ||
    hasControl(cid) ||
    !file.fid ||
    file.fid.length > 4096 ||
    hasControl(file.fid) ||
    !file.name ||
    file.name.length > 4096 ||
    hasControl(file.name) ||
    file.md5?.length !== 16 ||
    typeof file.size !== 'bigint' ||
    file.size < 0n ||
    file.size > 0xffffffffffffffffn
  )
    throw new Error('收藏附件的来源信息不完整。');
  for (const value of [file.src, file.bid, file.category]) {
    if (value !== undefined && (!Number.isInteger(value) || value < 0 || value > 0xffffffff))
      throw new Error('收藏附件的来源信息无效。');
  }
  if (file.uid !== undefined && (file.uid < 0n || file.uid > 0xffffffffffffffffn))
    throw new Error('收藏附件的来源信息无效。');
  if (file.sha1 && file.sha1.length !== 20) throw new Error('收藏附件的来源信息无效。');
  if (file.ntUid && (file.ntUid.length > 256 || hasControl(file.ntUid)))
    throw new Error('收藏附件的来源信息无效。');
  const head = new ProtoMsg(DownloadHead).encode({
    uin: BigInt(cred.uin),
    sequence: 1,
    command: 1,
    operation: 20014,
    version: 0x5f5e1642,
    client: 0x610,
    platform: 4,
    ticketType: 27,
    ticket: cred.pskey,
    field14: 8,
    field15: 9,
  });
  const body = new ProtoMsg(RequestBody).encode({
    operation: {
      apply: {
        cid,
        thumbnail: false,
        file: {
          src: file.src ?? 0,
          uid: file.uid ?? 0n,
          bid: file.bid ?? 0,
          fid: file.fid,
          name: file.name,
          size: file.size,
          md5: file.md5,
          sha1: file.sha1 ?? new Uint8Array(),
          category: file.category ?? 0,
          ntUid: file.ntUid ?? '',
        },
      },
    },
  });
  const bytes = Buffer.from(await postCollector(encodeEnvelope(head, body), cred, options));
  options.signal?.throwIfAborted();
  if (
    bytes.length <= 16 ||
    !bytes.subarray(0, 6).equals(Buffer.from([0x20, 0x13, 0x03, 0x29, 0, 1])) ||
    bytes.readUInt32BE(6) !== bytes.length
  )
    throw new Error('收藏附件下载申请返回无效响应。');
  const bodySize = bytes.readUInt32BE(10);
  if (bodySize === 0 || bodySize >= bytes.length - 16)
    throw new Error('收藏附件下载申请返回无效响应。');
  const split = bytes.length - bodySize;
  const responseHead = new ProtoMsg(CollectorRespHead).decode(bytes.subarray(16, split));
  if ((responseHead.retCode ?? 0) !== 0)
    throw new Error(`收藏附件下载申请失败（代码 ${responseHead.retCode}）。`);
  const decoded = decodeMessage(bytes.subarray(split), ResponseBody) as ProtoDecodeStructType<
    typeof ResponseBody
  >;
  const response = decoded.operation?.apply;
  if (
    response?.route?.type !== 1 ||
    !response.key?.length ||
    response.key.length > 4096 ||
    !response.httpsHost ||
    response.httpsPort !== 443 ||
    !/^[a-z0-9.-]+$/i.test(response.httpsHost) ||
    !response.cookieName ||
    !/^[!#$%&'*+.^_`|~a-z0-9-]+$/i.test(response.cookieName) ||
    !response.cookieValue ||
    hasControl(response.cookieValue, true) ||
    response.cookieValue.includes(';') ||
    response.cookieValue.length > 8192
  )
    throw new Error('收藏附件暂未返回可用的安全下载地址。');
  // A download cookie may only go to collector file hosts, never image domains or redirects.
  if (
    !['qq.com', 'weiyun.com'].some(
      (domain) => response.httpsHost === domain || response.httpsHost!.endsWith(`.${domain}`),
    )
  )
    throw new Error('收藏附件下载地址不受支持。');
  return {
    url: collectionMediaUrl(
      `https://${response.httpsHost}/ftn_handler/${Buffer.from(response.key).toString('hex')}/?fname=${encodeURIComponent(file.name)}`,
    ),
    cookie: `${response.cookieName}=${response.cookieValue}`,
  };
}
