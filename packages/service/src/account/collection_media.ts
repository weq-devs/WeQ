import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, unlink, lstat, copyFile } from 'node:fs/promises';
import { join, basename, dirname, extname } from 'node:path';
import { sanitizeSegment } from '../common/path_sanitize';
import type { CollectionCachedContent, CollectionItem, CollectionFileInfo } from '@weq/db';
import { writeFileAtomicSync } from '../common/atomic_write';
import { readJsonFile } from '../common/json_store';

export type CollectionMediaKind = 'image' | 'audio' | 'video' | 'file';
export interface CollectionStoredFile {
  fid: string;
  src?: number;
  uid?: string;
  bid?: number;
  sha1?: string;
  category?: number;
  ntUid?: string;
}
export interface CollectionMediaReference {
  id: string;
  cid: string;
  pointer: string;
  kind: CollectionMediaKind;
  name: string;
  uri: string | null;
  expectedMd5: string | null;
  expectedSize: string | null;
  sourceRole: 'original-candidate' | 'preview' | 'unknown';
  /** Content identity of audio bytes embedded in the account's own detail response. */
  embeddedSha256?: string;
  /** Stable source descriptor, without download URLs or tickets. */
  storedFile?: CollectionStoredFile;
}

export interface CollectionMediaReceipt {
  version: 1;
  reference: CollectionMediaReference;
  state: 'downloaded' | 'failed' | 'unavailable';
  role: 'original' | 'preview' | 'unverified';
  file: string | null;
  bytes: number;
  md5: string | null;
  sha256: string | null;
  md5Matches: boolean | null;
  sizeMatches: boolean | null;
  imageDecoded: boolean | null;
  imageSize: { width: number; height: number } | null;
  error: string | null;
  checkedAt: number;
  /** Verified collector copy reused for this record's original-source descriptor. */
  acquiredFromReferenceId?: string;
}

export interface CollectionMediaOptions {
  signal?: AbortSignal;
  maxBytes?: number;
  timeoutMs?: number;
  /** Test transport or host networking, never supplied by the renderer. */
  fetch?: typeof globalThis.fetch;
  /** Service-only source bytes; never accepted from renderer input. */
  embeddedBytes?: Uint8Array;
  /** Service-only resolver for account-owned file/video descriptors. */
  resolveDownload?: (
    reference: CollectionMediaReference,
    signal: AbortSignal,
  ) => Promise<{ url: string; cookie: string }>;
  inspectImage?: (path: string) => Promise<{ width: number; height: number } | null>;
}

export interface CollectionMediaExportEntry {
  reference: CollectionMediaReference;
  receipt: CollectionMediaReceipt | null;
  /** Relative to the media directory of the export bundle. */
  file: string | null;
}

const DOMAINS = ['qq.com', 'qpic.cn', 'gtimg.cn', 'gtimg.com', 'tencent.com', 'weiyun.com'];

