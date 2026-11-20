import { randomUUID } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  linkSync,
  lstatSync,
  readdirSync,
  unlinkSync,
  type Stats,
} from 'node:fs';
import { open, rm, utimes } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';

export type LogFileKind = 'weq' | 'nt_helper' | 'native' | 'other';
const weqFileName =
  /^(\d{4}-\d{2}-\d{2})(?:(?:T\d{2}-\d{2}-\d{2}\.\d{3}Z\.weq)?\.(\d+)\.[a-f0-9]{12}\.\d+)?\.log$/;

export interface LogFileEntry {
  name: string;
  path: string;
  identity: string;
  kind: LogFileKind;
  size: number;
  mtime: number;
  archived: boolean;
}

function logicalPath(path: string): string {
  return path.endsWith('.log.gz') ? path.slice(0, -3) : path;
}

export function isWeqLogName(name: string): boolean {
  return weqFileName.test(logicalPath(name));
}

function logKind(name: string): LogFileKind {
  if (weqFileName.test(name)) return 'weq';
  if (/^nt_helper_\d{4}-\d{2}-\d{2}\.log$/.test(name)) return 'nt_helper';
  if (/^native_loader_\d{4}-\d{2}-\d{2}\.log$/.test(name)) return 'native';
  return 'other';
}

function isLogFile(name: string): boolean {
  return name.endsWith('.log') || name.endsWith('.log.gz');
}

function fileIdentity(source: string, stat: Stats): string {
  return stat.ino ? `${stat.dev}:${stat.ino}` : source;
}

export function scanLogFiles(dir: string): LogFileEntry[] {
  const entries = new Map<string, LogFileEntry>();
  try {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      if (!item.isFile() || !isLogFile(item.name)) continue;
      const source = join(dir, item.name);
      const path = logicalPath(source);
      const archived = path !== source;
      if (archived && entries.has(path)) continue;
      try {
        const stat = lstatSync(source);
        if (stat.isFile()) {
          entries.set(path, {
            name: item.name,
            path,
            identity: fileIdentity(source, stat),
            kind: logKind(basename(path)),
            size: stat.size,
            mtime: stat.mtimeMs,
            archived,
          });
        }
      } catch {
        // 文件可能已轮转或清理，下次扫描再显示。
      }
    }
  } catch {
    // 日志目录尚未建立。
  }
  return [...entries.values()];
}

export function logFileSource(entry: LogFileEntry): string {
  return entry.archived ? `${entry.path}.gz` : entry.path;
}

export function utcLogDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

// 新段由各自的写入进程封存；扫描只接手退出进程的明文和跨日的旧版日志。
export function isHistoricalWeqLog(name: string, today: string): boolean {
  const match = weqFileName.exec(name);
  if (!match) return false;
  if (!match[2]) return match[1]! < today;
  return !processIsAlive(Number(match[2]));
}

export function removeAbandonedArchives(dir: string): void {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const match = /^(.*\.log)\.gz\.(\d+)\.[a-f0-9-]{36}\.tmp$/.exec(entry.name);
      if (entry.isFile() && match && isWeqLogName(match[1]!) && !processIsAlive(Number(match[2]))) {
        void rm(join(dir, entry.name), { force: true }).catch(() => undefined);
      }
    }
  } catch {
    // 下次维护重试。
  }
}

