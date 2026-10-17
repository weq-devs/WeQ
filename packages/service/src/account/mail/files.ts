import https from 'node:https';
import type { IncomingMessage } from 'node:http';
import { createCipheriv, createHash, randomUUID } from 'node:crypto';
import { copyFile, link, open, statfs, unlink, type FileHandle } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import {
  Sha1Stream,
  detectImageFormat,
  PIC_FORMAT_PNG,
  PIC_FORMAT_JPEG,
  PIC_FORMAT_GIF,
  PIC_FORMAT_WEBP,
} from '@weq/protocol';
import type { MailAuth } from './auth';
import type { MailAttachmentRegistry } from './attachments';
import { MailFailure, type MailAttachment } from './types';
import { MAIL_PART_SIZE, items, object, text } from './wire';

export const MAIL_MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
export interface MailPart {
  start: number;
  endOffset: number;
  partNumber: number;
  cumulativeSha1: string;
}
export interface MailFileHash {
  md5: string;
  sha: string;
  parts: MailPart[];
}
interface Encryption {
  key: Buffer;
  iv: Buffer;
}
export interface StorageResponse {
  etag: string;
}
export type StorageRequest = (
  url: URL,
  method: 'PUT' | 'POST',
  body: Buffer,
  signal: AbortSignal,
) => Promise<StorageResponse>;
export type MailDownloadRequest = (
  url: URL,
  cookie: string,
  signal: AbortSignal,
) => Promise<IncomingMessage>;

const requestMailDownload: MailDownloadRequest = (url, cookie, signal) =>
  new Promise((resolve, reject) => {
    const request = https.get(url, { signal, headers: cookie ? { Cookie: cookie } : {} }, resolve);
    request.setTimeout(180_000, () => request.destroy());
    request.on('error', () => reject(new MailFailure('network', '附件下载连接失败。')));
  });

export async function loadMailInlineImage(
  auth: MailAuth,
  registry: MailAttachmentRegistry,
  id: string,
  signal: AbortSignal,
  request: MailDownloadRequest = requestMailDownload,
): Promise<{ mime: string; base64: string }> {
  const credentials = await auth.downloadCredentials(registry.imageUrl(id), false, signal);
  let url = mailStorageUrl(credentials.url);
  for (let hop = 0; hop < 5; hop++) {
    signal.throwIfAborted();
    const response = await request(
      url,
      url.hostname === credentials.url.hostname ? credentials.cookie : '',
      signal,
    );
    if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0) && response.headers.location) {
      response.resume();
      url = mailStorageUrl(new URL(response.headers.location, url));
      continue;
    }
    if (response.statusCode !== 200) {
      response.resume();
      throw new MailFailure('business', '邮箱图片暂时无法加载。');
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const abort = (): void => {
      response.destroy();
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      for await (const chunk of response) {
        const bytes = Buffer.from(chunk as Uint8Array);
        size += bytes.length;
        if (size > 10 * 1024 * 1024) {
          response.destroy();
          throw new MailFailure('business', '邮箱图片超过大小上限。');
        }
        chunks.push(bytes);
      }
    } finally {
      signal.removeEventListener('abort', abort);
    }
    signal.throwIfAborted();
    const bytes = Buffer.concat(chunks),
      image = detectImageFormat(bytes);
    const mime = new Map([
      [PIC_FORMAT_PNG, 'image/png'],
      [PIC_FORMAT_JPEG, 'image/jpeg'],
      [PIC_FORMAT_GIF, 'image/gif'],
      [PIC_FORMAT_WEBP, 'image/webp'],
    ]).get(image.format);
    if (!mime || image.width <= 0 || image.height <= 0 || image.width * image.height > 25_000_000)
      throw new MailFailure('business', '邮箱图片格式无效或尺寸过大。');
    return { mime, base64: bytes.toString('base64') };
  }
  throw new MailFailure('business', '邮箱图片跳转次数过多。');
}

export function mailStorageUrl(raw: string | URL): URL {
  const url = new URL(raw);
  if (
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    !(url.hostname.endsWith('.qq.com') || url.hostname.endsWith('.qqmail.com'))
  )
    throw new MailFailure('business', '附件服务器地址不受信任。');
  return url;
}

