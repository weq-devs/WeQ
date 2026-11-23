import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { writeFileAtomic } from '../common/atomic_write';
import {
  calendarToday,
  type CalendarCheckpoint,
  type CalendarSavedWork,
} from './conversation_calendar';

export const CALENDAR_CHECKPOINT_MAX_BYTES = 16 * 1024 * 1024;
const pending = new Map<string, Promise<void>>();
const RELATED_CHECKPOINT_LIMIT = 4;
const RELATED_CHECKPOINT_READ_BYTES = 4 * 1024 * 1024;
const CHECKPOINT_WRITE_CHUNK_BYTES = 64 * 1024;
const CHECKPOINT_WRITE_ROW_BATCH = 256;
const identityPattern = /^[a-f0-9]{64}$/;
async function serializeWrite(path: string, write: () => Promise<void>): Promise<void> {
  const previous = pending.get(path);
  const next = (async () => {
    await previous?.catch(() => {});
    await write();
  })();
  pending.set(path, next);
  try {
    await next;
  } finally {
    if (pending.get(path) === next) pending.delete(path);
  }
}
async function readJson(
  path: string,
  maxBytes: number,
): Promise<{ value: unknown; bytes: number }> {
  await pending.get(path)?.catch(() => {});
  const info = await stat(path);
  if (!info.isFile() || info.size > maxBytes) throw new Error('统计结果文件超过大小上限');
  const data = await readFile(path);
  if (data.length > maxBytes) throw new Error('统计结果文件超过大小上限');
  return { value: JSON.parse(data.toString('utf8')), bytes: data.length };
}
function readEnvelope(raw: unknown, identity: string, family?: string): unknown {
  if (
    !raw ||
    typeof raw !== 'object' ||
    !('identity' in raw) ||
    raw.identity !== identity ||
    !('state' in raw) ||
    (family && (!('family' in raw) || raw.family !== family))
  )
    throw new Error('统计结果文件与当前来源不匹配');
  return raw.state;
}
export async function waitForCalendarWrites(): Promise<void> {
  while (pending.size) await Promise.all([...pending.values()]);
}

function* arrayParts(items: readonly unknown[]): Generator<string> {
  yield '[';
  for (let offset = 0; offset < items.length; offset += CHECKPOINT_WRITE_ROW_BATCH) {
    if (offset > 0) yield ',';
    yield JSON.stringify(items.slice(offset, offset + CHECKPOINT_WRITE_ROW_BATCH)).slice(1, -1);
  }
  yield ']';
}

function* savedWorkParts(value: CalendarSavedWork): Generator<string> {
  const { rows, refresh, ...metadata } = value;
  yield `${JSON.stringify(metadata).slice(0, -1)},"rows":`;
  yield* arrayParts(rows);
  if (refresh) {
    yield ',"refresh":';
    yield* savedWorkParts(refresh);
  }
  yield '}';
}

function* checkpointParts(identity: string, family: string | undefined, state: CalendarCheckpoint) {
  const { work, coverage, ...metadata } = state;
  yield JSON.stringify({ identity, family, state: metadata }).slice(0, -2);
  if (coverage) {
    yield ',"coverage":';
    yield* arrayParts(coverage);
  }
  yield ',"work":[';
  for (const [index, task] of work.entries()) {
    if (index > 0) yield ',';
    yield* savedWorkParts(task);
  }
  yield ']}}';
}

function* checkpointChunks(
  identity: string,
  family: string | undefined,
  state: CalendarCheckpoint,
) {
  let chunk = '';
  let chunkBytes = 0;
  let total = 0;
  // 分段交给异步文件写入，给前台查询让出事件循环。超限直接放弃临时文件。
  for (const part of checkpointParts(identity, family, state)) {
    const bytes = Buffer.byteLength(part);
    total += bytes;
    if (total > CALENDAR_CHECKPOINT_MAX_BYTES) throw new Error('统计结果超过保存上限');
    chunk += part;
    chunkBytes += bytes;
    if (chunkBytes >= CHECKPOINT_WRITE_CHUNK_BYTES) {
      yield chunk;
      chunk = '';
      chunkBytes = 0;
    }
  }
  if (chunk) yield chunk;
}

