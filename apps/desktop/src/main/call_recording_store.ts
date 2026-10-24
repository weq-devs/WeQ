/**
 * 通话录音的落盘与索引。
 *
 * 目录结构（默认根 `<appDataRoot>/recordings/<本机 QQ 号>`，可在设置里改）：
 *
 *   <root>/2026-10-25_21-03-11_10001.wav
 *   <root>/index.json
 *
 * 索引是一个数组，每条记录描述一次录音。**索引不是真相来源**：文件被用户手动
 * 删掉时，`resolve()` 会返回 null（界面回落到「录音已丢失」），而不是报错。
 *
 * 气泡回放是 **best-effort**：通话结束后 QQ 客户端才会写那条 call 消息，而且双方
 * 都用 WeQ 时可能压根没有这条消息。所以匹配先按 `msgId` 精确命中，再退到「同一
 * 会话 ±90 秒内、还没被别的消息认领的最近一条」。匹配不到不影响录音本身 ——
 * 通话窗口里照样能播、能打开目录。
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { CallRecordingMode } from '@weq/service';

/** 索引里的一条录音。 */
export interface CallRecordingEntry {
  /** 稳定 id（文件名去掉扩展名）。 */
  id: string;
  fileName: string;
  kind: 'c2c' | 'group';
  /** 私聊 = 对方 uid / QQ 号；群聊 = 群号。 */
  conv: string;
  peerUin: string;
  peerName: string;
  /** 开始 / 结束时刻（毫秒）。 */
  startedAt: number;
  endedAt: number;
  durationSec: number;
  mode: CallRecordingMode;
  systemAudio: boolean;
  /** 认领这条录音的 call 消息 id（匹配到之后回写）。 */
  msgId?: string;
}

/** 气泡上要展示的最小信息。 */
export interface RecordingLookup {
  id: string;
  durationSec: number;
  startedAt: number;
  mode: CallRecordingMode;
  systemAudio: boolean;
}

/** 时间窗兜底的宽度：call 消息的写入时刻与挂断时刻通常差几秒，留足余量。 */
const MATCH_WINDOW_MS = 90_000;

