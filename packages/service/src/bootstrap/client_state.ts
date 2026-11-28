import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileAtomicSync } from '../common/atomic_write';
import { DRAFT_MEDIA_DIR, isDraftImageName, mapDraftImagePaths } from '../common/draft_media';
import { normalizeSearchPreferences } from '../account/search_policy';
import { getLogger } from '../common/logger';
import {
  isNotificationOverrideKey,
  isNotificationScopeMode,
  SCOPED_NOTIFICATION_EVENTS,
} from '../common/notification_settings';
import {
  isRecord,
  validReadPosition,
  newerReadPosition,
  isDirectoryReadKey,
  directoryUnreadKey,
  type DirectoryReadChange,
  validatePreferencePatch,
  type ClientStateSnapshot,
  type ClientStateChange,
  type SharedDraft,
  type StateNamespace,
} from '../common/client_preferences';

interface State extends ClientStateSnapshot {
  drafts: Record<string, SharedDraft>;
  externalDrafts?: boolean;
  versionedDrafts?: boolean;
  draftBytes?: Record<string, number>;
  restoredReceipts?: string[];
}

function directoryReadEntry(
  rows: Record<string, unknown>,
  key: string,
): DirectoryReadChange['before'] {
  const position = rows[key];
  const marker = rows[directoryUnreadKey(key)];
  return {
    position: validReadPosition(position) ? position : undefined,
    marker: typeof marker === 'string' ? marker : undefined,
  };
}

