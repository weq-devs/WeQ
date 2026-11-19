import { randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { EOL } from 'node:os';
import { join } from 'node:path';
import {
  archiveLogFile,
  isHistoricalWeqLog,
  removeAbandonedArchives,
  scanLogFiles,
  utcLogDay,
} from './log_files';

export const LOG_SEGMENT_BYTES = 8 * 1024 * 1024;
const BATCH_BYTES = 128 * 1024;
const FLUSH_MS = 200;
const PENDING_BYTES = 4 * 1024 * 1024;

interface Record {
  line: string;
  bytes: number;
  day: string;
}

interface Segment {
  path: string;
  day: string;
  bytes: number;
}

export class LogFileWriter {
  private readonly instanceId = `${process.pid}.${randomBytes(6).toString('hex')}`;
  private readonly pending: Record[] = [];
  private readonly archives = new Set<string>();
  private part = 0;
  private queuedBytes = 0;
  private dropped = 0;
  private active?: Segment;
  private timer?: ReturnType<typeof setTimeout>;
  private flushing?: Promise<void>;
  private archiving?: Promise<void>;
  private exiting = false;
  private writeFailureReported = false;

  constructor(
    readonly dir: string,
    private readonly segmentBytes = LOG_SEGMENT_BYTES,
  ) {}

  get activePath(): string | null {
    return this.active?.path ?? null;
  }

  record(line: string, day: string, important: boolean): void {
    if (this.queuedBytes >= PENDING_BYTES) {
      if (important) {
        // 慢盘积压到上限时优先保留告警，不与在途批次写同一个段。
        this.writeSync(this.segment(day).path, line);
      } else {
        this.dropped++;
      }
      return;
    }
    const bytes = Buffer.byteLength(line);
    this.pending.push({ line, day, bytes });
    this.queuedBytes += bytes;
    if (this.exiting) return;
    if (important || this.queuedBytes >= BATCH_BYTES) void this.flush();
    else this.schedule();
  }

  private schedule(): void {
    if (this.timer || this.flushing) return;
    this.timer = setTimeout(() => void this.flush(), FLUSH_MS);
    this.timer.unref();
  }

  /** 正常退出等候已提交给异步写入器的批次，不等待归档压缩。 */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.flushing = this.drain().finally(() => {
      this.flushing = undefined;
      if (this.pending.length) this.schedule();
    });
    return this.flushing;
  }

  private segment(day: string): Segment {
    const sequence = String(++this.part).padStart(4, '0');
    return { day, path: join(this.dir, `${day}.${this.instanceId}.${sequence}.log`), bytes: 0 };
  }

  private seal(): void {
    if (!this.active) return;
    if (!this.exiting) this.queueArchive(this.active.path);
    this.active = undefined;
  }

  private nextBatch(): { segment: Segment; text: string } | undefined {
    if (this.pending.length === 0 && this.dropped > 0) {
      const ts = new Date().toISOString();
      const line =
        JSON.stringify({
          ts,
          level: 'warn',
          message: '日志写入积压，部分非告警记录未保存',
          context: { scope: 'logger', event: 'log-backpressure', dropped: this.dropped },
        }) + EOL;
      this.dropped = 0;
      const bytes = Buffer.byteLength(line);
      this.pending.push({ line, day: ts.slice(0, 10), bytes });
      this.queuedBytes += bytes;
    }
    const first = this.pending[0];
    if (!first) return;
    if (
      this.active &&
      (this.active.day !== first.day || this.active.bytes + first.bytes > this.segmentBytes)
    )
      this.seal();
    this.active ??= this.segment(first.day);
    const segment = this.active;
    const limit = Math.min(BATCH_BYTES, this.segmentBytes - segment.bytes);
    let bytes = 0;
    let count = 0;
    for (const record of this.pending) {
      if (record.day !== first.day || (count > 0 && bytes + record.bytes > limit)) break;
      bytes += record.bytes;
      count++;
    }
    segment.bytes += bytes;
    this.queuedBytes -= bytes;
    return {
      segment,
      text: this.pending
        .splice(0, count)
        .map((record) => record.line)
        .join(''),
    };
  }

  private async drain(): Promise<void> {
    for (let batch = this.nextBatch(); batch; batch = this.nextBatch()) {
      try {
        await appendFile(batch.segment.path, batch.text, { mode: 0o600 });
      } catch (error) {
        // 失败可能只写入半行，后续批次另起一段。
        this.active = undefined;
        this.reportFailure(error);
      }
      if (this.active && this.active.bytes >= this.segmentBytes) this.seal();
    }
    if (this.active && this.active.day < utcLogDay()) this.seal();
  }

  private writeSync(path: string, text: string): void {
    try {
      appendFileSync(path, text, { mode: 0o600 });
    } catch (error) {
      this.reportFailure(error);
    }
  }

  private reportFailure(error: unknown): void {
    if (this.writeFailureReported) return;
    this.writeFailureReported = true;
    try {
      process.stderr.write(`[weq-logger] ${String(error)}\n`);
    } catch {
      // 日志写入失败不能影响主业务。
    }
  }

  prepareExit(): void {
    this.exiting = true;
    clearTimeout(this.timer);
  }

  flushOnExit(): void {
    // 在途异步写入可能已完成；退出兜底仅写尚未提交的记录，并另起一段。
    if (this.flushing) this.active = undefined;
    for (let batch = this.nextBatch(); batch; batch = this.nextBatch()) {
      this.writeSync(batch.segment.path, batch.text);
    }
  }

  archiveHistorical(): void {
    void this.flush();
    removeAbandonedArchives(this.dir);
    const today = utcLogDay();
    for (const file of scanLogFiles(this.dir)) {
      if (!file.archived && isHistoricalWeqLog(file.name, today)) this.queueArchive(file.path);
    }
  }

  private queueArchive(path: string): void {
    this.archives.add(path);
    this.startArchiving();
  }

  private startArchiving(): void {
    if (this.archiving) return;
    this.archiving = this.archivePending().finally(() => {
      this.archiving = undefined;
      if (this.archives.size > 0) this.startArchiving();
    });
  }

  private async archivePending(): Promise<void> {
    for (const path of this.archives) {
      await archiveLogFile(path);
      this.archives.delete(path);
    }
  }

  /** 等待已排队的归档，供独立日志验证使用。 */
  async waitForArchives(): Promise<void> {
    while (this.archiving) await this.archiving;
  }
}
