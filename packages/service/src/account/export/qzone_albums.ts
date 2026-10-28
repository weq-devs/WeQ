import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { QzoneAlbumPage, QzoneAlbumMediaResult } from '../web/qzone_album';
import type { ExportTimeRange } from './types';
import type { QzoneMediaStore } from './qzone_media_store';

export interface QzoneAlbumExportDeps {
  fetchAlbumPage(targetUin: string, offset: number, signal?: AbortSignal): Promise<QzoneAlbumPage>;
  fetchAlbumPhotos(
    targetUin: string,
    albumId: string,
    start: number,
    count: number,
  ): Promise<QzoneAlbumMediaResult>;
  fetchAlbumVideo(targetUin: string, albumId: string, picKey: string): Promise<string>;
}
const PAGE_SIZE = 30;
const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );

/** 复用已验证的空间相册分页接口，元数据引用公共媒体池，不再按相册复制同图。 */
export async function exportQzoneAlbums(
  opts: {
    targetUin: string;
    directory: string;
    range?: ExportTimeRange;
    formats: string[];
    media: QzoneMediaStore;
    downloadMedia: boolean;
    signal: AbortSignal;
    progress(current: number, total: number): void;
  },
  deps: QzoneAlbumExportDeps,
) {
  const albums: QzoneAlbumPage['albums'] = [];
  const seenAlbums = new Set<string>();
  const offsets = new Set<number>();
  let offset: number | null = 0;
  const failed: Array<{ fileName: string; error: string }> = [];
  while (offset !== null) {
    opts.signal.throwIfAborted();
    if (offsets.has(offset) || offsets.size >= 10000)
      throw new Error('相册目录分页未结束，已停止重复读取。');
    offsets.add(offset);
    const page = await deps.fetchAlbumPage(opts.targetUin, offset, opts.signal);
    opts.signal.throwIfAborted();
    let freshAlbums = 0;
    for (const album of page.albums)
      if (!seenAlbums.has(album.id)) {
        seenAlbums.add(album.id);
        albums.push(album);
        freshAlbums++;
      }
    if (page.nextOffset !== null && page.albums.length > 0 && !freshAlbums)
      throw new Error('相册目录重复，已停止读取。');
    if (page.warning) failed.push({ fileName: '相册目录', error: page.warning });
    if (page.nextOffset !== null && page.nextOffset <= offset)
      throw new Error('相册目录游标未推进。');
    offset = page.nextOffset;
  }
  const records: Array<{
    album: QzoneAlbumPage['albums'][number];
    media: Array<
      QzoneAlbumMediaResult['photos'][number] & {
        localPath?: string;
        downloadedAs?: 'image' | 'video';
        error?: string;
      }
    >;
  }> = [];
  let ok = 0;
  for (const album of albums) {
    const record: (typeof records)[number] = { album, media: [] };
    records.push(record);
    const seen = new Set<string>();
    let start = 0;
    try {
      for (let pageIndex = 0; ; pageIndex++) {
        opts.signal.throwIfAborted();
        if (pageIndex >= 10000) throw new Error('相册媒体分页达到上限。');
        const page = await deps.fetchAlbumPhotos(opts.targetUin, album.id, start, PAGE_SIZE);
        opts.signal.throwIfAborted();
        if (!page.photos.length) {
          if (start < page.totalInAlbum) throw new Error('相册媒体分页提前返回空页。');
          break;
        }
        let fresh = 0;
        for (const photo of page.photos) {
          opts.signal.throwIfAborted();
          const key = `${photo.isVideo}:${photo.picKey || photo.url || photo.thumbUrl || photo.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          fresh++;
          if ((opts.range?.start != null || opts.range?.end != null) && !photo.uploadTime) {
            const error = '媒体缺少上传时间，无法归入所选日期。';
            record.media.push({ ...photo, error });
            failed.push({ fileName: `${album.name}/${photo.name || photo.id}`, error });
            continue;
          }
          if (
            (opts.range?.start != null && photo.uploadTime < opts.range.start) ||
            (opts.range?.end != null && photo.uploadTime > opts.range.end)
          )
            continue;
          const item: (typeof record.media)[number] = { ...photo };
          record.media.push(item);
          if (!opts.downloadMedia) {
            ok++;
            continue;
          }
          try {
            let url = photo.url || photo.thumbUrl;
            let kind: 'image' | 'video' = 'image';
            if (photo.isVideo && photo.picKey) {
              try {
                const video = await deps.fetchAlbumVideo(opts.targetUin, album.id, photo.picKey);
                if (video) {
                  url = video;
                  kind = 'video';
                }
              } catch {
                opts.signal.throwIfAborted();
              }
            }
            if (!url) throw new Error('媒体缺少下载地址。');
            const result = await opts.media.save(url, kind, opts.signal);
            if (!result.ok) throw new Error(result.reason);
            item.localPath = `media/${result.fileName}`;
            item.downloadedAs = kind;
            if (photo.isVideo && kind !== 'video') throw new Error('视频本体不可用，已保留封面。');
            ok++;
          } catch (error) {
            opts.signal.throwIfAborted();
            item.error = error instanceof Error ? error.message : String(error);
            failed.push({ fileName: `${album.name}/${photo.name || photo.id}`, error: item.error });
          }
          opts.progress(ok + failed.length, ok + failed.length);
        }
        if (!fresh) throw new Error('相册媒体分页重复，已停止。');
        start += page.photos.length;
        if (page.totalInAlbum > 0 ? start >= page.totalInAlbum : page.photos.length < PAGE_SIZE)
          break;
      }
    } catch (error) {
      opts.signal.throwIfAborted();
      failed.push({
        fileName: `${album.name}/相册读取`,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const metadataRoot = join(opts.directory, 'albums');
  await mkdir(metadataRoot, { recursive: true });
  await writeFile(
    join(metadataRoot, 'index.json'),
    JSON.stringify(
      { targetUin: opts.targetUin, range: opts.range, albums: records, failed },
      null,
      2,
    ),
    { flag: 'wx', signal: opts.signal },
  );
  if (opts.formats.includes('txt'))
    await writeFile(
      join(metadataRoot, 'index.txt'),
      records
        .map(
          (record) =>
            `${record.album.name}\n${record.media.map((item) => `${item.name}\t${item.localPath || item.error || ''}`).join('\n')}`,
        )
        .join('\n\n'),
      { flag: 'wx', signal: opts.signal },
    );
  if (opts.formats.includes('html'))
    await writeFile(
      join(metadataRoot, 'index.html'),
      `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>空间相册</title><style>:root{color-scheme:light dark}body{font-family:system-ui;max-width:1000px;margin:auto;padding:20px}img,video{max-width:100%;max-height:600px}figure{display:inline-block;vertical-align:top;max-width:300px;margin:12px}figcaption{overflow-wrap:anywhere}</style><h1>空间相册</h1>${records.map((record) => `<section><h2>${escapeHtml(record.album.name)}</h2>${record.media.map((item) => `<figure>${item.localPath ? (item.downloadedAs === 'video' ? `<video controls src="${escapeHtml(`../${item.localPath}`)}"></video>` : `<img loading="lazy" src="${escapeHtml(`../${item.localPath}`)}" alt="${escapeHtml(item.name)}">`) : ''}<figcaption>${escapeHtml(item.name)}${item.error ? ` · ${escapeHtml(item.error)}` : ''}</figcaption></figure>`).join('')}</section>`).join('')}</html>`,
      { flag: 'wx', signal: opts.signal },
    );
  return { total: ok + failed.length, ok, failed, albums: records.length };
}