export function encryptMailPart(bytes: Buffer, encryption: Encryption, offset: number): Buffer {
  if (
    ![16, 24, 32].includes(encryption.key.length) ||
    encryption.iv.length !== 16 ||
    offset % 16 !== 0
  )
    throw new MailFailure('business', '附件加密参数无效。');
  const counter =
    (BigInt(`0x${encryption.iv.toString('hex')}`) + BigInt(offset / 16)) & ((1n << 128n) - 1n);
  const iv = Buffer.from(counter.toString(16).padStart(32, '0'), 'hex');
  const cipher = createCipheriv(`aes-${encryption.key.length * 8}-ctr`, encryption.key, iv);
  return Buffer.concat([cipher.update(bytes), cipher.final()]);
}

async function readPart(
  handle: FileHandle,
  offset: number,
  length: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    signal.throwIfAborted();
    const result = await handle.read(buffer, read, length - read, offset + read);
    if (!result.bytesRead)
      throw new MailFailure('business', '附件内容在读取期间发生变化，请重新选择。');
    read += result.bytesRead;
  }
  return buffer;
}

/** CStore 的非末片 SHA1 是未 padding 的累计状态，不是每片独立摘要。 */
export async function hashMailFile(
  handle: FileHandle,
  size: number,
  signal: AbortSignal,
  encryption?: Encryption,
): Promise<MailFileHash> {
  const md5 = createHash('md5'),
    sha1 = createHash('sha1'),
    state = new Sha1Stream();
  const parts: MailPart[] = [];
  for (let offset = 0; offset < size; offset += MAIL_PART_SIZE) {
    const raw = await readPart(handle, offset, Math.min(MAIL_PART_SIZE, size - offset), signal);
    md5.update(raw);
    const encoded = encryption ? encryptMailPart(raw, encryption, offset) : raw;
    sha1.update(encoded);
    const last = offset + raw.length === size;
    if (!last) state.update(encoded);
    parts.push({
      start: offset,
      endOffset: offset + raw.length,
      partNumber: parts.length + 1,
      cumulativeSha1: last ? sha1.digest('hex') : Buffer.from(state.hash(true)).toString('hex'),
    });
  }
  return { md5: md5.digest('hex'), sha: parts.at(-1)?.cumulativeSha1 ?? '', parts };
}

export const requestMailStorage: StorageRequest = async (raw, method, body, signal) => {
  const url = mailStorageUrl(raw);
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        method,
        signal,
        headers: {
          'Content-Type':
            method === 'PUT' ? 'application/octet-stream' : 'text/plain;charset=UTF-8',
          'Content-Length': body.length,
        },
      },
      (response) => {
        let length = 0;
        response.on('data', (chunk: Buffer) => {
          length += chunk.length;
          if (length > 64 * 1024) request.destroy();
        });
        response.on('error', () => reject(new MailFailure('network', '附件传输连接中断。')));
        response.on('end', () => {
          const status = response.statusCode ?? 0;
          if (status !== 200 && status !== 201)
            reject(
              new MailFailure(
                status >= 500 || status === 429 ? 'network' : 'business',
                `附件服务器拒绝请求（${status}）。`,
              ),
            );
          else resolve({ etag: text(response.headers.etag) });
        });
      },
    );
    request.setTimeout(180_000, () => request.destroy());
    request.on('error', () =>
      reject(new MailFailure('network', signal.aborted ? '附件传输已取消。' : '附件传输失败。')),
    );
    request.end(body);
  });
};

async function storageWithRetry(
  request: StorageRequest,
  url: URL,
  method: 'PUT' | 'POST',
  bytes: Buffer,
  signal: AbortSignal,
): Promise<StorageResponse> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try {
      return await request(url, method, bytes, signal);
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof MailFailure) || error.kind !== 'network' || attempt >= 3) throw error;
      await delay((attempt + 1) * 1000, undefined, { signal });
    }
  }
}

