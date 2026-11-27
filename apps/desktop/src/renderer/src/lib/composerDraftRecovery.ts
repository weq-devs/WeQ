const PREFIX = 'weq:composer-draft:v1:';
const RAW_SNAPSHOT = '2\n';

type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

export type ComposerDraftSnapshot = { body: string; baseVersion: string | null };

function readSnapshot(raw: string): ComposerDraftSnapshot {
  if (raw.startsWith(RAW_SNAPSHOT)) {
    const headerEnd = raw.indexOf('\n', RAW_SNAPSHOT.length);
    if (headerEnd < 0) throw new Error('草稿恢复快照损坏');
    const baseVersion: unknown = JSON.parse(raw.slice(RAW_SNAPSHOT.length, headerEnd));
    if (baseVersion !== null && typeof baseVersion !== 'string')
      throw new Error('草稿恢复快照损坏');
    return { body: raw.slice(headerEnd + 1), baseVersion };
  }
  const value: unknown = JSON.parse(raw);
  if (
    !value ||
    typeof value !== 'object' ||
    !('version' in value) ||
    value.version !== 1 ||
    !('body' in value) ||
    typeof value.body !== 'string'
  )
    throw new Error('草稿恢复快照损坏');
  return {
    body: value.body,
    baseVersion:
      'baseVersion' in value && typeof value.baseVersion === 'string' ? value.baseVersion : null,
  };
}

/** 每次输入同步交给浏览器持久存储；空串是清空记录，不能当作没有快照。 */
export function createComposerDraftRecovery(
  source: DraftStorage | (() => DraftStorage) = () => localStorage,
  watchOtherWindows?: (invalidate: (name: string | null) => void) => void,
) {
  const storage = () => (typeof source === 'function' ? source() : source);
  let watching = false;
  let lastWrite: { store: DraftStorage; name: string; snapshot: ComposerDraftSnapshot } | undefined;
  const accountPrefix = (account: string) => `${PREFIX}${encodeURIComponent(account)}:`;
  const key = (account: string, conversation: string) =>
    `${accountPrefix(account)}${encodeURIComponent(conversation)}`;
  function loadSnapshots(account: string): Record<string, ComposerDraftSnapshot> {
    if (!account) return {};
    const store = storage();
    const prefix = accountPrefix(account);
    const rows: [string, ComposerDraftSnapshot][] = [];
    for (let i = 0; i < store.length; i++) {
      const name = store.key(i);
      if (!name?.startsWith(prefix)) continue;
      const raw = store.getItem(name);
      if (raw !== null)
        rows.push([decodeURIComponent(name.slice(prefix.length)), readSnapshot(raw)]);
    }
    return Object.fromEntries(rows);
  }
  return {
    migrate(oldAccount: string, scope: string): void {
      if (!oldAccount || !scope || oldAccount === scope) return;
      const store = storage();
      const ownerKey = `${PREFIX}legacy-owner:${encodeURIComponent(oldAccount)}`;
      // 旧版本也在所有条目复制完后登记 owner。清空后的空键不能触发二次迁移。
      if (store.getItem(ownerKey) !== null) return;
      const oldPrefix = accountPrefix(oldAccount);
      const entries: [string, string][] = [];
      for (let index = 0; index < store.length; index++) {
        const name = store.key(index);
        if (!name?.startsWith(oldPrefix)) continue;
        const raw = store.getItem(name);
        if (raw !== null) {
          readSnapshot(raw);
          entries.push([name.slice(oldPrefix.length), raw]);
        }
      }
      for (const [conversation, raw] of entries) {
        const name = `${accountPrefix(scope)}${conversation}`;
        if (store.getItem(name) === null) store.setItem(name, raw);
      }
      store.setItem(ownerKey, scope);
    },
    loadSnapshots,
    load(account: string): Record<string, string> {
      return Object.fromEntries(
        Object.entries(loadSnapshots(account)).map(([id, snapshot]) => [id, snapshot.body]),
      );
    },
    write(
      account: string,
      conversation: string,
      body: string,
      baseVersion: string | null = null,
    ): void {
      if (!account || !conversation) return;
      const store = storage();
      const name = key(account, conversation);
      if (watchOtherWindows && !watching) {
        watchOtherWindows((changed) => {
          if (changed === null || lastWrite?.name === changed) lastWrite = undefined;
        });
        watching = true;
      }
      let previous: ComposerDraftSnapshot | undefined;
      if (lastWrite?.store === store && lastWrite.name === name) previous = lastWrite.snapshot;
      else {
        const raw = store.getItem(name);
        if (raw !== null) previous = readSnapshot(raw);
      }
      if (previous?.body === body && previous.baseVersion === baseVersion) return;
      // 单键提交保留强退恢复与跨窗口确认。只有版本头走 JSON，正文原样存储。
      store.setItem(name, `${RAW_SNAPSHOT}${JSON.stringify(baseVersion)}\n${body}`);
      if (watching) lastWrite = { store, name, snapshot: { body, baseVersion } };
    },
    confirm(
      account: string,
      conversation: string,
      body: string,
      baseVersion: string | null = null,
    ): void {
      const store = storage();
      const name = key(account, conversation);
      // 保存回执始终读取最新磁盘值，避免删除其它窗口随后写入的版本。
      if (lastWrite?.store === store && lastWrite.name === name) lastWrite = undefined;
      const raw = store.getItem(name);
      if (raw === null) return;
      const snapshot = readSnapshot(raw);
      if (snapshot.body === body && snapshot.baseVersion === baseVersion) store.removeItem(name);
    },
  };
}

export const composerDraftRecovery = createComposerDraftRecovery(undefined, (invalidate) => {
  window.addEventListener('storage', (event) => {
    if (event.storageArea === localStorage) invalidate(event.key);
  });
});
