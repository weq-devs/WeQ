import { stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import type { ExportTask } from '@weq/service';
import type { AccountServices } from './context/app_context';
import { getAppContext } from './context/app_context';
import type {
  MessageMediaTarget,
  MessageMediaLocation,
  MessageMediaLocationKind,
} from '../shared/message_media';
import type { MediaSaveSource } from '../shared/media_save';
import { exportTaskResult } from '../shared/export_task_result';
import { findMediaElement } from './media_protocol';

export function savedChatFileKey(source: Extract<MediaSaveSource, { kind: 'chat-file' }>): string {
  return JSON.stringify([
    'chat-file',
    source.fwdResId && !/^\d+$/.test(source.msgId) ? '0' : source.msgId,
    source.fwdMsgId ?? '',
    source.fwdKind ?? '',
    ...(source.fwdResId ? [source.fwdResId] : []),
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

export async function resolveRecordedChatFile(
  services: AccountServices,
  source: Extract<MediaSaveSource, { kind: 'chat-file' }>,
  selected?: Awaited<ReturnType<typeof findMediaElement>>,
) {
  if (!source.fwdKind && !source.fwdMsgId && !source.fwdResId && /^\d+$/.test(source.msgId)) {
    const sent = await services.fileResource.resolveSentFile(source.token ?? '', source.name ?? '');
    if (sent) return { path: sent, name: source.name };
    const info = await services.fileAssistant
      .getFileInfoByMsgId(BigInt(source.msgId))
      .catch(() => null);
    if (info && (!source.name || info.fileName === source.name)) {
      const path = info.localPath.replace(/^::NTOSFull::/, '');
      if (isAbsolute(path) && (await firstFile([path]))) return { path, name: info.fileName };
    }
  }
  if (getAppContext().services !== services) return null;
  const found =
    selected === undefined
      ? await findMediaElement(
          source.msgId,
          'file',
          source.token ?? '',
          source.fwdMsgId,
          source.fwdKind,
          source.fwdResId,
        )
      : selected;
  const file = found?.element;
  if (
    !file?.filePath ||
    (source.token && source.token !== file.fileToken) ||
    (source.name && source.name !== file.fileName) ||
    getAppContext().services !== services
  )
    return null;
  const rawPath = file.filePath.replace(/^::NTOSFull::/, '');
  const path = isAbsolute(rawPath) ? await services.fileResource.resolveLocalFile(rawPath) : null;
  return path ? { path, name: file.fileName || source.name || '文件' } : null;
}

interface LocalMediaLocation extends MessageMediaLocation {
  path: string;
  download?: { taskId: string; result: string };
}

/** 仅定位现成文件；另存记录与缓存独立，绝不下载、解密或复制资源。 */
export async function messageMediaLocations(
  services: AccountServices,
  target: MessageMediaTarget,
  exactFile = false,
): Promise<LocalMediaLocation[]> {
  const context = getAppContext();
  const locations: LocalMediaLocation[] = [];
  const add = (
    kind: MessageMediaLocationKind,
    path: string,
    available = true,
    task?: Pick<ExportTask, 'id' | 'status' | 'save' | 'updatedAt'>,
  ) => {
    const saveStatus = task?.save?.status;
    const download =
      exactFile &&
      target.kind === 'file' &&
      available &&
      task &&
      (!saveStatus || saveStatus === 'saved' || saveStatus === 'pending')
        ? { taskId: task.id, result: exportTaskResult(task).result }
        : undefined;
    const samePath = locations.find((location) => location.path === path);
    if (samePath) {
      if (download && !samePath.download) samePath.download = download;
      return;
    }
    locations.push({
      kind,
      path,
      available,
      ...(download ? { download } : {}),
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
    add('saved', path, Boolean(await firstFile([path])), saved);
  }
  const taskCache = async () => {
    for (const task of tasks) {
      const path = await firstFile([task.filePath]);
      if (path) return { path, task };
    }
    return null;
  };
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
      ])) ?? (await taskCache())?.path;
    if (path) add('cache', path);
    return locations;
  }
  if (target.kind === 'file') {
    const path = (await resolveRecordedChatFile(services, { ...target, kind: 'chat-file' }))?.path;
    if (path) {
      const record = services.accountConfig.getRecord();
      const root = record?.uin ? context.platform?.fileDir(record.uin) : null;
      const sub = root ? relative(root, path) : null;
      const cached =
        sub !== null && sub !== '..' && !sub.startsWith(`..${sep}`) && !isAbsolute(sub);
      add(cached ? 'cache' : 'local', path);
    }
    // 按文件名找到的缓存可定位核对，但不能直接当成该消息的文件打开。
    if (target.fwdKind || target.fwdMsgId || target.fwdResId || exactFile) {
      const cached = await taskCache();
      if (cached) add('cache', cached.path, true, cached.task);
      return locations;
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
    ])) ?? (await taskCache())?.path;
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
