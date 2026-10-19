import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { extname, isAbsolute, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { writeFileAtomicSync } from '../common/atomic_write';
import {
  normalizeMergeForwardDraft,
  type MergeForwardDraft,
  type MergeForwardDraftInput,
} from './merge_forward_drafts';

export type MergeForwardArchiveKind = 'material' | 'history';
export interface MergeForwardArchiveEntry extends MergeForwardDraft {
  kind: MergeForwardArchiveKind;
  sourceDraftId: string;
}

/** 素材和历史采用只追加快照；媒体独立于 QQ 缓存，按内容去重，不随删除条目回收。 */
export class MergeForwardArchiveStore {
  constructor(private readonly root: string) {}

  private path(kind: MergeForwardArchiveKind, id: string): string {
    if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error('归档身份不合法');
    return join(this.root, kind, `${id}.json`);
  }

  get(kind: MergeForwardArchiveKind, id: string): MergeForwardArchiveEntry | undefined {
    const path = this.path(kind, id);
    if (!existsSync(path)) return undefined;
    try {
      const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
      const draft = normalizeMergeForwardDraft(raw, id);
      if (
        !draft ||
        !raw ||
        typeof raw !== 'object' ||
        !('sourceDraftId' in raw) ||
        typeof raw.sourceDraftId !== 'string'
      )
        throw new Error('invalid archive');
      return { ...draft, id, kind, sourceDraftId: raw.sourceDraftId };
    } catch {
      throw new Error(`归档记录损坏：${id}`);
    }
  }

  list(kind: MergeForwardArchiveKind): MergeForwardArchiveEntry[] {
    const dir = join(this.root, kind);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => /^[a-zA-Z0-9-]+\.json$/.test(name))
      .map((name) => this.get(kind, name.slice(0, -5)))
      .filter((entry): entry is MergeForwardArchiveEntry => Boolean(entry))
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
  }

  async append(
    kind: MergeForwardArchiveKind,
    input: MergeForwardDraftInput,
    authorize: (path: string) => Promise<boolean> = async () => true,
  ): Promise<MergeForwardArchiveEntry> {
    const id = `${kind}-${randomUUID()}`;
    const now = Math.floor(Date.now() / 1000);
    const draft = normalizeMergeForwardDraft(structuredClone(input), id);
    if (!draft) throw new Error('无效的合成内容');
    const copied = new Map<string, string>();
    const copy = async (source: string): Promise<string> => {
      const prior = copied.get(source);
      if (prior) return prior;
      if (!isAbsolute(source) || !(await authorize(source)))
        throw new Error(`媒体访问未授权：${source}`);
      const info = await stat(source);
      if (!info.isFile()) throw new Error('媒体不是普通文件');
      const dir = join(this.root, 'media');
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const temporary = join(dir, `.${randomUUID()}.tmp`);
      try {
        const hash = createHash('sha256');
        await pipeline(
          createReadStream(source),
          new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              hash.update(chunk);
              callback(null, chunk);
            },
          }),
          createWriteStream(temporary, { flags: 'wx', mode: 0o600, flush: true }),
        );
        const extension = extname(source).toLowerCase();
        const destination = join(
          dir,
          `${hash.digest('hex')}${/^\.[a-z0-9]{1,12}$/.test(extension) ? extension : ''}`,
        );
        await rename(temporary, destination);
        copied.set(source, destination);
        return destination;
      } finally {
        await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
    };
    const walk = async (segments: unknown[], depth: number): Promise<void> => {
      if (depth > 16) throw new Error('合成内容嵌套过深');
      for (const raw of segments) {
        if (!raw || typeof raw !== 'object') continue;
        const segment = raw as Record<string, unknown>;
        if (
          segment.t === 'opaque' &&
          segment.element &&
          typeof segment.element === 'object' &&
          'type' in segment.element &&
          ['pic', 'ptt', 'video', 'file'].includes(String(segment.element.type))
        )
          throw new Error('媒体尚未下载，不能归档为永久素材或历史');
        if (segment.t === 'node' && Array.isArray(segment.segs))
          await walk(segment.segs, depth + 1);
        if (!['image', 'record', 'video', 'file'].includes(String(segment.t))) continue;
        if (typeof segment.path !== 'string' || !segment.path)
          throw new Error('媒体尚未下载，不能归档为永久素材或历史');
        segment.path = await copy(segment.path);
        if (typeof segment.thumbPath === 'string' && segment.thumbPath)
          segment.thumbPath = await copy(segment.thumbPath);
      }
    };
    for (const node of draft.nodes) await walk(node.segs, 0);
    const entry: MergeForwardArchiveEntry = {
      ...draft,
      id,
      kind,
      sourceDraftId: input.id,
      createdAt: now,
      updatedAt: now,
    };
    writeFileAtomicSync(this.path(kind, id), JSON.stringify(entry));
    return structuredClone(entry);
  }

  remove(kind: MergeForwardArchiveKind, id: string): boolean {
    try {
      unlinkSync(this.path(kind, id));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
}