/** 仅保存会话身份、计数、锚点和成功游标；不保存消息正文或附件。 */
export class CalendarCheckpointStore {
  readonly path: string;
  private readonly identity: string;
  private readonly directory: string;
  private readonly family?: string;
  private readonly indexPath?: string;
  private readonly openedAt = Date.now();
  private indexed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private dirty = false;
  private writing?: Promise<void>;
  private blocked = false;
  constructor(
    root: string,
    scope: string,
    private readonly checkpoint: () => CalendarCheckpoint,
    private readonly onError: (message: string | undefined) => void = () => {},
    familyScope?: string,
  ) {
    this.identity = createHash('sha256').update(scope).digest('hex');
    this.directory = join(root, 'conversation-calendar');
    this.path = join(this.directory, `${this.identity}.json`);
    if (familyScope) {
      this.family = createHash('sha256').update(familyScope).digest('hex');
      this.indexPath = join(this.directory, `related-${this.family}.json`);
    }
  }
  async load(): Promise<unknown | undefined> {
    try {
      const { value } = await readJson(this.path, CALENDAR_CHECKPOINT_MAX_BYTES);
      return readEnvelope(value, this.identity);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      this.block('统计结果读取失败，原文件已保留');
      return undefined;
    }
  }
  private async relatedIds(path: string): Promise<string[]> {
    // 索引只记录近期检查点身份，可以从新统计结果重新生成。
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size > 1024) return [];
      const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
      return Array.isArray(raw)
        ? raw
            .filter((id) => typeof id === 'string' && identityPattern.test(id))
            .slice(0, RELATED_CHECKPOINT_LIMIT)
        : [];
    } catch {
      return [];
    }
  }
  async *loadRelated(): AsyncGenerator<unknown> {
    if (!this.indexPath) return;
    await pending.get(this.indexPath)?.catch(() => {});
    let remaining = RELATED_CHECKPOINT_READ_BYTES;
    for (const id of new Set(await this.relatedIds(this.indexPath))) {
      if (id === this.identity) continue;
      try {
        const { value, bytes } = await readJson(join(this.directory, `${id}.json`), remaining);
        remaining -= bytes;
        yield readEnvelope(value, id, this.family);
      } catch {
        // 单个旧检查点失效时仍可尝试其他范围。
      }
    }
  }
  private async remember(state: CalendarCheckpoint): Promise<void> {
    const path = this.indexPath;
    if (
      this.indexed ||
      !path ||
      !state.coverage?.length ||
      !state.work.some(
        (work) =>
          work.counted &&
          !work.error &&
          !work.refresh &&
          work.readStartedAt !== undefined &&
          work.readStartedAt >= this.openedAt &&
          work.day < calendarToday(work.readStartedAt),
      )
    )
      return;
    await serializeWrite(path, async () => {
      const current = await this.relatedIds(path);
      const ids = [this.identity, ...current.filter((id) => id !== this.identity)];
      await writeFileAtomic(path, JSON.stringify(ids.slice(0, RELATED_CHECKPOINT_LIMIT)));
    });
    this.indexed = true;
  }
  block(message: string): void {
    this.blocked = true;
    this.onError(message);
  }
  schedule(): void {
    if (this.blocked) return;
    this.dirty = true;
    if (!this.timer)
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush().catch(() => {});
      }, 500);
  }
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.blocked) return;
    this.dirty = true;
    if (this.writing) return this.writing;
    this.writing = (async () => {
      while (this.dirty) {
        this.dirty = false;
        const state = this.checkpoint();
        await serializeWrite(this.path, () =>
          writeFileAtomic(this.path, checkpointChunks(this.identity, this.family, state)),
        );
        await this.remember(state).catch(() => {});
        this.onError(undefined);
      }
    })()
      .catch((error: unknown) => {
        this.dirty = true;
        this.onError('统计结果保存失败，请检查缓存目录可用空间后重试');
        throw error;
      })
      .finally(() => {
        this.writing = undefined;
      });
    return this.writing;
  }
}
