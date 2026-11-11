import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { AccountServices } from './context/app_context';
import { getAppContext } from './context/app_context';
import type { MessageMediaTarget } from '../shared/message_media';

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
