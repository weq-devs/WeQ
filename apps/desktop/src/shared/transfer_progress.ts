import type { MediaSaveSource } from './media_save';

export type TransferPhase =
  | 'preparing'
  | 'to-host'
  | 'upload'
  | 'download'
  | 'confirming'
  | 'failed';

export interface TransferProgress {
  phase: TransferPhase;
  received?: number;
  total?: number;
  paused?: boolean;
  processed?: number;
  items?: number;
}

export interface ActiveTransfer extends TransferProgress {
  id: string;
  target?: string;
  /** 取消或完成时从下一份快照移除，不作为任务记录保存。 */
  direction: 'upload' | 'download';
}

/** 浏览器和宿主用相同的短标识匹配已知来源，进度快照不携带签名链接或本机路径。 */
export function transferTarget(...parts: string[]): string {
  const text = JSON.stringify(parts);
  let a = 0x811c9dc5;
  let b = 0xa2f9be1d;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ code, 0x27d4eb2d);
  }
  return `${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`;
}

export function mediaTransferTarget(source: MediaSaveSource): string {
  if (source.kind === 'group-file')
    return transferTarget(
      'group-file',
      source.groupCode,
      source.fileId,
      String(source.busId ?? 102),
    );
  if (source.kind === 'chat-file')
    return transferTarget(
      'chat-file',
      source.fwdResId && !/^\d+$/.test(source.msgId) ? '0' : source.msgId,
      source.fwdMsgId ?? '',
      source.fwdKind ?? '',
      source.fwdResId ?? '',
      source.conv ?? '',
      source.token ?? '',
      source.name ?? '',
    );
  if (source.progressTarget) return source.progressTarget;
  try {
    const url = new URL(source.url, 'http://weq.local');
    const path =
      url.protocol === 'weq-media:' ? `/_media/${url.host}${url.pathname}` : url.pathname;
    if (/^\/_(?:media|asset)\//.test(path)) {
      for (const key of ['intent', '_weq_retry']) url.searchParams.delete(key);
      url.searchParams.sort();
      return transferTarget('url', `${path}?${url.searchParams}`);
    }
    return transferTarget('url', url.href);
  } catch {
    return transferTarget('url', source.url);
  }
}

export const flashFilesetTransferTarget = (id: string, direction: 'upload' | 'download') =>
  transferTarget('flash', direction, id);
export const flashFileTransferTarget = (id: string, physicalId: string) =>
  transferTarget('flash-file', id, physicalId);
export const albumMediaTransferTarget = (owner: string, album: string, media: string) =>
  transferTarget('qzone-album', owner, album, media);
export const qzoneBatchTransferTarget = (owner: string) => transferTarget('qzone-batch', owner);
export const groupBatchTransferTarget = (group: string) =>
  transferTarget('group-file-batch', group);
export const messageTransferTarget = (
  kind: 'pic' | 'video',
  msgId: string,
  token: string,
  name: string,
  forward?: { fwdMsgId?: string; fwdResId?: string },
) =>
  msgId || forward?.fwdResId
    ? transferTarget(
        'message-media',
        kind,
        forward?.fwdResId || msgId,
        forward?.fwdMsgId ?? '',
        token,
        name,
      )
    : undefined;

export function transferPercent(progress: TransferProgress): number | undefined {
  const { phase, total, received } = progress;
  return (phase === 'upload' || phase === 'download' || phase === 'to-host') &&
    total &&
    Number.isSafeInteger(total) &&
    total > 0 &&
    received !== undefined &&
    received >= 0 &&
    received <= total
    ? Math.min(99, Math.floor((received / total) * 100))
    : undefined;
}