export class CallRecordingStore {
  /** 录音根目录（绝对路径）。 */
  readonly root: string;
  private cache: CallRecordingEntry[] | null = null;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /** 确保根目录存在（首次录音 / 读取索引前调用）。 */
  async ensure(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  /** 全部录音，新的在前。索引损坏时当作空表，不抛。 */
  async list(): Promise<CallRecordingEntry[]> {
    if (this.cache) return [...this.cache];
    try {
      const raw = await readFile(this.indexPath(), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      this.cache = Array.isArray(parsed)
        ? parsed.filter((item): item is CallRecordingEntry => isEntry(item))
        : [];
    } catch {
      this.cache = [];
    }
    return [...this.cache];
  }

  /**
   * 新建一条录音记录并落索引。
   *
   * 文件名用「开始时刻 + 对端」：同一秒内不可能有两通电话（服务端也只给一路），
   * 所以不会撞名；带上对端是为了用户直接翻目录时能认出来。
   */
  async create(entry: Omit<CallRecordingEntry, 'id' | 'fileName'>): Promise<CallRecordingEntry> {
    await this.ensure();
    const stamp = formatStamp(entry.startedAt);
    const suffix = safeSegment(entry.peerUin || entry.conv || 'call');
    const base = `${stamp}_${suffix}`;
    const fileName = await this.uniqueName(base);
    const record: CallRecordingEntry = { ...entry, id: fileName.replace(/\.wav$/, ''), fileName };
    const items = await this.list();
    items.unshift(record);
    this.cache = items;
    await this.writeIndex();
    return record;
  }

  /** 更新一条已存在的记录（录音收尾时补时长与结束时刻）。找不到就忽略。 */
  async update(entry: CallRecordingEntry): Promise<void> {
    const items = await this.list();
    const index = items.findIndex((item) => item.id === entry.id);
    if (index < 0) return;
    items[index] = { ...entry };
    this.cache = items;
    await this.writeIndex();
  }

  /** 录音的绝对路径；文件不在了返回 null。 */
  async resolve(id: string): Promise<string | null> {
    const entry = (await this.list()).find((item) => item.id === id);
    if (!entry) return null;
    const path = resolve(this.root, entry.fileName);
    // 索引是我们自己写的，但仍然兜一层：`fileName` 若被外部改成 `../../etc/passwd`，
    // 这条协议就变成了任意文件读取。
    if (!this.contains(path)) return null;
    try {
      const info = await stat(path);
      return info.isFile() ? path : null;
    } catch {
      return null;
    }
  }

  /**
   * 找到某条 call 消息对应的录音。
   *
   * 1. `msgId` 已经认领过 → 直接命中（同一条消息永远指向同一条录音）；
   * 2. 否则在同会话、`sendTimeMs ± 90 s` 内找最近的一条，并把它认领给这条消息。
   *
   * 认领只写一次：同一条录音不会被两条 call 消息抢走（群聊一条电话可能落两条
   * 消息，但录音只该挂在「已结束」那条上 —— 时间窗会挑最近的那条）。
   */
  async match(query: {
    kind: 'c2c' | 'group';
    conv: string;
    sendTimeMs: number;
    msgId?: string;
  }): Promise<RecordingLookup | null> {
    const items = await this.list();
    const toLookup = (entry: CallRecordingEntry): RecordingLookup => ({
      id: entry.id,
      durationSec: entry.durationSec,
      startedAt: entry.startedAt,
      mode: entry.mode,
      systemAudio: entry.systemAudio,
    });

    if (query.msgId) {
      const claimed = items.find((item) => item.msgId === query.msgId);
      if (claimed) return toLookup(claimed);
    }

    const candidates = items.filter(
      (item) =>
        !item.msgId &&
        item.kind === query.kind &&
        item.conv === query.conv &&
        Math.abs(item.endedAt - query.sendTimeMs) <= MATCH_WINDOW_MS,
    );
    if (candidates.length === 0) return null;
    candidates.sort(
      (a, b) => Math.abs(a.endedAt - query.sendTimeMs) - Math.abs(b.endedAt - query.sendTimeMs),
    );
    const best = candidates[0]!;
    if (query.msgId) {
      best.msgId = query.msgId;
      await this.writeIndex();
    }
    return toLookup(best);
  }

  // ── 内部 ──

  private indexPath(): string {
    return join(this.root, 'index.json');
  }

  private contains(path: string): boolean {
    const rel = relative(this.root, path);
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && !rel.includes(`..${sep}`);
  }

  /** 同名的 `.wav` 已经存在时加 `-2`、`-3`…（用户把目录指到了别处时可能撞上）。 */
  private async uniqueName(base: string): Promise<string> {
    for (let index = 1; index < 1000; index++) {
      const name = index === 1 ? `${base}.wav` : `${base}-${index}.wav`;
      if (!existsSync(join(this.root, name))) return name;
    }
    return `${base}-${Date.now()}.wav`;
  }

  /** 原子写：先写临时文件再 rename，避免进程中途被杀留下半个 JSON。 */
  private async writeIndex(): Promise<void> {
    const items = this.cache ?? [];
    const target = this.indexPath();
    const tmp = `${target}.${process.pid}.tmp`;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(tmp, JSON.stringify(items, null, 2), 'utf8');
    await rename(tmp, target);
  }
}

/** 索引条目形状校验：坏数据宁可丢掉，也不要让界面拿到半截对象。 */
function isEntry(value: unknown): value is CallRecordingEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === 'string' &&
    typeof entry.fileName === 'string' &&
    (entry.kind === 'c2c' || entry.kind === 'group') &&
    typeof entry.conv === 'string' &&
    typeof entry.startedAt === 'number' &&
    typeof entry.endedAt === 'number' &&
    typeof entry.durationSec === 'number' &&
    (entry.mode === 'self' || entry.mode === 'peer' || entry.mode === 'mixed') &&
    typeof entry.systemAudio === 'boolean'
  );
}

/** `2026-10-25_21-03-11`（本地时间，文件名里不出现冒号 —— Windows 不允许）。 */
export function formatStamp(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  );
}

/** 文件名里只留安全字符（对端可能是 uid，含 `_` 与 `-`，都保留）。 */
function safeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
  return cleaned || 'call';
}

/** 供日志 / 界面展示的目录名。 */
export function recordingsRootFor(appDataRoot: string, selfUin: string): string {
  return join(appDataRoot, 'recordings', safeSegment(selfUin) || 'unknown');
}

/** 只取文件名（给「打开目录」用）。 */
export function fileNameOf(path: string): string {
  return basename(path);
}
