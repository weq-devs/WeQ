import { mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { downloadUrlToFile, type DownloadOutcome } from '../media_url';
import { sniffImageExt } from './emoji_export';

export type QzoneStoredMedia =
  | (Extract<DownloadOutcome, { ok: true }> & { fileName: string })
  | Extract<DownloadOutcome, { ok: false }>;

/** 同一空间包共用媒体池：相同 URL 合并请求，不同 URL 按实际内容校验和复用文件。 */
export class QzoneMediaStore {
  private requests = new Map<string, Promise<QzoneStoredMedia>>();
  private contents = new Map<string, Promise<QzoneStoredMedia>>();
  constructor(private readonly root: string) {}

  save(url: string, kind: 'image' | 'video', signal?: AbortSignal): Promise<QzoneStoredMedia> {
    const key = `${kind}:${url}`;
    const previous = this.requests.get(key);
    if (previous) return previous;
    const work = this.download(url, kind, signal).then((result) => {
      if (!result.ok) this.requests.delete(key);
      return result;
    });
    this.requests.set(key, work);
    return work;
  }

  private async download(
    url: string,
    kind: 'image' | 'video',
    signal?: AbortSignal,
  ): Promise<QzoneStoredMedia> {
    signal?.throwIfAborted();
    await mkdir(this.root, { recursive: true });
    const temporary = join(this.root, `.${randomUUID()}.download`);
    try {
      const outcome = await downloadUrlToFile(url, temporary, { signal, expectedKind: kind });
      signal?.throwIfAborted();
      if (!outcome.ok) return outcome;
      const existing = this.contents.get(outcome.sha256);
      if (existing) return await existing;
      const publish = (async (): Promise<QzoneStoredMedia> => {
        const handle = await open(temporary, 'r');
        let extension: string;
        try {
          const head = Buffer.alloc(32);
          const { bytesRead } = await handle.read(head, 0, head.length, 0);
          extension =
            kind === 'image'
              ? (sniffImageExt(head.subarray(0, bytesRead)) ?? '.jpg')
              : head[0] === 0x1a
                ? '.webm'
                : '.mp4';
        } finally {
          await handle.close();
        }
        const fileName = `${outcome.sha256}${extension}`;
        await rename(temporary, join(this.root, fileName));
        return { ...outcome, fileName };
      })();
      this.contents.set(outcome.sha256, publish);
      return await publish;
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
