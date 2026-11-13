import { mkdir, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { downloadUrlToFile, type DownloadOutcome } from '../media_url';
import { publishArchiveResourceFile } from './archive_resource';

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
        const fileName = outcome.sha256;
        const handle = await open(temporary, 'r+');
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
        const destination = join(this.root, fileName);
        await publishArchiveResourceFile(temporary, destination, {
          sha256: outcome.sha256,
          size: String(outcome.bytes),
        });
        return { ...outcome, fileName };
      })();
      this.contents.set(outcome.sha256, publish);
      return await publish;
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
