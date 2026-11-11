import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GetGroupJoinInfo, type GroupProfileExtras, type OidbNative } from '@weq/protocol';
import { writeFileAtomic } from '../common/atomic_write';
import type { ContactMetricsService } from './contact_metrics';

interface Snapshot {
  groupId: number;
  updatedAt: number;
  profile: GroupProfileExtras;
}
export interface GroupProfileResult {
  groupId: number;
  profile: GroupProfileExtras | null;
  updatedAt: number | null;
  source: 'cache' | 'online' | 'empty';
  error: string | null;
}
const TTL_MS = 5 * 60_000;
const numberOrNull = (v: unknown) =>
  v === null || (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffffffff);
function validProfile(value: unknown): value is GroupProfileExtras {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  if (
    !['grade', 'activeMemberCount', 'freezeState', 'freezeReason', 'portraitSequence'].every((k) =>
      numberOrNull(row[k]),
    )
  )
    return false;
  if (row.portrait === null) return true;
  if (!row.portrait || typeof row.portrait !== 'object') return false;
  const portrait = row.portrait as Record<string, unknown>;
  return (
    numberOrNull(portrait.count) &&
    numberOrNull(portrait.defaultId) &&
    Array.isArray(portrait.pictures) &&
    portrait.pictures.length <= 1000 &&
    portrait.pictures.every(
      (p: unknown) =>
        p &&
        typeof p === 'object' &&
        ['id', 'left', 'top', 'right', 'bottom'].every((k) => numberOrNull(Reflect.get(p, k))),
    )
  );
}

/** 群资料按需读取；独立账号缓存，不回写 QQ 原库或会话名称。 */
export class GroupProfileReader {
  private root?: string;
  private active = true;
  private readonly cache = new Map<number, Snapshot | null>();
  private readonly loading = new Map<number, Promise<Snapshot | null>>();
  private readonly inflight = new Map<number, Promise<GroupProfileResult>>();
  constructor(
    private readonly online?: { nt: OidbNative; resolvePid: () => number },
    private readonly scheduler: () => ContactMetricsService | undefined = () => undefined,
  ) {}
  setCache(root: string) {
    this.root = root;
  }
  dispose() {
    this.active = false;
    this.cache.clear();
  }
  private current() {
    if (!this.active) throw new Error('账号已关闭，请重新读取群资料');
  }
  private remember(groupId: number, snapshot: Snapshot | null) {
    this.cache.delete(groupId);
    this.cache.set(groupId, snapshot);
    if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value!);
  }
  private async cached(groupId: number): Promise<Snapshot | null> {
    if (this.cache.has(groupId)) return this.cache.get(groupId)!;
    let task = this.loading.get(groupId);
    if (!task) {
      task = (async () => {
        let snapshot: Snapshot | null = null;
        if (this.root)
          try {
            const value: unknown = JSON.parse(
              await readFile(join(this.root, `${groupId}.json`), 'utf8'),
            );
            if (
              value &&
              typeof value === 'object' &&
              'version' in value &&
              value.version === 1 &&
              'groupId' in value &&
              value.groupId === groupId &&
              'updatedAt' in value &&
              typeof value.updatedAt === 'number' &&
              Number.isFinite(value.updatedAt) &&
              value.updatedAt > 0 &&
              'profile' in value &&
              validProfile(value.profile)
            )
              snapshot = { groupId, updatedAt: value.updatedAt, profile: value.profile };
          } catch {
            /* 缺少或损坏的缓存不阻断在线读取。 */
          }
        this.current();
        this.remember(groupId, snapshot);
        return snapshot;
      })().finally(() => this.loading.delete(groupId));
      this.loading.set(groupId, task);
    }
    return task;
  }
  async read(groupId: number, refresh = false, force = false): Promise<GroupProfileResult> {
    this.current();
    if (!Number.isInteger(groupId) || groupId <= 0 || groupId > 0xffffffff)
      throw new Error('群号格式错误');
    const cached = await this.cached(groupId);
    this.current();
    const fallback = (error: string | null = null): GroupProfileResult =>
      structuredClone({
        groupId,
        profile: cached?.profile ?? null,
        updatedAt: cached?.updatedAt ?? null,
        source: cached ? 'cache' : 'empty',
        error,
      });
    if (
      !refresh ||
      (!force && cached && Date.now() >= cached.updatedAt && Date.now() - cached.updatedAt < TTL_MS)
    )
      return fallback();
    const online = this.online;
    if (!online) return fallback('QQ 暂不可在线读取');
    const existing = this.inflight.get(groupId);
    if (existing) return structuredClone(await existing);
    let pid: number;
    try {
      pid = online.resolvePid();
    } catch {
      return fallback('QQ 暂不可在线读取');
    }
    const current = () => {
      this.current();
      if (online.resolvePid() !== pid) throw new Error('QQ 进程已切换，请重新读取群资料');
    };
    const run = async (): Promise<GroupProfileResult> => {
      let profile: GroupProfileExtras;
      try {
        current();
        const result = await GetGroupJoinInfo.invoke(online.nt, pid, {
          groupId,
          includeExtensions: true,
        });
        current();
        if (result.groupId !== groupId || !result.extensions || !validProfile(result.extensions))
          throw new Error('群扩展资料回包无效');
        profile = result.extensions;
      } catch {
        this.current();
        let currentPid: number | undefined;
        try {
          currentPid = online.resolvePid();
        } catch {
          /* QQ 离线后仍可交付旧缓存，但不接受这次在线回包。 */
        }
        if (currentPid !== undefined && currentPid !== pid)
          throw new Error('QQ 进程已切换，请重新读取群资料');
        return fallback('群扩展资料读取失败');
      }
      const snapshot = { groupId, updatedAt: Date.now(), profile: structuredClone(profile) };
      this.remember(groupId, snapshot);
      let error: string | null = null;
      if (this.root)
        try {
          await writeFileAtomic(
            join(this.root, `${groupId}.json`),
            JSON.stringify({ version: 1, ...snapshot }),
          );
        } catch {
          error = '资料已读取，缓存保存失败';
        }
      current();
      return { ...snapshot, source: 'online', error };
    };
    const queue = this.scheduler();
    const task = (queue ? queue.schedule(`group-profile:${groupId}`, run) : run()).finally(() =>
      this.inflight.delete(groupId),
    );
    this.inflight.set(groupId, task);
    return structuredClone(await task);
  }
}