/** gzip 完成后再发布。发布或压缩失败时保留明文，不覆盖同名归档。 */
export async function archiveLogFile(source: string): Promise<void> {
  const archive = `${source}.gz`;
  const temp = `${archive}.${process.pid}.${randomUUID()}.tmp`;
  try {
    if (lstatSync(archive, { throwIfNoEntry: false })) return;
    const original = lstatSync(source);
    if (!original.isFile()) return;
    await pipeline(
      createReadStream(source),
      createGzip({ level: 1 }),
      createWriteStream(temp, { flags: 'wx', mode: original.mode & 0o777, flush: true }),
    );
    await utimes(temp, original.atime, original.mtime);
    const current = lstatSync(source);
    if (
      !current.isFile() ||
      current.ino !== original.ino ||
      current.dev !== original.dev ||
      current.size !== original.size ||
      current.mtimeMs !== original.mtimeMs
    )
      return;
    linkSync(temp, archive);
    unlinkSync(source);
  } catch {
    // 保留原件，后续维护可以重试。
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}

function sourceOf(path: string): { source: string; stat: Stats } {
  const raw = logicalPath(path);
  if (isLogFile(path)) {
    for (const source of [raw, `${raw}.gz`]) {
      try {
        const stat = lstatSync(source);
        if (stat.isFile()) return { source, stat };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  throw new Error('日志文件不存在');
}

async function* inflated(source: string): AsyncGenerator<Buffer> {
  const file = createReadStream(source);
  const gzip = createGunzip();
  file.on('error', (error) => gzip.destroy(error));
  file.pipe(gzip);
  try {
    yield* gzip as AsyncIterable<Buffer>;
  } finally {
    file.destroy();
    gzip.destroy();
  }
}

interface LogFileRange {
  start: number | null;
  end: number | null;
}

const EDGE_BYTES = 64 * 1024;
// 列表可直接检查普通归档分段。旧版整日 gzip 可能大得多，选中时再完整解压。
const ARCHIVE_PREVIEW_BYTES = 8 * 1024 * 1024;

function edgeTime(bytes: Buffer, last = false): number | null {
  const stamps = bytes
    .toString('utf8')
    .matchAll(
      /^(?:\{"ts":"|\[)(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})|\d{13})(?:"|\])/gm,
    );
  let time: number | null = null;
  for (const [, stamp] of stamps) {
    if (!stamp) continue;
    const parsed = /^\d{13}$/.test(stamp) ? Number(stamp) : Date.parse(stamp);
    if (!Number.isFinite(parsed)) continue;
    if (!last) return parsed;
    time = parsed;
  }
  return time;
}

async function inspectArchive(
  source: string,
  limit = Infinity,
): Promise<LogFileRange & { size: number }> {
  let size = 0;
  let head = Buffer.alloc(0);
  const tail: Buffer[] = [];
  let tailBytes = 0;
  for await (const chunk of inflated(source)) {
    size += chunk.length;
    if (head.length < EDGE_BYTES) head = Buffer.concat([head, chunk]).subarray(0, EDGE_BYTES);
    if (size > limit) return { size, start: edgeTime(head), end: null };
    tail.push(chunk);
    tailBytes += chunk.length;
    while (tailBytes - tail[0]!.length >= EDGE_BYTES) tailBytes -= tail.shift()!.length;
  }
  return {
    size,
    start: edgeTime(head),
    end: edgeTime(Buffer.concat(tail).subarray(-EDGE_BYTES), true),
  };
}

function fileVersion(source: string, identity: string, size: number, mtime: number): string {
  return `${source}\0${identity}\0${size}\0${mtime}`;
}

const archiveInfos = new Map<string, Promise<LogFileRange & { size: number }>>();
function archiveInfo(source: string, stat: Stats): Promise<LogFileRange & { size: number }> {
  const key = fileVersion(source, fileIdentity(source, stat), stat.size, stat.mtimeMs);
  const cached = archiveInfos.get(key);
  if (cached) return cached;
  const measured = inspectArchive(source);
  if (archiveInfos.size >= 32) {
    const first = archiveInfos.keys().next();
    if (!first.done) archiveInfos.delete(first.value);
  }
  archiveInfos.set(key, measured);
  void measured.catch(() => {
    if (archiveInfos.get(key) === measured) archiveInfos.delete(key);
  });
  return measured;
}

async function readPlainRange(path: string, size: number): Promise<LogFileRange> {
  const file = await open(path, 'r');
  try {
    const bytes = Buffer.alloc(Math.min(size, EDGE_BYTES));
    const head = await file.read(bytes, 0, bytes.length, 0);
    const start = edgeTime(bytes.subarray(0, head.bytesRead));
    const tail =
      size <= bytes.length ? head : await file.read(bytes, 0, bytes.length, size - bytes.length);
    return { start, end: edgeTime(bytes.subarray(0, tail.bytesRead), true) };
  } finally {
    await file.close();
  }
}

const previewRanges = new Map<string, Promise<LogFileRange>>();
const unknownRange: LogFileRange = { start: null, end: null };

export async function readLogFileRange(entry: LogFileEntry): Promise<LogFileRange> {
  const source = logFileSource(entry);
  const key = fileVersion(source, entry.identity, entry.size, entry.mtime);
  const inspection = archiveInfos.get(key);
  if (inspection) {
    const { start, end } = await inspection.catch(() => unknownRange);
    return { start, end };
  }
  const cached = previewRanges.get(key);
  if (cached) return cached;
  const range = (async () => {
    try {
      if (!entry.archived) return await readPlainRange(source, entry.size);
      const { start, end } = await inspectArchive(
        source,
        entry.size > ARCHIVE_PREVIEW_BYTES ? EDGE_BYTES : ARCHIVE_PREVIEW_BYTES,
      );
      return { start, end };
    } catch {
      // 文件可在扫描后轮转或清理，下次刷新会重新扫描。
      previewRanges.delete(key);
      return unknownRange;
    }
  })();
  if (previewRanges.size >= 256) {
    const first = previewRanges.keys().next();
    if (!first.done) previewRanges.delete(first.value);
  }
  previewRanges.set(key, range);
  return range;
}

export async function readLogFileInfo(path: string): Promise<{ size: number; mtime: number }> {
  const { source, stat } = sourceOf(path);
  const size = source.endsWith('.gz') ? (await archiveInfo(source, stat)).size : stat.size;
  return { size, mtime: stat.mtimeMs };
}

export async function readLogFileChunk(
  path: string,
  offset: number,
  maxBytes: number,
): Promise<{ text: string; nextOffset: number; eof: boolean; size: number }> {
  // 封段恰好发生在选定明文和 open 之间时，重选一次来源。
  for (let attempt = 0; ; attempt++) {
    const { source, stat } = sourceOf(path);
    const archived = source.endsWith('.gz');
    try {
      const size = archived ? (await archiveInfo(source, stat)).size : stat.size;
      const start = offset < 0 ? Math.max(0, size + offset) : Math.min(size, offset);
      const length = Math.min(maxBytes, size - start);
      const buf = Buffer.alloc(length);
      let bytesRead = 0;
      if (length > 0) {
        if (archived) {
          let position = 0;
          for await (const chunk of inflated(source)) {
            if (position + chunk.length > start) {
              bytesRead += chunk.copy(buf, bytesRead, Math.max(0, start - position));
              if (bytesRead >= length) break;
            }
            position += chunk.length;
          }
        } else {
          const handle = await open(source, 'r');
          try {
            ({ bytesRead } = await handle.read(buf, 0, length, start));
          } finally {
            await handle.close();
          }
        }
      }
      return {
        text: buf
          .subarray(0, bytesRead)
          .toString('utf8')
          .replace(/\uFFFD/g, '?'),
        nextOffset: start + bytesRead,
        eof: start + bytesRead >= size,
        size,
      };
    } catch (error) {
      if (attempt || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
