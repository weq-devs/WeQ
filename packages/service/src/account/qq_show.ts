/**
 * ChatQqShowService — 聊天头像用的 QQ 秀形象 URL 本地缓存。
 *
 * QQ 秀 URL 走 OIDB 0xFE1_3（见 protocol 的 GetQqShowUrl），必须在线实例发包；
 * 同一个人短时间内被反复看到（滚动消息、切换会话、开个性主页）不该每次都发一次包。
 * 所以这里维护一份 `uin → { hasShow, url, fetchedAt }` 的本地映射：
 *
 *  - 有效期由设置里的「QQ 秀缓存有效期」决定（默认 14 天），过期后才重新查询；
 *  - 没有 QQ 秀（hasShow=false）也落一条空记录，避免对同一个人反复空查；
 *  - 最多同时发 {@link QQ_SHOW_FETCH_CONCURRENCY} 个请求，其余排队；
 *  - 同一个 uin 的并发请求合并成一次；失败不清掉旧记录，过期记录仍可在离线时兜底展示
 *    （图片 URL 自带版本号，旧图通常仍能取到）。
 *
 * 这份映射同时供「个性主页」使用：路由里的 peerQqShow 先读缓存，再决定要不要联网。
 * 存储文件按账号放在 `config/accounts/<accountId>/qqshow.json`。
 */
import { existsSync, readFileSync } from 'node:fs';
import { writeFileAtomicSync } from '../common/atomic_write';

/** 设置里未配置时的默认有效期（天）。 */
export const DEFAULT_QQ_SHOW_CACHE_DAYS = 14;
export const QQ_SHOW_CACHE_MIN_DAYS = 1;
export const QQ_SHOW_CACHE_MAX_DAYS = 365;
/** 同时向 QQ 发的 OIDB 包上限。 */
export const QQ_SHOW_FETCH_CONCURRENCY = 3;

const DAY_MS = 24 * 60 * 60 * 1000;
/** 过期记录只为离线兜底保留，超过 4 个有效期就清掉，避免文件无限长。 */
const STALE_KEEP_FACTOR = 4;
const MAX_ENTRIES = 5000;

export interface QqShowResolved {
  hasShow: boolean;
  url: string;
}

interface QqShowEntry extends QqShowResolved {
  /** 最近一次成功查询的时间戳（毫秒）。 */
  fetchedAt: number;
}

export interface ChatQqShowOptions {
  /** 映射文件路径；空 / 缺省时只做内存缓存。 */
  storePath?: string | null;
  /** 有效期（天），每次查询时读取，改设置后立即生效。 */
  ttlDays: () => number;
  /** 实际发包；由账号上下文注入，测试里可用假实现。 */
  fetchShow: (uin: string) => Promise<QqShowResolved>;
  concurrency?: number;
  now?: () => number;
}

function validUin(uin: string): boolean {
  return /^\d{5,20}$/.test(uin);
}

export class ChatQqShowService {
  private readonly entries = new Map<string, QqShowEntry>();
  private readonly pending = new Map<string, Promise<QqShowResolved>>();
  private dirty = false;

  constructor(private readonly opts: ChatQqShowOptions) {
    this.load();
  }

  /** 只读缓存：未过期才返回，未命中返回 null（不联网）。 */
  cached(uin: string): QqShowResolved | null {
    if (!validUin(uin)) return null;
    const entry = this.entries.get(uin);
    if (!entry) return null;
    if (this.now() - entry.fetchedAt >= this.ttlMs()) return null;
    return { hasShow: entry.hasShow, url: entry.url };
  }

  /**
   * 批量解析（聊天消息里的可见成员）。命中的直接返回，未命中的并发补查；
   * 查询失败但有旧记录时返回旧记录，否则从结果里省略。
   */
  async resolve(uins: string[]): Promise<Record<string, QqShowResolved>> {
    const unique = [...new Set(uins.filter(validUin))];
    const out: Record<string, QqShowResolved> = {};
    const tasks: Array<() => Promise<void>> = [];
    for (const uin of unique) {
      const cached = this.cached(uin);
      if (cached) {
        out[uin] = cached;
        continue;
      }
      tasks.push(async () => {
        try {
          out[uin] = await this.fetchOne(uin);
        } catch {
          const stale = this.entries.get(uin);
          if (stale) out[uin] = { hasShow: stale.hasShow, url: stale.url };
        }
      });
    }
    await this.runLimited(tasks);
    this.flush();
    return out;
  }