export async function uploadMailFile(
  auth: MailAuth,
  registry: MailAttachmentRegistry,
  path: string,
  signal: AbortSignal,
  request: StorageRequest = requestMailStorage,
): Promise<MailAttachment> {
  const handle = await open(path, 'r');
  let encryption: Encryption | undefined;
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size <= 0 || before.size > MAIL_MAX_FILE_BYTES)
      throw new MailFailure('business', '请选择非空且不超过 2 GB 的文件。');
    const name = basename(path),
      big = before.size > 50 * 1024 * 1024;
    const hash = await hashMailFile(handle, before.size, signal);
    const key = await auth.cgi(
      '/attach/get_enc_key',
      { bizid: big ? 2 : 50, size: before.size, md5: hash.md5, filename: name },
      { signal },
    );
    if (text(key.key_b64) || text(key.iv_b64)) {
      encryption = {
        key: Buffer.from(text(key.key_b64), 'base64url'),
        iv: Buffer.from(text(key.iv_b64), 'base64url'),
      };
      // 先验证材料，失败时不静默降级为未加密上传。
      encryptMailPart(Buffer.alloc(0), encryption, 0);
    }
    const encoded = encryption ? await hashMailFile(handle, before.size, signal, encryption) : hash;
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
      throw new MailFailure('business', '附件内容在扫描期间发生变化，请重新选择。');
    const params = {
      sha: hash.sha,
      md5: hash.md5,
      name,
      size: before.size,
      bizid: big ? 2 : 50,
      support_cstore: true,
      sys_type: big ? 1 : undefined,
      dir_fileid: big ? '/ftn' : undefined,
      create_from: 'compose',
      enc_key: encryption?.key.toString('base64'),
      enc_iv: encryption?.iv.toString('base64'),
      enc_sha: encryption ? encoded.sha : undefined,
      enc_size: encryption ? before.size : undefined,
    };
    const created = await auth.cgi(big ? '/myfile/create' : '/attach/create', params, {
      signal,
      write: true,
    });
    const fileId = text(created.fileid),
      ukey = text(created.upload_key ?? created.ukey);
    if (!fileId) throw new MailFailure('business', '邮箱未返回附件标识。');
    if (!created.is_exist) {
      const root = mailStorageUrl(`https://${text(created.dns)}/`);
      if (root.pathname !== '/' || root.search)
        throw new MailFailure('business', '附件上传服务器地址无效。');
      const base = new URL(`${big ? 1373 : 1371}/${encodeURIComponent(fileId)}`, root);
      if (!ukey) throw new MailFailure('business', '邮箱未返回附件上传凭据。');
      base.searchParams.set('ukey', ukey);
      if (encoded.parts.length > 1) {
        const init = new URL(base);
        init.searchParams.set('init', '');
        const body = {
          partcount: encoded.parts.length,
          parts: encoded.parts.map((part) => ({
            endoffset: part.endOffset,
            partnumber: part.partNumber,
            cumulatesha1: part.cumulativeSha1,
          })),
        };
        await storageWithRetry(request, init, 'POST', Buffer.from(JSON.stringify(body)), signal);
      }
      const completed: { partnumber: number; ETag: string }[] = [];
      for (const part of encoded.parts) {
        const bytes = await readPart(handle, part.start, part.endOffset - part.start, signal);
        const url = new URL(base);
        if (encoded.parts.length > 1) url.searchParams.set('partnumber', String(part.partNumber));
        const result = await storageWithRetry(
          request,
          url,
          'PUT',
          encryption ? encryptMailPart(bytes, encryption, part.start) : bytes,
          signal,
        );
        if (encoded.parts.length > 1 && !result.etag)
          throw new MailFailure('business', '附件分片未返回校验标识。');
        completed.push({ partnumber: part.partNumber, ETag: result.etag });
      }
      if (completed.length > 1) {
        const complete = new URL(base);
        complete.searchParams.set('complete', '');
        await storageWithRetry(
          request,
          complete,
          'POST',
          Buffer.from(JSON.stringify({ partcount: completed.length, parts: completed })),
          signal,
        );
      }
    }
    const finalStat = await handle.stat();
    if (before.size !== finalStat.size || before.mtimeMs !== finalStat.mtimeMs)
      throw new MailFailure('business', '附件内容在上传期间发生变化，请重新选择。');
    let share: Record<string, unknown> = {};
    if (big) {
      const response = await auth.cgi(
        '/myfile/share_mgr',
        { func: 1, ttl: 30, method: 2, info: [{ file_id: fileId }] },
        { signal, write: true },
      );
      share = object(items(response.info)[0]);
      if (!text(share.key) || !text(share.code))
        throw new MailFailure('business', '超大附件分享记录创建失败。');
    }
    signal.throwIfAborted();
    return registry.register({
      fileId,
      name,
      size: before.size,
      big,
      available: true,
      bizId: big ? 2 : 50,
      key: text(share.key) || undefined,
      code: text(share.code) || undefined,
    });
  } catch (error) {
    if (error instanceof MailFailure) throw error;
    throw new MailFailure(
      'business',
      signal.aborted ? '附件传输已取消。' : '附件读取或上传失败，请重新选择。',
    );
  } finally {
    encryption?.key.fill(0);
    encryption?.iv.fill(0);
    await handle.close();
  }
}

