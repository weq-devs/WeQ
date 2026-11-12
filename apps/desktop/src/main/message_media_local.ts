import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { AccountServices } from './context/app_context';
import { getAppContext } from './context/app_context';
import type { MessageMediaTarget } from '../shared/message_media';
import type { MediaSaveSource } from '../shared/media_save';

export function savedChatFileKey(source: Extract<MediaSaveSource, { kind: 'chat-file' }>): string {
  return JSON.stringify([
    'chat-file',
    source.msgId,
    source.fwdMsgId ?? '',
    source.fwdKind ?? '',
    source.conv ?? '',
    source.token ?? '',
    source.name ?? '',
  ]);
}

export function savedMediaSourceKey(source: MediaSaveSource): string | undefined {
  if (source.kind === 'chat-file') return savedChatFileKey(source);
  if (source.kind !== 'url') return undefined;
  const url = new URL(source.url, 'http://weq.local');
  const path = url.protocol === 'weq-media:' ? `/_media/${url.host}${url.pathname}` : url.pathname;
  url.searchParams.sort();
  const identity = path.startsWith('/_media/') ? `${path}?${url.searchParams}` : url.href;
  return `media-url:${createHash('sha256').update(identity).digest('hex')}`;
}

async function firstFile(paths: (string | null | undefined)[]): Promise<string | null> {
  for (const path of paths) if (path && (await stat(path).catch(() => null))?.isFile()) return path;
  return null;
}

/** 仅定位现成文件，绝不调用会下载、解密或复制资源的 getter。 */
export async function localMessageMedia(
  services: AccountServices,
  target: MessageMediaTarget,
): Promise<string | null> {
  const context = getAppContext();
  const savedKey =
    target.kind === 'file'
      ? savedChatFileKey({ ...target, kind: 'chat-file' })
      : target.url
        ? savedMediaSourceKey({ kind: 'url', url: target.url })
        : undefined;
  if (savedKey) {
    for (const task of services.exportManager.listTasks()) {
      if (
        task.status !== 'completed' ||
        task.resource?.kind !== 'media' ||
        task.resource.sourceKey !== savedKey
      )
        continue;
      const path = await firstFile([
        task.save?.status === 'saved' ? task.save.path : null,
        task.filePath,
      ]);
      if (path) return path;
    }
  }
  if (target.kind === 'mface') {
    if (!/^\d+$/.test(target.pack) || !/^[a-f\d]{1,128}$/i.test(target.hash)) return null;
    const root = context.platform?.appDataRoot();
    const record = services.accountConfig.getRecord();
    const qq = record?.uin ? context.platform?.marketFaceDir(record.uin) : null;
    return firstFile([
      ...(root
        ? ['gif', 'png'].flatMap((ext) => [
            join(root, 'cache', 'marketface', `${target.hash}.${ext}`),
            join(root, 'cache', 'marketpack', target.pack, `${target.hash}.${ext}`),
          ])
        : []),
      ...(qq
        ? [
            target.hash,
            `${target.hash}_aio.png`,
            `${target.hash}.png`,
            `${target.hash}_thu.png`,
          ].map((name) => join(qq, target.pack, name))
        : []),
    ]);
  }
  if (target.kind === 'file' && /^\d+$/.test(target.msgId)) {
    const info = await services.fileAssistant
      .getFileInfoByMsgId(BigInt(target.msgId))
      .catch(() => null);
    if (info && (!target.name || info.fileName === target.name)) {
      const path = await firstFile([info.localPath.replace(/^::NTOSFull::/, '')]);
      if (path) return path;
    }
  }
  const found = await services.fileSearch.findFile(
    target.t,
    target.name,
    target.kind,
    target.md5 || undefined,
  );
  const media = context.bootstrap?.userConfig.cacheDir('media');
  const ext = target.kind === 'video' ? '.mp4' : target.kind === 'ptt' ? '.silk' : '';
  return firstFile([
    found.source,
    found.thumb,
    services.mediaDownload.cachedFile(target.token, ext),
    ...(media && ext && target.token
      ? [join(media, target.kind, `${createHash('sha1').update(target.token).digest('hex')}${ext}`)]
      : []),
  ]);
}
