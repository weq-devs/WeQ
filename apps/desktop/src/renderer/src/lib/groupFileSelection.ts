import type { GroupFileEntry } from '../views/export/GroupFileExportLightbox';
import type { GroupFileListing, GroupFolderWire } from './groupFile';

const inside = (path: readonly string[], parent: readonly string[]) =>
  parent.every((part, index) => path[index] === part);
export function groupFileSelectedKeys(
  selected: ReadonlyMap<string, GroupFileEntry>,
  folders: readonly GroupFolderWire[],
  cache: ReadonlyMap<string, GroupFileEntry[]>,
): Set<string> {
  const keys = new Set([...selected.keys()].map((id) => `file:${id}`));
  for (const folder of folders) {
    const files = cache.get(folder.folderId);
    if (files?.length && files.every((file) => selected.has(file.fileId)))
      keys.add(`folder:${folder.folderId}`);
  }
  return keys;
}

/** 文件夹键选择其真实子树；始终保留文件身份与原目录，不用行号或展示名称寻址。 */
export async function resolveGroupFileSelection(input: {
  keys: ReadonlySet<string>;
  selected: ReadonlyMap<string, GroupFileEntry>;
  listing: GroupFileListing;
  path: string[];
  cache: ReadonlyMap<string, GroupFileEntry[]>;
  load: (folder: GroupFolderWire) => Promise<GroupFileEntry[]>;
}): Promise<Map<string, GroupFileEntry>> {
  const available = new Map(input.selected);
  for (const file of input.listing.files)
    available.set(file.fileId, {
      fileId: file.fileId,
      fileName: file.fileName,
      fileSize: file.fileSize,
      busId: file.busId,
      uploaderName: file.uploaderName,
      path: input.path,
    });
  const result = new Map<string, GroupFileEntry>();
  for (const key of input.keys) {
    if (!key.startsWith('file:')) continue;
    const file = available.get(key.slice(5));
    if (file) result.set(file.fileId, file);
  }
  const previous = groupFileSelectedKeys(input.selected, input.listing.folders, input.cache);
  for (const folder of input.listing.folders) {
    const key = `folder:${folder.folderId}`;
    if (input.keys.has(key)) {
      const files = input.cache.get(folder.folderId) ?? (await input.load(folder));
      for (const file of files) result.set(file.fileId, file);
    } else if (previous.has(key)) {
      const parent = [...input.path, folder.folderName || folder.folderId];
      for (const [id, file] of result) if (inside(file.path, parent)) result.delete(id);
    }
  }
  return result;
}