/** 不覆盖已有文件；跨主机跳转时不转发邮箱 Cookie。 */
export async function downloadMailFile(
  auth: MailAuth,
  registry: MailAttachmentRegistry,
  id: string,
  destination: string,
  signal: AbortSignal,
  request: MailDownloadRequest = requestMailDownload,
): Promise<void> {
  const source = registry.get(id);
  if (!source.big && source.mailId)
    await auth.cgi(
      '/attach/download',
      { func: 5, bizid: 2, mailid: source.mailId, name: source.name },
      { signal },
    );
  const credentials = await auth.downloadCredentials(registry.downloadUrl(id), source.big, signal);
  const temporary = `${destination}.${randomUUID()}.part`;
  let created = false;
  try {
    let url = mailStorageUrl(credentials.url);
    for (let hop = 0; hop < 6; hop++) {
      signal.throwIfAborted();
      const cookie = url.hostname === credentials.url.hostname ? credentials.cookie : '';
      const response = await request(url, cookie, signal);
      if (
        [301, 302, 303, 307, 308].includes(response.statusCode ?? 0) &&
        response.headers.location
      ) {
        response.resume();
        url = mailStorageUrl(new URL(response.headers.location, url));
        continue;
      }
      if (
        response.statusCode !== 200 ||
        (response.headers.logicret && response.headers.logicret !== '0')
      ) {
        response.resume();
        throw new MailFailure('business', '附件下载失败，文件可能已过期。');
      }
      let bytes = 0;
      const inspect = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          bytes += chunk.length;
          done(
            bytes > MAIL_MAX_FILE_BYTES
              ? new MailFailure('business', '附件超过下载大小上限。')
              : null,
            chunk,
          );
        },
      });
      let handle: FileHandle;
      try {
        handle = await open(temporary, 'wx', 0o600);
      } catch (error) {
        response.destroy();
        throw error;
      }
      created = true;
      await pipeline(response, inspect, handle.createWriteStream({ autoClose: true }), { signal });
      if (source.size > 0 && bytes !== source.size)
        throw new MailFailure('business', '附件下载不完整，请重试。');
      try {
        await link(temporary, destination);
      } catch (error) {
        if (
          !['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV'].includes(
            (error as NodeJS.ErrnoException).code ?? '',
          )
        )
          throw error;
        const space = await statfs(dirname(destination));
        if (space.bavail * space.bsize < bytes + 64 * 1024 * 1024)
          throw new MailFailure('business', '目标磁盘剩余空间不足以安全另存附件。');
        await copyFile(temporary, destination, constants.COPYFILE_EXCL);
      }
      return;
    }
    throw new MailFailure('business', '附件下载跳转次数过多。');
  } catch (error) {
    if (error instanceof MailFailure) throw error;
    throw new MailFailure(
      'business',
      signal.aborted ? '附件下载已取消。' : '无法保存附件，目标文件可能已存在。',
    );
  } finally {
    if (created) await unlink(temporary).catch(() => {});
  }
}
