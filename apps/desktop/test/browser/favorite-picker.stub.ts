import { useSyncExternalStore } from 'react';

const binding = { expectedAccountUin: '10001', expectedAccountConfigId: 'source-a' };
const local = (id: string) => ({
  id,
  hash: id.repeat(32),
  scope: 'personal',
  bucket: '',
  oriFile: `${id.repeat(32)}.png`,
  thumbFile: `${id.repeat(32)}-thumb.png`,
  original: { scope: 'personal', bucket: '', file: `${id.repeat(32)}.png` },
});
let rows = ['a', 'b', 'c'].map((id, index) => ({
  emojiId: `remote-${id}`,
  position: index + 1,
  desc: ['微笑', '周三快乐', '收藏动图'][index],
  local: local(id),
}));
let revision = 0;
const listeners = new Set<() => void>();
const notify = () => {
  revision++;
  for (const listener of listeners) listener();
};
const calls: Array<{ path: string; input: unknown }> = [];
Object.assign(window, { favoritePickerCalls: calls });
const data = (path: string): unknown => {
  if (path === 'account.getAccountConfig') return { uin: '10001', configId: 'source-a' };
  if (path === 'account.getGroupAlbumAccessState')
    return {
      qqOnline: true,
      attachEnabled: true,
      hasA2: true,
      hasD2: true,
      hasD2Key: true,
      hasGuid: true,
      ssoReady: true,
      source: binding,
    };
  if (path === 'account.qqActions.favorites') return rows;
  if (path === 'account.qqActions.favoriteImportState') return null;
  if (path === 'account.emojiPanel.overview')
    return { favorites: rows.map((row) => row.local), faces: [], recent: [], tags: [] };
  if (path === 'bootstrap.getSettings')
    return { exportSaveMode: 'preset', defaultExportDir: '/synthetic' };
  return undefined;
};
const proxy = (parts: string[] = []): unknown =>
  new Proxy(() => {}, {
    get: (_target, key: string) => {
      const path = parts.join('.');
      if (key === 'useQuery')
        return () => {
          useSyncExternalStore(
            (listener) => {
              listeners.add(listener);
              return () => listeners.delete(listener);
            },
            () => revision,
          );
          return {
            data: data(path),
            isLoading: false,
            isFetching: false,
            error: null,
            refetch: async () => ({ data: data(path) }),
          };
        };
      if (key === 'query') return async () => data(path);
      if (key === 'invalidate') return async () => notify();
      if (key === 'cancel') return async () => {};
      if (key === 'mutate')
        return async (input: Record<string, unknown>) => {
          calls.push({ path, input });
          if (path === 'account.pickSendFile')
            return { path: '/synthetic/import.png', fileName: 'import.png' };
          if (path === 'account.pickedFileStart') return { id: 'synthetic-upload' };
          if (path === 'account.pickedFileChunk')
            return { offset: Number(input.offset) + atob(String(input.base64)).length };
          if (path === 'account.pickedFileFinish')
            return { path: '/synthetic/import.png', fileName: 'import.png' };
          if (path === 'bootstrap.prepareExportSave') return input;
          if (path === 'account.qqActions.favorite') {
            if (input.action === 'delete')
              rows = rows.filter((row) => row.emojiId !== input.emojiId);
            if (input.action === 'rename')
              rows = rows.map((row) =>
                row.emojiId === input.emojiId ? { ...row, desc: String(input.desc) } : row,
              );
            if (input.action === 'move')
              rows = rows.sort(
                (a, b) => Number(b.emojiId === input.emojiId) - Number(a.emojiId === input.emojiId),
              );
            if (input.action === 'add')
              rows = [
                { emojiId: 'imported', position: 1, desc: '导入的图片', local: local('d') },
                ...rows,
              ];
            rows = rows.map((row, index) => ({ ...row, position: index + 1 }));
            notify();
            return { state: 'accepted', emojiId: input.action === 'add' ? 'imported' : undefined };
          }
          if (path === 'account.mediaSave.save') return 'synthetic-save-task';
          return undefined;
        };
      return proxy([...parts, key]);
    },
    apply: (_target, _this, args) => (parts.at(-1) === 'useUtils' ? proxy() : args && proxy(parts)),
  });
export const trpc = proxy();
export const client = proxy();
