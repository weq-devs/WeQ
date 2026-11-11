import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileAtomicSync } from '../common/atomic_write';
import {
  isRecord,
  validatePreferencePatch,
  type ClientStateSnapshot,
  type ClientStateChange,
  type SharedDraft,
  type StateNamespace,
} from '../common/client_preferences';

interface State extends ClientStateSnapshot {
  drafts: Record<string, SharedDraft>;
  externalDrafts?: boolean;
  draftBytes?: Record<string, number>;
  restoredReceipts?: string[];
}
export function validateClientState(value: unknown): asserts value is State {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 0 ||
    !isRecord(value.records) ||
    !isRecord(value.drafts)
  )
    throw new Error('跨端状态文件无效');
  validatePreferencePatch(value.values);
  if (value.epoch !== undefined && (typeof value.epoch !== 'string' || value.epoch.length > 128))
    throw new Error('状态世代无效');
  if (
    value.restoredReceipts !== undefined &&
    (!Array.isArray(value.restoredReceipts) ||
      value.restoredReceipts.length > 64 ||
      value.restoredReceipts.some((id) => typeof id !== 'string'))
  )
    throw new Error('共享恢复回执无效');
  if (value.externalDrafts !== undefined && typeof value.externalDrafts !== 'boolean')
    throw new Error('草稿分文件标记无效');
  if (
    value.draftBytes !== undefined &&
    (!isRecord(value.draftBytes) ||
      Object.values(value.draftBytes).some(
        (size) => typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0,
      ))
  )
    throw new Error('草稿容量记录无效');
  if (
    Object.keys(value.records).some(
      (key) => !['pins', 'tasks', 'assistant', 'todos', 'order'].includes(key),
    )
  )
    throw new Error('跨端状态分区无效');
  for (const rows of Object.values(value.records))
    if (!isRecord(rows) || Object.keys(rows).length > 16384) throw new Error('跨端状态记录无效');
  for (const draft of Object.values(value.drafts))
    if (
      !isRecord(draft) ||
      !(draft.version === null || typeof draft.version === 'string') ||
      !Object.hasOwn(draft, 'value')
    )
      throw new Error('草稿版本无效');
}
/** 一个服务进程内按路径复用；提交落盘后才通知各传输客户端。 */
export class ClientStateStore {
  private listeners = new Set<(event: ClientStateChange) => void>();
  private draftWrites = new Map<string, Promise<unknown>>();
  constructor(readonly path: string) {}
  identity(): string {
    const path = join(dirname(this.path), 'identity.json');
    if (existsSync(path)) {
      const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (typeof value !== 'string' || !/^[a-f0-9]{24}$/.test(value))
        throw new Error('电脑同步标识损坏，已保留原件');
      return value;
    }
    const value = randomUUID().replaceAll('-', '').slice(0, 24);
    writeFileAtomicSync(path, JSON.stringify(value));
    return value;
  }
  private read(): State {
    if (!existsSync(this.path))
      return { epoch: 'empty', revision: 0, values: {}, records: {}, drafts: {} };
    const data: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
    validateClientState(data);
    return data;
  }
  snapshot(): ClientStateSnapshot {
    const { epoch, revision, values, records } = this.read();
    return { epoch, revision, values, records };
  }
  exportState() {
    const state = this.read();
    if (!state.externalDrafts) return state;
    return {
      ...state,
      externalDrafts: false,
      draftBytes: undefined,
      drafts: Object.fromEntries(
        Object.keys(state.drafts).map((key) => [key, this.readDraft(state, key)]),
      ),
    };
  }
  private draftPath(key: string) {
    return join(
      dirname(this.path),
      'client-state-drafts',
      `${createHash('sha256').update(key).digest('hex')}.json`,
    );
  }
  private readDraft(state: State, key: string): SharedDraft {
    if (!Object.hasOwn(state.drafts, key)) return { version: null, value: null };
    if (!state.externalDrafts) return state.drafts[key]!;
    const value: unknown = JSON.parse(readFileSync(this.draftPath(key), 'utf8'));
    if (
      !isRecord(value) ||
      value.key !== key ||
      !(value.version === null || typeof value.version === 'string') ||
      !Object.hasOwn(value, 'value')
    )
      throw new Error('草稿文件无效，已保留原件');
    return { version: value.version, value: value.value };
  }
  private draftSummary(key: string, value: unknown) {
    if (!key.startsWith('copy:') || value === null) return null;
    return {
      source: isRecord(value) ? value.source : key,
      preview: JSON.stringify(value).slice(0, 800),
    };
  }
  private externalize(state: State) {
    if (state.externalDrafts) return;
    state.draftBytes = {};
    for (const [key, draft] of Object.entries(state.drafts)) {
      const data = JSON.stringify({ key, ...draft });
      writeFileAtomicSync(this.draftPath(key), data);
      state.draftBytes[key] = Buffer.byteLength(data);
      state.drafts[key] = { version: draft.version, value: this.draftSummary(key, draft.value) };
    }
    state.externalDrafts = true;
  }
  subscribe(listener: (event: ClientStateChange) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  announceDrafts() {
    for (const listener of this.listeners) listener({ revision: Date.now(), section: 'drafts' });
  }
  private commit(state: State, section: ClientStateChange['section']) {
    this.externalize(state);
    state.revision++;
    if (!state.epoch || state.epoch === 'empty') state.epoch = randomUUID();
    const data = JSON.stringify(state);
    if (Buffer.byteLength(data) > 32 * 1024 * 1024)
      throw new Error('跨端状态超过 32 MiB，请先导出并清理草稿副本');
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileAtomicSync(this.path, data);
    for (const listener of this.listeners) listener({ revision: state.revision, section });
    return this.snapshot();
  }
  patch(patch: unknown) {
    validatePreferencePatch(patch);
    const state = this.read();
    state.values = { ...state.values, ...patch };
    return this.commit(state, 'preferences');
  }
  seed(patch: unknown) {
    validatePreferencePatch(patch);
    const state = this.read();
    for (const [key, value] of Object.entries(patch))
      if (!Object.hasOwn(state.values, key)) Object.assign(state.values, { [key]: value });
    return this.commit(state, 'preferences');
  }
  restorePreferences(patch: unknown, receiptId: string) {
    validatePreferencePatch(patch);
    const state = this.read();
    if (state.restoredReceipts?.includes(receiptId)) return this.snapshot();
    state.values = { ...state.values, ...patch };
    state.restoredReceipts = [...(state.restoredReceipts ?? []).slice(-63), receiptId];
    return this.commit(state, 'preferences');
  }
  records(namespace: StateNamespace, patch: Record<string, unknown>, seed = false) {
    if (
      !['pins', 'tasks', 'assistant', 'todos', 'order'].includes(namespace) ||
      !isRecord(patch) ||
      Buffer.byteLength(JSON.stringify(patch)) > 2 * 1024 * 1024
    )
      throw new Error('无效的账号状态');
    const state = this.read();
    const rows = { ...state.records[namespace] };
    for (const [key, value] of Object.entries(patch)) {
      if (!key || key.length > 1024 || ['__proto__', 'constructor', 'prototype'].includes(key))
        throw new Error('无效的状态标识');
      if (namespace === 'pins' && value !== null && typeof value !== 'boolean')
        throw new Error('无效的置顶状态');
      if (['tasks', 'assistant'].includes(namespace) && value !== null && typeof value !== 'string')
        throw new Error('无效的结果版本');
      if (
        namespace === 'order' &&
        key !== 'refreshRange' &&
        value !== null &&
        (!['friends', 'groups'].includes(key) ||
          !isRecord(value) ||
          typeof value.grouping !== 'string' ||
          typeof value.sort !== 'string' ||
          typeof value.descending !== 'boolean')
      )
        throw new Error('无效的联系人排序');
      if (
        namespace === 'order' &&
        key === 'refreshRange' &&
        value !== null &&
        !['older24h', 'all', 'none'].includes(String(value))
      )
        throw new Error('无效的刷新范围');
      if (namespace === 'todos' && value !== null) {
        if (
          !isRecord(value) ||
          value.completed !== true ||
          typeof value.sequence !== 'string' ||
          typeof value.text !== 'string'
        )
          throw new Error('无效的待办历史');
        const previous = rows[key];
        if (isRecord(previous) && Number(previous.updatedAt ?? 0) > Number(value.updatedAt ?? 0))
          continue;
      }
      if (!seed || !Object.hasOwn(rows, key)) rows[key] = value;
    }
    if (Object.keys(rows).length > 16384) throw new Error('账号状态超过容量限制');
    state.records[namespace] = rows;
    return this.commit(state, namespace);
  }
  draft(key: string): SharedDraft {
    return this.readDraft(this.read(), key);
  }
  copies() {
    return Object.entries(this.read().drafts)
      .filter(([key, draft]) => key.startsWith('copy:') && draft.value !== null)
      .map(([key, draft]) => ({ key, ...draft }));
  }
  observeDraft(key: string, value: unknown, writing = false): SharedDraft {
    const current = this.draft(key);
    if (!writing && this.draftWrites.has(key)) return current;
    if (JSON.stringify(current.value) === JSON.stringify(value)) return current;
    const result = this.saveDraft(key, value, current.version);
    return result.current;
  }
  async saveExternalDraft(
    key: string,
    value: unknown,
    expectedVersion: string | null,
    read: () => Promise<unknown>,
    write: () => Promise<void> | Promise<boolean>,
  ) {
    if (Buffer.byteLength(JSON.stringify(value)) > 4 * 1024 * 1024)
      throw new Error('草稿超过容量限制');
    const previous = this.draftWrites.get(key) ?? Promise.resolve();
    const job = previous
      .catch(() => {})
      .then(async () => {
        const current = this.observeDraft(key, await read(), true);
        if (current.version !== expectedVersion) return { ok: false as const, current };
        if ((await write()) === false)
          return { ok: false as const, current: this.observeDraft(key, await read(), true) };
        const actual = await read();
        if (value === null && actual !== null)
          return { ok: false as const, current: this.observeDraft(key, actual, true) };
        return this.saveDraft(key, actual, current.version);
      });
    this.draftWrites.set(key, job);
    try {
      return await job;
    } finally {
      if (this.draftWrites.get(key) === job) this.draftWrites.delete(key);
    }
  }
  saveDraft(key: string, value: unknown, expectedVersion: string | null) {
    if (
      !key ||
      key.length > 1024 ||
      ['__proto__', 'constructor', 'prototype'].includes(key) ||
      Buffer.byteLength(JSON.stringify(value)) > 4 * 1024 * 1024
    )
      throw new Error('草稿超过容量限制或标识无效');
    const state = this.read();
    const current = this.readDraft(state, key);
    if (current.version !== expectedVersion) return { ok: false as const, current };
    const next = { version: randomUUID(), value };
    this.externalize(state);
    const data = JSON.stringify({ key, ...next });
    const sizes = { ...state.draftBytes, [key]: Buffer.byteLength(data) };
    if (Object.values(sizes).reduce((sum, size) => sum + size, 0) > 32 * 1024 * 1024)
      throw new Error('草稿总量超过 32 MiB，请先导出并清理副本');
    state.draftBytes = sizes;
    state.drafts[key] = { version: next.version, value: this.draftSummary(key, value) };
    if (Object.keys(state.drafts).length > 8192) throw new Error('草稿记录超过容量限制');
    writeFileAtomicSync(this.draftPath(key), data);
    this.commit(state, 'drafts');
    return { ok: true as const, current: next };
  }
}
