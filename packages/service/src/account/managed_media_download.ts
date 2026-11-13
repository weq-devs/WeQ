import { createReadStream, constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { copyFile, link, lstat, mkdir, unlink } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { ManagedDownload } from '../common/managed_download';
import { scopedNetworkAllowed } from '../common/network_scope';
import { mediaSignature, type DownloadOptions, type DownloadOutcome } from './media_url';

const pending = new Map<string, { url: string; work: Promise<DownloadOutcome> }>();
/** 相同目标共享传输，不让两个写入器同时修改续传分段。 */
export async function managedMediaDownload(
  url: string,
  dest: string,
  options: DownloadOptions = {},
): Promise<DownloadOutcome> {
  const active = pending.get(dest);
  if (active)
    return active.url === url
      ? active.work
      : { ok: false, reason: '目标正在下载其他资源，已保留现有任务。' };
  const work = runManagedMediaDownload(url, dest, options).finally(() => pending.delete(dest));
  pending.set(dest, { url, work });
  return work;
}

/** 应用内文件下载复用原有格式／哈希校验，网络暂停不丢弃已验证的续传信息。 */
async function runManagedMediaDownload(
  url: string,
  dest: string,
  options: DownloadOptions,
): Promise<DownloadOutcome> {
  if (!scopedNetworkAllowed()) return { ok: false, reason: '省流量模式已暂缓自动加载' };
  let sha256 = '';
  let contentType = '';
  let bytes = 0;
  let finalUrl = url;
  const transfer = new ManagedDownload({
    name: `下载 · ${basename(dest)}`,
    total: options.expectedSize,
    signal: options.signal,
    maxBytes: options.maxBytes,
    timeoutMs: options.timeoutMs,
    fetcher: options.fetcher
      ? (input, init) =>
          options.fetcher!(String(input), {
            signal: init?.signal ?? AbortSignal.timeout(60000),
            headers: init?.headers ? Object.fromEntries(new Headers(init.headers)) : undefined,
          })
      : undefined,
    validate: async (path, response, size) => {
      bytes = size;
      contentType = (response.headers.get('content-type') ?? '').toLowerCase();
      finalUrl = response.url || url;
      if (!options.allowText && /^(text\/)|json|xml/.test(contentType))
        throw new Error('媒体返回了错误页面。');
      const hash = createHash('sha256');
      let prefix = Buffer.alloc(0);
      for await (const chunk of createReadStream(path)) {
        options.signal?.throwIfAborted();
        hash.update(chunk);
        if (prefix.length < 512)
          prefix = Buffer.concat([prefix, chunk.subarray(0, 512 - prefix.length)]);
      }
      sha256 = hash.digest('hex');
      if (
        !bytes ||
        (!options.allowText && /^\s*(?:<!doctype|<html|<\?xml)/i.test(prefix.toString('utf8')))
      )
        throw new Error('媒体为空或返回了错误页面。');
      if (options.expectedKind && !mediaSignature(prefix, options.expectedKind))
        throw new Error('媒体格式与期望不符。');
      if (options.expectedSize !== undefined && bytes !== options.expectedSize)
        throw new Error('媒体大小与来源记录不符。');
      if (options.expectedSha256 && sha256 !== options.expectedSha256.toLowerCase())
        throw new Error('媒体哈希与来源记录不符。');
    },
    publish: async (part, target) => {
      try {
        try {
          await link(part, target);
        } catch (error) {
          if (
            !['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV'].includes(
              (error as NodeJS.ErrnoException).code ?? '',
            )
          )
            throw error;
          await copyFile(part, target, constants.COPYFILE_EXCL);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const info = await lstat(target);
        if (!info.isFile() || info.isSymbolicLink() || info.size !== bytes)
          throw new Error('目标已有不同内容，已保留原文件。');
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(target)) hash.update(chunk);
        if (hash.digest('hex') !== sha256) throw new Error('目标已有不同内容，已保留原文件。');
      }
      await unlink(part);
    },
  });
  try {
    await mkdir(dirname(dest), { recursive: true });
    await transfer.file(url, dest, {}, (received, total) => options.onProgress?.(received, total));
    return { ok: true, bytes, sha256, contentType, ...(options.allowText ? { finalUrl } : {}) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
