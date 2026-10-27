const PREFIX = 'weq:composer-draft:v1:';

type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

function readBody(raw: string): string {
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
  return value.body;
}

/** 每次输入同步交给浏览器持久存储；空串是清空记录，不能当作没有快照。 */
export function createComposerDraftRecovery(
  source: DraftStorage | (() => DraftStorage) = () => localStorage,
) {
  const storage = () => (typeof source === 'function' ? source() : source);
  const accountPrefix = (account: string) => `${PREFIX}${encodeURIComponent(account)}:`;
  const key = (account: string, conversation: string) =>
    `${accountPrefix(account)}${encodeURIComponent(conversation)}`;
  return {
    load(account: string): Record<string, string> {
      if (!account) return {};
      const store = storage();
      const rows: [string, string][] = [];
      for (let i = 0; i < store.length; i++) {
        const name = store.key(i);
        if (!name?.startsWith(accountPrefix(account))) continue;
        const raw = store.getItem(name);
        if (raw !== null)
          rows.push([decodeURIComponent(name.slice(accountPrefix(account).length)), readBody(raw)]);
      }
      return Object.fromEntries(rows);
    },
    write(account: string, conversation: string, body: string): void {
      if (!account || !conversation) return;
      const store = storage();
      const name = key(account, conversation);
      const previous = store.getItem(name);
      if (previous !== null && readBody(previous) === body) return;
      store.setItem(name, JSON.stringify({ version: 1, body }));
    },
    confirm(account: string, conversation: string, body: string): void {
      const store = storage();
      const name = key(account, conversation);
      const raw = store.getItem(name);
      if (raw !== null && readBody(raw) === body) store.removeItem(name);
    },
  };
}

export const composerDraftRecovery = createComposerDraftRecovery();