  /** 单个 uin（个性主页用）：缓存优先，失败时回退到过期记录，完全没有才抛错。 */
  async resolveOne(uin: string): Promise<QqShowResolved> {
    if (!validUin(uin)) throw new Error('无效的 QQ 号');
    const cached = this.cached(uin);
    if (cached) return cached;
    try {
      return await this.fetchOne(uin);
    } catch (error) {
      const stale = this.entries.get(uin);
      if (stale) return { hasShow: stale.hasShow, url: stale.url };
      throw error;
    } finally {
      this.flush();
    }
  }

  private async fetchOne(uin: string): Promise<QqShowResolved> {
    const running = this.pending.get(uin);
    if (running) return running;
    const task = this.opts
      .fetchShow(uin)
      .then((info) => {
        const resolved: QqShowResolved = {
          hasShow: Boolean(info.hasShow && info.url),
          url: info.hasShow ? info.url : '',
        };
        this.entries.set(uin, { ...resolved, fetchedAt: this.now() });
        this.dirty = true;
        return resolved;
      })
      .finally(() => {
        this.pending.delete(uin);
      });
    this.pending.set(uin, task);
    return task;
  }

  private async runLimited(tasks: Array<() => Promise<void>>): Promise<void> {
    const limit = Math.max(1, this.opts.concurrency ?? QQ_SHOW_FETCH_CONCURRENCY);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
      for (;;) {
        const index = next++;
        const task = tasks[index];
        if (!task) return;
        await task();
      }
    });
    await Promise.all(workers);
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private ttlMs(): number {
    const days = Math.min(
      QQ_SHOW_CACHE_MAX_DAYS,
      Math.max(
        QQ_SHOW_CACHE_MIN_DAYS,
        Math.round(this.opts.ttlDays()) || DEFAULT_QQ_SHOW_CACHE_DAYS,
      ),
    );
    return days * DAY_MS;
  }

  private load(): void {
    const path = this.opts.storePath;
    if (!path) return;
    try {
      if (!existsSync(path)) return;
      const raw = JSON.parse(readFileSync(path, 'utf-8')) as {
        entries?: Record<string, unknown> | null;
      };
      const rows = raw?.entries;
      if (!rows || typeof rows !== 'object' || Array.isArray(rows)) return;
      for (const [uin, value] of Object.entries(rows)) {
        if (!validUin(uin) || !value || typeof value !== 'object') continue;
        const row = value as Partial<QqShowEntry>;
        const url = typeof row.url === 'string' ? row.url : '';
        const fetchedAt = Number(row.fetchedAt);
        const hasShow = row.hasShow === true && url !== '' && /^https:\/\//i.test(url);
        if (!Number.isFinite(fetchedAt) || fetchedAt <= 0) continue;
        this.entries.set(uin, {
          hasShow,
          url: hasShow ? url : '',
          fetchedAt,
        });
      }
    } catch {
      // 缓存损坏当作没有：下次查询成功后整份重写，不阻断聊天。
    }
  }

  private flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const path = this.opts.storePath;
    if (!path) return;
    this.prune();
    const entries: Record<string, QqShowEntry> = {};
    for (const [uin, entry] of this.entries) entries[uin] = entry;
    try {
      writeFileAtomicSync(path, JSON.stringify({ version: 1, entries }));
    } catch {
      // 落盘失败不影响本次展示。
    }
  }

  private prune(): void {
    const keepUntil = this.now() - Math.max(this.ttlMs(), DAY_MS) * STALE_KEEP_FACTOR;
    for (const [uin, entry] of this.entries) {
      if (entry.fetchedAt < keepUntil) this.entries.delete(uin);
    }
    while (this.entries.size > MAX_ENTRIES) {
      let oldestUin: string | null = null;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [uin, entry] of this.entries) {
        if (entry.fetchedAt < oldestAt) {
          oldestAt = entry.fetchedAt;
          oldestUin = uin;
        }
      }
      if (!oldestUin) return;
      this.entries.delete(oldestUin);
    }
  }
}