/** No arbitrary redirects, local URLs, credentials or account cookies. */
export function collectionMediaUrl(value: string): string {
  if ([...value].some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127))
    throw new Error('收藏附件地址无效。');
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.port && !['80', '443'].includes(url.port)) ||
    !DOMAINS.some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`))
  )
    throw new Error('收藏附件地址不是受支持的 QQ 资源地址。');
  url.protocol = 'https:';
  url.port = '';
  url.hash = '';
  return url.href;
}

function digest(bytes: Uint8Array | undefined): string | null {
  return bytes?.length === 16 ? Buffer.from(bytes).toString('hex') : null;
}

function size(value: number | bigint | undefined): string | null {
  if (typeof value === 'bigint') return value >= 0n ? value.toString() : null;
  return Number.isSafeInteger(value) && Number(value) >= 0 ? String(value) : null;
}

/** Observed collector audio is a complete SILK stream, not a nested protobuf or URL. */
export function collectionEmbeddedAudio(
  content: CollectionCachedContent | null,
): Uint8Array | null {
  const bytes = content?.audio;
  if (!bytes || bytes.length < 12) return null;
  const data = Buffer.from(bytes);
  const start = data[0] === 2 ? 1 : 0;
  let offset = start + 9;
  if (data.subarray(start, offset).toString('ascii') !== '#!SILK_V3') return null;
  let frames = 0;
  while (offset < data.length) {
    if (offset + 2 > data.length) return null;
    const length = data.readInt16LE(offset);
    offset += 2;
    if (length === -1) return offset === data.length && frames > 0 ? bytes : null;
    if (length <= 0 || offset + length > data.length) return null;
    offset += length;
    frames++;
  }
  return frames > 0 ? bytes : null;
}

/** Preserve every source pointer, including covers and unresolved native files. */
export function collectionMediaReferences(
  cid: string,
  content: CollectionCachedContent | null,
  item?: CollectionItem | null,
): CollectionMediaReference[] {
  const result: CollectionMediaReference[] = [];
  const add = (
    pointer: string,
    kind: CollectionMediaKind,
    metadata: { uri?: string; name?: string; md5?: Uint8Array; size?: number | bigint } & Omit<
      CollectionFileInfo,
      'name' | 'md5' | 'size'
    >,
    sourceRole: CollectionMediaReference['sourceRole'],
  ): void => {
    const value = {
      cid,
      pointer,
      kind,
      name: metadata.name ?? '',
      uri: metadata.uri ?? null,
      expectedMd5: digest(metadata.md5),
      expectedSize: size(metadata.size),
      sourceRole,
      ...((kind === 'file' || kind === 'video') && metadata.fid
        ? {
            storedFile: {
              fid: metadata.fid,
              ...(metadata.src === undefined ? {} : { src: metadata.src }),
              ...(metadata.uid === undefined ? {} : { uid: metadata.uid.toString() }),
              ...(metadata.bid === undefined ? {} : { bid: metadata.bid }),
              ...(metadata.sha1?.length === 20
                ? { sha1: Buffer.from(metadata.sha1).toString('hex') }
                : {}),
              ...(metadata.category === undefined ? {} : { category: metadata.category }),
              ...(metadata.ntUid === undefined ? {} : { ntUid: metadata.ntUid }),
            },
          }
        : {}),
    };
    result.push({ ...value, id: createHash('sha256').update(JSON.stringify(value)).digest('hex') });
  };
  const pics = (
    pointer: string,
    values: NonNullable<CollectionCachedContent['richMediaContent']>['picList'],
    role: CollectionMediaReference['sourceRole'],
  ): void => {
    values?.forEach((pic, index) => {
      add(`${pointer}/${index}`, 'image', pic, role);
    });
  };
  pics('detail/pictures', content?.richMediaContent?.picList, 'original-candidate');
  content?.richMediaContent?.fileList?.forEach((file, index) => {
    add(`detail/files/${index}`, 'file', file, 'original-candidate');
  });
  const embedded = collectionEmbeddedAudio(content);
  if (embedded) {
    const embeddedSha256 = createHash('sha256').update(embedded).digest('hex');
    const value = {
      cid,
      pointer: 'detail/audio/embedded',
      kind: 'audio' as const,
      name: '语音.silk',
      uri: null,
      expectedMd5: null,
      expectedSize: null,
      sourceRole: 'unknown' as const,
      embeddedSha256,
    };
    result.push({ ...value, id: createHash('sha256').update(JSON.stringify(value)).digest('hex') });
  } else if (content?.audio?.length && !content.audioContent?.data) {
    add('detail/audio/unresolved', 'audio', {}, 'unknown');
  }
  const summary = item?.summary;
  pics('summary/gallery', summary?.gallerySummary?.picList, 'original-candidate');
  pics('summary/richMedia', summary?.richMediaSummary?.picList, 'unknown');
  pics('summary/link', summary?.linkSummary?.picList, 'preview');
  if (summary?.videoSummary?.previewPicInfo)
    add('summary/video/cover', 'image', summary.videoSummary.previewPicInfo, 'preview');
  if (summary?.videoSummary?.storeFileInfo)
    add('summary/video/file', 'video', summary.videoSummary.storeFileInfo, 'original-candidate');
  if (summary?.fileSummary?.fileInfo)
    add('summary/file', 'file', summary.fileSummary.fileInfo, 'original-candidate');
  if (summary?.fileSummary?.srcFileInfo)
    add('summary/sourceFile', 'file', summary.fileSummary.srcFileInfo, 'original-candidate');
  // Only explicit source attributes. Other text/links are never download targets.
  for (const [root, html] of [
    ['detail/html', content?.richMediaContent?.rawData],
    ['detail/audio', content?.audioContent?.data],
  ] as const) {
    let index = 0;
    for (const match of (html ?? '').matchAll(
      /<(img|audio|video|source|object)\b[^>]*\s(?:src|data)\s*=\s*["']([^"']+)["'][^>]*>/gi,
    )) {
      const kind = match[1]?.toLowerCase();
      const uri = match[2]!.replace(/&amp;/g, '&');
      add(
        `${root}/${index++}`,
        kind === 'img' ? 'image' : kind === 'audio' ? 'audio' : kind === 'video' ? 'video' : 'file',
        { uri },
        'unknown',
      );
    }
  }
  // Inline HTML can identify the same declared image. Inherit identity only
  // for one unambiguous exact URI, preserving distinct source pointers.
  for (const reference of result) {
    if (reference.sourceRole !== 'unknown' || !reference.uri) continue;
    const candidates = result.filter(
      (other) =>
        other.kind === reference.kind &&
        other.sourceRole === 'original-candidate' &&
        other.uri === reference.uri &&
        other.expectedMd5 &&
        other.expectedSize,
    );
    const identities = new Set(
      candidates.map((other) => `${other.expectedMd5}:${other.expectedSize}`),
    );
    if (identities.size !== 1) continue;
    const original = candidates[0]!;
    reference.expectedMd5 = original.expectedMd5;
    reference.expectedSize = original.expectedSize;
    reference.sourceRole = 'original-candidate';
    const { id: _id, ...identity } = reference;
    reference.id = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  }
  return result;
}

async function hashFile(
  path: string,
  signal?: AbortSignal,
): Promise<{ md5: string; sha256: string; bytes: number }> {
  const md5 = createHash('md5'),
    sha = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path, { signal })) {
    md5.update(chunk);
    sha.update(chunk);
    bytes += chunk.length;
  }
  return { md5: md5.digest('hex'), sha256: sha.digest('hex'), bytes };
}

/**
 * 把刚写完的文件刷到磁盘（`fsync`）。
 *
 * 必须用**可写**句柄：Windows 上对只读句柄（`'r'`）调 `fsync` 直接抛 `EPERM`，
 * 而在 POSIX 上完全合法 —— 用 `'r'` 写的代码在 Linux / macOS 上一路绿灯，
 * 到 Windows 上保存附件必失败。`'r+'` 两端都成立。
 */
async function syncFile(path: string): Promise<void> {
  const handle = await open(path, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const cancel = (): void => {
      signal.removeEventListener('abort', cancel);
      reject(signal.reason);
    };
    signal.addEventListener('abort', cancel, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}

/** Stream a single declared resource; publish its receipt only after the bytes. */
export class CollectionMediaStore {
  private readonly resources = new Map<string, CollectionMediaReceipt>();
  constructor(readonly root: string) {}

  private receiptPath(id: string): string {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('收藏附件 ID 无效。');
    return join(this.root, 'receipts', `${id}.json`);
  }

  async cached(
    reference: CollectionMediaReference,
    signal?: AbortSignal,
  ): Promise<CollectionMediaReceipt | null> {
    const value = readJsonFile(this.receiptPath(reference.id)) as CollectionMediaReceipt | null;
    if (
      value?.version !== 1 ||
      value.state !== 'downloaded' ||
      value.reference?.id !== reference.id ||
      JSON.stringify(value.reference) !== JSON.stringify(reference) ||
      !value.file ||
      !/^files\/[a-f0-9]{64}\.bin$/.test(value.file)
    )
      return null;
    try {
      const path = join(this.root, value.file);
      if (!(await lstat(path)).isFile()) return null;
      const actual = await hashFile(path, signal);
      return actual.sha256 === value.sha256 &&
        actual.md5 === value.md5 &&
        actual.bytes === value.bytes
        ? value
        : null;
    } catch {
      return null;
    }
  }

  async savedFile(
    id: string,
  ): Promise<{ path: string; name: string; receipt: CollectionMediaReceipt }> {
    const value = readJsonFile(this.receiptPath(id)) as CollectionMediaReceipt | null;
    if (!value?.reference || value.reference.id !== id) throw new Error('未找到这个附件。');
    const receipt = await this.cached(value.reference);
    if (!receipt?.file) throw new Error('附件缓存已丢失或校验不符。');
    const path = join(this.root, receipt.file);
    let name = sanitizeSegment(basename(value.reference.name || ''), '收藏附件');
    if (!extname(name)) {
      const handle = await open(path, 'r');
      const header = Buffer.alloc(16);
      try {
        await handle.read(header, 0, header.length, 0);
      } finally {
        await handle.close();
      }
      const extension = header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        ? '.png'
        : header[0] === 255 && header[1] === 216
          ? '.jpg'
          : header.subarray(0, 3).toString() === 'GIF'
            ? '.gif'
            : header.subarray(8, 12).toString() === 'WEBP'
              ? '.webp'
              : '.bin';
      name += extension;
    }
    return { path, name, receipt };
  }

  async saveAs(id: string, destination: string): Promise<void> {
    const { path, receipt } = await this.savedFile(id);
    const temp = join(dirname(destination), `.${randomUUID()}.partial`);
    try {
      await copyFile(path, temp);
      const actual = await hashFile(temp);
      if (actual.sha256 !== receipt.sha256 || actual.bytes !== receipt.bytes)
        throw new Error('附件保存校验失败。');
      await syncFile(temp);
      await rename(temp, destination);
    } finally {
      await unlink(temp).catch(() => {});
    }
  }

  async exportCached(
    reference: CollectionMediaReference,
    directory: string,
    signal?: AbortSignal,
  ): Promise<CollectionMediaExportEntry> {
    signal?.throwIfAborted();
    const receipt = await this.cached(reference, signal);
    signal?.throwIfAborted();
    if (!receipt?.file || !receipt.sha256) {
      const previous = readJsonFile(
        this.receiptPath(reference.id),
      ) as CollectionMediaReceipt | null;
      if (
        previous?.version === 1 &&
        JSON.stringify(previous.reference) === JSON.stringify(reference) &&
        ['downloaded', 'failed', 'unavailable'].includes(previous.state)
      ) {
        return {
          reference,
          receipt:
            previous.state === 'downloaded'
              ? {
                  ...previous,
                  state: 'failed',
                  role: 'unverified',
                  file: null,
                  error: '附件缓存已丢失或校验不符。',
                }
              : previous,
          file: null,
        };
      }
      return { reference, receipt: null, file: null };
    }
    const suffix =
      (reference.kind === 'file' || reference.kind === 'video') &&
      /^\.[a-z0-9]{1,15}$/i.test(extname(reference.name))
        ? extname(reference.name)
        : '.bin';
    const file = `${receipt.sha256}${suffix}`;
    await mkdir(directory, { recursive: true });
    await copyFile(join(this.root, receipt.file), join(directory, file));
    signal?.throwIfAborted();
    const actual = await hashFile(join(directory, file), signal);
    if (actual.sha256 !== receipt.sha256 || actual.bytes !== receipt.bytes)
      throw new Error('收藏附件导出校验失败。');
    return { reference, receipt, file };
  }

  async download(
    reference: CollectionMediaReference,
    options: CollectionMediaOptions = {},
  ): Promise<CollectionMediaReceipt> {
    options.signal?.throwIfAborted();
    const resourceKey = JSON.stringify([
      reference.kind,
      reference.uri,
      reference.expectedMd5,
      reference.expectedSize,
      reference.sourceRole,
      reference.embeddedSha256 ?? null,
      reference.storedFile ?? null,
    ]);
    const cached = await this.cached(reference, options.signal);
    options.signal?.throwIfAborted();
    if (cached) {
      this.resources.set(resourceKey, cached);
      return cached;
    }
    // A file's original-source descriptor is provenance, not another collector
    // upload. Reuse only this CID's verified stored copy with matching byte identity.
    if (
      reference.kind === 'file' &&
      reference.pointer === 'summary/sourceFile' &&
      reference.expectedMd5 &&
      reference.expectedSize !== null
    ) {
      for (const candidate of this.resources.values()) {
        const peer = candidate.reference;
        if (
          candidate.role !== 'original' ||
          peer.cid !== reference.cid ||
          peer.pointer !== 'summary/file' ||
          peer.kind !== 'file' ||
          peer.expectedMd5 !== reference.expectedMd5 ||
          peer.expectedSize !== reference.expectedSize ||
          (reference.storedFile?.sha1 && reference.storedFile.sha1 !== peer.storedFile?.sha1)
        )
          continue;
        if (!(await this.cached(peer, options.signal))) continue;
        options.signal?.throwIfAborted();
        const shared = { ...candidate, reference, acquiredFromReferenceId: peer.id };
        writeFileAtomicSync(this.receiptPath(reference.id), JSON.stringify(shared));
        this.resources.set(resourceKey, shared);
        return shared;
      }
    }
    const previous = this.resources.get(resourceKey);
    if (previous && (await this.cached(previous.reference, options.signal))) {
      options.signal?.throwIfAborted();
      const shared = { ...previous, reference };
      writeFileAtomicSync(this.receiptPath(reference.id), JSON.stringify(shared));
      return shared;
    }
    const receipt: CollectionMediaReceipt = {
      version: 1,
      reference,
      state: 'unavailable',
      role: 'unverified',
      file: null,
      bytes: 0,
      md5: null,
      sha256: null,
      md5Matches: null,
      sizeMatches: null,
      imageDecoded: null,
      imageSize: null,
      error: null,
      checkedAt: Date.now(),
    };
    const save = (): CollectionMediaReceipt => {
      writeFileAtomicSync(this.receiptPath(reference.id), JSON.stringify(receipt));
      if (receipt.state === 'downloaded') this.resources.set(resourceKey, receipt);
      return receipt;
    };
    if (
      !reference.uri &&
      !reference.embeddedSha256 &&
      !(reference.storedFile && options.resolveDownload)
    ) {
      receipt.error = '此附件尚无可用的下载地址。';
      return save();
    }
    const maxBytes = options.maxBytes ?? 256 * 1024 * 1024;
    const timeoutMs = options.timeoutMs ?? 45_000;
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes <= 0 ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0
    )
      throw new Error('收藏附件下载限制无效。');
    const controller = new AbortController();
    const cancel = (): void => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('收藏附件下载超时。')), timeoutMs);
    const temp = join(this.root, 'files', `.${randomUUID()}.partial`);
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      let response: Response;
      if (reference.embeddedSha256) {
        const bytes = options.embeddedBytes;
        if (
          !bytes ||
          bytes.length > maxBytes ||
          createHash('sha256').update(bytes).digest('hex') !== reference.embeddedSha256 ||
          !collectionEmbeddedAudio({ recordTime: 0, audio: bytes })
        )
          throw new Error('收藏语音数据不完整或校验不符。');
        // Reuse streaming/hash/atomic-publish logic without making a network request.
        response = new Response(Buffer.from(bytes), {
          headers: { 'content-length': String(bytes.length) },
        });
      } else {
        if (reference.expectedSize && BigInt(reference.expectedSize) > BigInt(maxBytes))
          throw new Error('收藏附件超过下载上限。');
        const resource = reference.uri
          ? { url: reference.uri, cookie: '' }
          : await abortable(
              options.resolveDownload!(reference, controller.signal),
              controller.signal,
            );
        controller.signal.throwIfAborted();
        const url = collectionMediaUrl(resource.url);
        if (
          resource.cookie &&
          (!['qq.com', 'weiyun.com'].some(
            (domain) =>
              new URL(url).hostname === domain || new URL(url).hostname.endsWith(`.${domain}`),
          ) ||
            /[\r\n]/.test(resource.cookie))
        )
          throw new Error('收藏附件下载凭据无效。');
        const fetched = (options.fetch ?? globalThis.fetch)(url, {
          signal: controller.signal,
          redirect: 'manual',
          headers: {
            'Accept-Encoding': 'identity',
            ...(resource.cookie ? { Cookie: resource.cookie } : {}),
          },
        });
        void fetched.then(
          (late) => {
            if (controller.signal.aborted) void late.body?.cancel().catch(() => {});
          },
          () => {},
        );
        response = await abortable(fetched, controller.signal);
      }
      if (response.status !== 200) {
        void response.body?.cancel().catch(() => {});
        throw new Error(
          response.status === 429
            ? '附件下载过于频繁，请稍后重试。'
            : `附件下载失败（HTTP ${response.status}）。`,
        );
      }
      const lengthText = response.headers.get('content-length');
      const length =
        lengthText === null ? null : /^\d+$/.test(lengthText) ? Number(lengthText) : NaN;
      if (length !== null && (!Number.isSafeInteger(length) || length > maxBytes)) {
        void response.body?.cancel().catch(() => {});
        throw new Error('收藏附件超过下载上限。');
      }
      if (!response.body) throw new Error('收藏附件响应为空。');
      await mkdir(join(this.root, 'files'), { recursive: true });
      handle = await open(temp, 'wx', 0o600);
      const reader = response.body.getReader();
      const md5 = createHash('md5'),
        sha = createHash('sha256');
      try {
        for (;;) {
          controller.signal.throwIfAborted();
          const { done, value } = await abortable(reader.read(), controller.signal);
          if (done) break;
          receipt.bytes += value.length;
          if (receipt.bytes > maxBytes) throw new Error('收藏附件超过下载上限。');
          md5.update(value);
          sha.update(value);
          await handle.writeFile(value);
        }
      } finally {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      if (
        (receipt.bytes === 0 && !(reference.kind === 'file' && reference.expectedSize === '0')) ||
        (length !== null && receipt.bytes !== length)
      )
        throw new Error('收藏附件响应不完整。');
      receipt.md5 = md5.digest('hex');
      receipt.sha256 = sha.digest('hex');
      receipt.md5Matches =
        reference.expectedMd5 === null ? null : receipt.md5 === reference.expectedMd5;
      receipt.sizeMatches =
        reference.expectedSize === null
          ? null
          : BigInt(reference.expectedSize) === BigInt(receipt.bytes);
      if (reference.kind === 'image' && options.inspectImage) {
        receipt.imageSize = await abortable(options.inspectImage(temp), controller.signal);
        receipt.imageDecoded = Boolean(
          receipt.imageSize && receipt.imageSize.width > 0 && receipt.imageSize.height > 0,
        );
      }
      receipt.role =
        reference.sourceRole === 'preview'
          ? 'preview'
          : reference.sourceRole === 'original-candidate' &&
              receipt.md5Matches === true &&
              receipt.sizeMatches === true &&
              (reference.kind !== 'image' || receipt.imageDecoded === true)
            ? 'original'
            : 'unverified';
      controller.signal.throwIfAborted();
      await handle.sync();
      await handle.close();
      handle = null;
      const file = `files/${receipt.sha256}.bin`;
      await rename(temp, join(this.root, file));
      try {
        const dir = await open(join(this.root, 'files'), 'r');
        try {
          await dir.sync();
        } finally {
          await dir.close();
        }
      } catch {
        /* Some hosts do not support directory fsync. */
      }
      receipt.file = file;
      receipt.state = 'downloaded';
      receipt.checkedAt = Date.now();
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason;
      receipt.state = 'failed';
      receipt.error = controller.signal.aborted
        ? '收藏附件下载超时。'
        : error instanceof Error
          ? error.message
          : '收藏附件下载失败。';
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', cancel);
      await handle?.close();
      await unlink(temp).catch(() => {});
    }
    return save();
  }
}
