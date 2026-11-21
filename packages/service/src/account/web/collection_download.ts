import type { CollectionFileInfo } from '@weq/db';
import {
  applyCollectionFileDownload as requestDownload,
  CollectionDownloadRejectedError,
  type WebCredential,
} from '@weqbot/protocol';
import { withCollectionTransport, type CollectionNetworkOptions } from './collection';

export type { CollectionDownloadResource } from '@weqbot/protocol';

export async function applyCollectionFileDownload(
  cred: WebCredential,
  cid: string,
  file: CollectionFileInfo,
  clientBuild: string,
  options: CollectionNetworkOptions = {},
) {
  options.signal?.throwIfAborted();
  const { size } = file;
  if (size === undefined) throw new Error('收藏附件的来源信息不完整。');
  return withCollectionTransport(options, (transport) =>
    requestDownload({
      ...cred,
      ...transport,
      cid,
      clientBuild,
      file: {
        src: file.src ?? 0,
        uid: file.uid ?? 0n,
        bid: file.bid ?? 0,
        fid: file.fid ?? '',
        name: file.name ?? '',
        size,
        md5: file.md5 ?? null,
        sha1: file.sha1 ?? null,
        category: file.category ?? 0,
        ntUid: file.ntUid ?? '',
      },
    }),
  ).catch((error: unknown) => {
    if (error instanceof CollectionDownloadRejectedError)
      throw new Error(`收藏附件下载申请失败（代码 ${error.code}）。`);
    throw error;
  });
}