function writeDirectoryReadEntry(
  rows: Record<string, unknown>,
  key: string,
  entry: DirectoryReadChange['before'],
) {
  const marker = directoryUnreadKey(key);
  if (entry.position === undefined) delete rows[key];
  else rows[key] = entry.position;
  if (entry.marker === undefined) delete rows[marker];
  else rows[marker] = entry.marker;
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
  if (value.versionedDrafts !== undefined && typeof value.versionedDrafts !== 'boolean')
    throw new Error('草稿版本文件标记无效');
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
      (key) =>
        ![
          'pins',
          'tasks',
          'assistant',
          'todos',
          'order',
          'notifications',
          'reads',
          'conversationDisplay',
        ].includes(key),
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
  private read(cleanRetiredDrafts = true): State {
    if (!existsSync(this.path))
      return { epoch: 'empty', revision: 0, values: {}, records: {}, drafts: {} };
    const data: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
    if (
      isRecord(data) &&
      isRecord(data.values) &&
      isRecord(data.values.search) &&
      data.values.search.version === undefined
    )
      data.values.search = normalizeSearchPreferences(data.values.search);
    validateClientState(data);
    // 旧副本也可能随备份恢复；按保留键清理，不扫描或读取其他草稿正文。
    const retiredKeys = [
      ...new Set([...Object.keys(data.drafts), ...Object.keys(data.draftBytes ?? {})]),
    ].filter((key) => key.startsWith('copy:'));
    if (retiredKeys.length) {
      for (const key of retiredKeys) {
        const draft = data.drafts[key];
        if (cleanRetiredDrafts)
          this.removeDraftFile(
            this.draftPath(key, data.versionedDrafts ? draft?.version : undefined),
          );
        delete data.drafts[key];
        if (data.draftBytes) delete data.draftBytes[key];
      }
      if (cleanRetiredDrafts) {
        data.revision++;
        writeFileAtomicSync(this.path, JSON.stringify(data));
      }
    }
    return data;
  }
  snapshot(): ClientStateSnapshot {
    const { epoch, revision, values, records } = this.read();
    return { epoch, revision, values, records };
  }
  /** QQ 原草稿随库迁移时仍可能引用旧机器的素材绝对路径。 */
  relocateDraftImages(value: unknown): void {
    const accountDir = dirname(this.path);
    const scope = basename(accountDir);
    const uin = scope.split('_')[0];
    if (!uin || !/^\d{1,20}$/.test(uin)) return;
    const directory = join(accountDir, DRAFT_MEDIA_DIR);
    let contained: boolean | undefined;
    mapDraftImagePaths(value, (path) => {
      const [config, accounts, previousScope, media, name] = path.split(/[/\\]/).slice(-5);
      if (
        config !== 'config' ||
        accounts !== 'accounts' ||
        previousScope?.split('_')[0] !== uin ||
        media !== DRAFT_MEDIA_DIR ||
        !name ||
        !isDraftImageName(name)
      )
        return;
      const local = join(directory, name);
      if (local === path) return;
      try {
        const root = dirname(dirname(dirname(accountDir)));
        contained ??=
          realpathSync(directory) ===
          join(realpathSync(root), 'config', 'accounts', scope, DRAFT_MEDIA_DIR);
        if (contained && lstatSync(local).isFile()) return local;
      } catch {
        // 缺失时保留 QQ 原行提供的引用。
      }
    });
  }

  exportState(includeDrafts = true) {
    const state = this.read(false);
    if (!includeDrafts)
      return {
        epoch: state.epoch,
        revision: state.revision,
        values: state.values,
        records: state.records,
        drafts: {},
      } as State;
    if (!state.externalDrafts) return state;
    return {
      ...state,
      externalDrafts: false,
      versionedDrafts: false,
      draftBytes: undefined,
      drafts: Object.fromEntries(
        Object.keys(state.drafts).map((key) => [key, this.readDraft(state, key)]),
      ),
    };
  }
  private draftPath(key: string, version?: string | null) {
    const hash = createHash('sha256').update(key).digest('hex');
    return join(
      dirname(this.path),
      'client-state-drafts',
      `${hash}${
        version === undefined
          ? ''
          : `.${createHash('sha256')
              .update(version ?? 'null')
              .digest('hex')}`
      }.json`,
    );
  }
  private removeDraftFile(path: string) {
    try {
      rmSync(path, { force: true });
    } catch {
      // 清理不影响已成功发布的索引；读取始终只采用当前索引引用。
    }
  }
  private readDraft(state: State, key: string): SharedDraft {
    if (!Object.hasOwn(state.drafts, key)) return { version: null, value: null };
    if (!state.externalDrafts) return state.drafts[key]!;
    const expected = state.drafts[key]!;
    const value: unknown = JSON.parse(
      readFileSync(
        this.draftPath(key, state.versionedDrafts ? expected.version : undefined),
        'utf8',
      ),
    );
    if (
      !isRecord(value) ||
      value.key !== key ||
      !(value.version === null || typeof value.version === 'string') ||
      !Object.hasOwn(value, 'value') ||
      (state.versionedDrafts && value.version !== expected.version)
    )
      throw new Error('草稿文件无效，已保留原件');
    return { version: value.version, value: value.value };
  }
  private externalize(state: State) {
    if (state.externalDrafts && state.versionedDrafts) return [];
    const retired: string[] = [];
    state.draftBytes = {};
    for (const key of Object.keys(state.drafts)) {
      const draft = this.readDraft(state, key);
      const data = JSON.stringify({ key, ...draft });
      writeFileAtomicSync(this.draftPath(key, draft.version), data);
      if (state.externalDrafts) retired.push(this.draftPath(key));
      state.draftBytes[key] = Buffer.byteLength(data);
      state.drafts[key] = { version: draft.version, value: null };
    }
    state.externalDrafts = true;
    state.versionedDrafts = true;
    return retired;
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
  private commit(
    state: State,
    section: ClientStateChange['section'],
    retired: string[] = [],
    draftKey?: string,
  ) {
    retired.push(...this.externalize(state));
    state.revision++;
    if (!state.epoch || state.epoch === 'empty') state.epoch = randomUUID();
    const data = JSON.stringify(state);
    if (Buffer.byteLength(data) > 32 * 1024 * 1024) throw new Error('跨端状态超过 32 MiB 容量限制');
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileAtomicSync(this.path, data);
    for (const path of retired) this.removeDraftFile(path);
    for (const listener of this.listeners) {
      try {
        listener({ revision: state.revision, section, ...(draftKey ? { draftKey } : {}) });
      } catch (error) {
        getLogger().child({ scope: 'client-state' }).warn('状态已提交，订阅通知失败', { error });
      }
    }
    const { epoch, revision, values, records } = state;
    return structuredClone({ epoch, revision, values, records });
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
      ![
        'pins',
        'tasks',
        'assistant',
        'todos',
        'order',
        'notifications',
        'reads',
        'conversationDisplay',
      ].includes(namespace) ||
      !isRecord(patch) ||
      Buffer.byteLength(JSON.stringify(patch)) > 2 * 1024 * 1024
    )
      throw new Error('无效的账号状态');
    const state = this.read();
    const rows = { ...state.records[namespace] };
    for (const [key, value] of Object.entries(patch)) {
      if (!key || key.length > 1024 || ['__proto__', 'constructor', 'prototype'].includes(key))
        throw new Error('无效的状态标识');
      if (namespace === 'conversationDisplay') {
        if (
          (!/^[1-9]\d{0,19}$/.test(key) && !(key.startsWith('c2c:') && key.length > 4)) ||
          (value !== true && value !== null)
        )
          throw new Error('无效的会话显示设置');
        if (value === null) delete rows[key];
        else rows[key] = value;
        continue;
      }
      if (namespace === 'pins' && value !== null && typeof value !== 'boolean')
        throw new Error('无效的置顶状态');
      if (namespace === 'reads') {
        const observation = !seed && isDirectoryReadKey(key) && isRecord(value) ? value : null;
        const position = observation ? observation.position : value;
        if (!validReadPosition(position) || key.startsWith('unread:'))
          throw new Error('无效的阅读位置');
        const { position: previous, marker } = directoryReadEntry(rows, key);
        const newer = newerReadPosition(position, previous);
        // 迟到的自动阅读不能清掉另一端随后留下的手动标记。
        if (
          marker &&
          observation?.marker === marker &&
          (!previous || previous === position || newer)
        )
          delete rows[directoryUnreadKey(key)];
        if (!previous || (!seed && newer)) rows[key] = position;
        continue;
      }
      if (namespace === 'notifications') {
        if (key.startsWith('override:')) {
          if (!isNotificationOverrideKey(key) || (value !== null && typeof value !== 'boolean'))
            throw new Error('无效的单会话提醒设置');
          if (!seed || !Object.hasOwn(rows, key)) {
            if (value === null) delete rows[key];
            else rows[key] = value;
          }
          continue;
        }
        if (/^mute:(virtual:(?:persona|group)|assistant):.+$/.test(key)) {
          if (typeof value !== 'boolean') throw new Error('无效的免打扰状态');
        } else if (
          value !== null &&
          (!SCOPED_NOTIFICATION_EVENTS.some((event) => event === key) ||
            !isRecord(value) ||
            !isNotificationScopeMode(value.mode) ||
            !Array.isArray(value.targets) ||
            value.targets.some(
              (target) => typeof target !== 'string' || !/^(c2c|group|dataline):.+/.test(target),
            ))
        ) {
          throw new Error('无效的通知会话范围');
        }
      }
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
  setDirectoryReadState(targets: readonly { key: string; position: string }[], unread: boolean) {
    const state = this.read();
    const rows = { ...state.records.reads };
    const changes: DirectoryReadChange[] = [];
    for (const { key, position } of new Map(
      targets.map((target) => [target.key, target]),
    ).values()) {
      if (!isDirectoryReadKey(key) || !validReadPosition(position))
        throw new Error('无效的会话阅读位置');
      const before = directoryReadEntry(rows, key);
      const after: DirectoryReadChange['after'] = unread
        ? { ...before, marker: String(state.revision + 1) }
        : { position: newerReadPosition(position, before.position) ? position : before.position };
      if (before.position !== after.position || before.marker !== after.marker) {
        writeDirectoryReadEntry(rows, key, after);
        changes.push({ key, before, after });
      }
    }
    if (changes.length) this.commitDirectoryReads(state, rows);
    return changes;
  }

  undoDirectoryReadState(changes: readonly DirectoryReadChange[]): number {
    const state = this.read();
    const rows = { ...state.records.reads };
    let restored = 0;
    for (const { key, before, after } of changes) {
      const actual = directoryReadEntry(rows, key);
      if (actual.position !== after.position || actual.marker !== after.marker) continue;
      writeDirectoryReadEntry(rows, key, before);
      restored += 1;
    }
    if (restored) this.commitDirectoryReads(state, rows);
    return restored;
  }

  private commitDirectoryReads(state: State, rows: Record<string, unknown>) {
    if (Object.keys(rows).length > 16384) throw new Error('账号状态超过容量限制');
    state.records.reads = rows;
    this.commit(state, 'reads');
  }
  draft(key: string): SharedDraft {
    return this.readDraft(this.read(), key);
  }
  draftTexts(keys: readonly string[]): Map<string, string> {
    const drafts = new Map<string, string>();
    if (!keys.length) return drafts;
    const state = this.read();
    for (const key of keys) {
      if (!Object.hasOwn(state.drafts, key)) continue;
      try {
        const { value } = this.readDraft(state, key);
        if (typeof value === 'string' && value.trim()) drafts.set(key, value);
      } catch {
        // 单条坏草稿不阻止目录展示其余会话和已保存消息；打开草稿时仍走正式读取路径。
      }
    }
    return drafts;
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
        if (JSON.stringify(current.value) === JSON.stringify(value))
          return { ok: true as const, current };
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
      key.startsWith('copy:') ||
      key.length > 1024 ||
      ['__proto__', 'constructor', 'prototype'].includes(key) ||
      Buffer.byteLength(JSON.stringify(value)) > 4 * 1024 * 1024
    )
      throw new Error('草稿超过容量限制或标识无效');
    const state = this.read();
    const current = this.readDraft(state, key);
    if (JSON.stringify(current.value) === JSON.stringify(value))
      return { ok: true as const, current };
    if (current.version !== expectedVersion) return { ok: false as const, current };
    const next = { version: randomUUID(), value };
    const retired = this.externalize(state);
    if (Object.hasOwn(state.drafts, key)) retired.push(this.draftPath(key, current.version));
    const data = JSON.stringify({ key, ...next });
    const sizes = { ...state.draftBytes, [key]: Buffer.byteLength(data) };
    if (Object.values(sizes).reduce((sum, size) => sum + size, 0) > 32 * 1024 * 1024)
      throw new Error('草稿总量超过 32 MiB 容量限制');
    state.draftBytes = sizes;
    state.drafts[key] = { version: next.version, value: null };
    if (Object.keys(state.drafts).length > 8192) throw new Error('草稿记录超过容量限制');
    const path = this.draftPath(key, next.version);
    try {
      writeFileAtomicSync(path, data);
      this.commit(state, 'drafts', retired, key);
    } catch (error) {
      this.removeDraftFile(path);
      throw error;
    }
    return { ok: true as const, current: next };
  }
}
