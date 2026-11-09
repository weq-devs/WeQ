import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { writeFileAtomic } from '../common/atomic_write';
import type { CalendarCheckpoint } from './conversation_calendar';

export const CALENDAR_CHECKPOINT_MAX_BYTES = 16 * 1024 * 1024;
const pending = new Map<string, Promise<void>>();
export async function waitForCalendarWrites(): Promise<void> {
  while (pending.size) await Promise.all([...pending.values()]);
}

/** 仅保存会话身份、计数、锚点和成功游标；不保存消息正文或附件。 */
export class CalendarCheckpointStore {
  readonly path: string;
  private readonly identity: string;
  private timer?: ReturnType<typeof setTimeout>;
  private dirty = false;
  private writing?: Promise<void>;
  private blocked = false;
  constructor(
    root: string,
    scope: string,
    private readonly checkpoint: () => CalendarCheckpoint,
    private readonly onError: (message: string | undefined) => void = () => {},
  ) {
    this.identity = createHash('sha256').update(scope).digest('hex');
    this.path = join(root, 'conversation-calendar', `${this.identity}.json`);
  }
  async load(): Promise<unknown | undefined> {
    await pending.get(this.path)?.catch(() => {});
    try {
      const info = await stat(this.path);
      if (!info.isFile() || info.size > CALENDAR_CHECKPOINT_MAX_BYTES)
        throw new Error('统计结果文件超过大小上限');
      const raw: unknown = JSON.parse(await readFile(this.path, 'utf8'));
      if (
        !raw ||
        typeof raw !== 'object' ||
        !('identity' in raw) ||
        raw.identity !== this.identity ||
        !('state' in raw)
      )
        throw new Error('统计结果文件与当前来源不匹配');
      return raw.state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      this.block('统计结果读取失败，原文件已保留');
      return undefined;
    }
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
        const data = JSON.stringify({ identity: this.identity, state: this.checkpoint() });
        if (Buffer.byteLength(data) > CALENDAR_CHECKPOINT_MAX_BYTES)
          throw new Error('统计结果超过保存上限');
        const previous = pending.get(this.path);
        const write = (async () => {
          await previous?.catch(() => {});
          await writeFileAtomic(this.path, data);
        })();
        pending.set(this.path, write);
        try {
          await write;
          this.onError(undefined);
        } finally {
          if (pending.get(this.path) === write) pending.delete(this.path);
        }
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
