import { stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import type { AccountServices } from './context/app_context';
import { getAppContext } from './context/app_context';
import type {
  MessageMediaTarget,
  MessageMediaLocation,
  MessageMediaLocationKind,
} from '../shared/message_media';
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

interface LocalMediaLocation extends MessageMediaLocation {
  path: string;
}

/** 仅定位现成文件；另存记录与缓存独立，绝不下载、解密或复制资源。 */
export async function messageMediaLocations(
  services: AccountServices,
  target: MessageMediaTarget,
): Promise<LocalMediaLocation[]> {
  const context = getAppContext();
  const locations: LocalMediaLocation[] = [];
  const add = (kind: MessageMediaLocationKind, path: string, available = true) => {
    if (locations.some((location) => location.path === path)) return;
    locations.push({
      kind,
      path,
      available,
      key: createHash('sha256')
        .update(JSON.stringify([kind, path]))
        .digest('hex'),
    });
  };
  const savedKey =
    target.kind === 'file'
      ? savedChatFileKey({ ...target, kind: 'chat-file' })
      : target.url
        ? savedMediaSourceKey({ kind: 'url', url: target.url })
        : undefined;
  const tasks = savedKey
    ? services.exportManager
        .listTasks()
        .filter(
          (task) =>
            task.status === 'completed' &&
            task.resource?.kind === 'media' &&
            task.resource.sourceKey === savedKey,
        )
    : [];
  const saved = tasks
    .filter((task) => task.save?.path)
    .sort((a, b) => (b.save?.savedAt ?? b.createdAt) - (a.save?.savedAt ?? a.createdAt))[0];
  if (saved?.save?.path) {
    const path = saved.save.path;
    add('saved', path, Boolean(await firstFile([path])));
  }
  const taskCache = () => firstFile(tasks.map((task) => task.filePath));
  if (target.kind === 'mface') {
    if (!/^\d+$/.test(target.pack) || !/^[a-f\d]{1,128}$/i.test(target.hash)) return locations;
    const root = context.platform?.appDataRoot();
    const record = services.accountConfig.getRecord();
    const qq = record?.uin ? context.platform?.marketFaceDir(record.uin) : null;
    const path =
      (await firstFile([
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
      ])) ?? (await taskCache());
    if (path) add('cache', path);
    return locations;
  }
  if (target.kind === 'file' && /^\d+$/.test(target.msgId)) {
    const info = await services.fileAssistant
      .getFileInfoByMsgId(BigInt(target.msgId))
      .catch(() => null);
    if (info && (!target.name || info.fileName === target.name)) {
      const path = await firstFile([info.localPath.replace(/^::NTOSFull::/, '')]);
      if (path) {
        const record = services.accountConfig.getRecord();
        const root = record?.uin ? context.platform?.fileDir(record.uin) : null;
        const sub = root ? relative(root, path) : null;
        const cached =
          sub !== null && sub !== '..' && !sub.startsWith(`..${sep}`) && !isAbsolute(sub);
        add(cached ? 'cache' : 'local', path);
      }
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
  const path =
    (await firstFile([
      found.source,
      // emoji 的 thumb 实际是可显示的完整表情；file 的 thumb 只是通用图标。
      target.kind === 'emoji' ? found.thumb : null,
      services.mediaDownload.cachedFile(target.token, ext),
      ...(media && ext && target.token
        ? [
            join(
              media,
              target.kind,
              `${createHash('sha1').update(target.token).digest('hex')}${ext}`,
            ),
          ]
        : []),
    ])) ?? (await taskCache());
  if (path)
    add(
      target.kind === 'ptt' && /\.(wav|mp3|ogg|m4a)$/i.test(extname(path)) ? 'transcoded' : 'cache',
      path,
    );
  else if (target.kind === 'pic' || target.kind === 'video') {
    const thumb = await firstFile([
      found.thumb,
      target.kind === 'video' ? services.mediaDownload.cachedFile(target.token, '.jpg') : null,
    ]);
    if (thumb) add(target.kind === 'pic' ? 'thumbnail' : 'cover', thumb);
  }
  return locations;
}
