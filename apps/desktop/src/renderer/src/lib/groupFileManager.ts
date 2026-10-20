import type { GroupFileListing, GroupFileWire, GroupFolderWire } from './groupFile';

export const GROUP_FILE_DRAG_TYPE = 'application/x-weq-group-files';
export const GROUP_FILE_UPLOAD_LIMIT = 100;
export type GroupFileEntryRow =
  | { kind: 'file'; key: string; name: string; file: GroupFileWire }
  | { kind: 'folder'; key: string; name: string; folder: GroupFolderWire };
export type GroupFileSort = 'name' | 'time' | 'size';
export function groupFileEntries(
  files: readonly GroupFileWire[],
  folders: readonly GroupFolderWire[],
  query: string,
  sort: GroupFileSort,
): GroupFileEntryRow[] {
  const rows: GroupFileEntryRow[] = [
    ...folders.map((folder) => ({
      kind: 'folder' as const,
      key: `folder:${folder.folderId}`,
      name: folder.folderName,
      folder,
    })),
    ...files.map((file) => ({
      kind: 'file' as const,
      key: `file:${file.fileId}`,
      name: file.fileName,
      file,
    })),
  ];
  const needle = query.trim().toLocaleLowerCase();
  const time = (row: GroupFileEntryRow) =>
    row.kind === 'file'
      ? row.file.modifiedTime || row.file.uploadedTime
      : row.folder.modifiedTime || row.folder.createTime;
  return [...new Map(rows.map((row) => [row.key, row])).values()]
    .filter((row) => !needle || row.name.toLocaleLowerCase().includes(needle))
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
      const value =
        sort === 'time'
          ? time(b) - time(a)
          : sort === 'size' && a.kind === 'file' && b.kind === 'file'
            ? b.file.fileSize - a.file.fileSize
            : a.name.localeCompare(b.name, 'zh-CN', { numeric: true });
      return value || a.key.localeCompare(b.key);
    });
}
export function canManageGroupFile(
  row: GroupFileEntryRow,
  manager: boolean,
  selfUin?: string | null,
): boolean {
  return manager || (row.kind === 'file' && !!selfUin && String(row.file.uploaderUin) === selfUin);
}
export function validateGroupFileName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 256 || name === '.' || name === '..' || /[/\\\0\r\n]/.test(name))
    throw new Error('名称须为 1–256 字符，不能包含路径分隔符或换行');
  return name;
}
export function groupFileNameConflict(
  name: string,
  listing: GroupFileListing,
  excludeKey?: string,
): boolean {
  const key = name.normalize('NFC').toLocaleLowerCase();
  return groupFileEntries(listing.files, listing.folders, '', 'name').some(
    (row) => row.key !== excludeKey && row.name.normalize('NFC').toLocaleLowerCase() === key,
  );
}
export interface GroupFileDragIdentity {
  groupId: number;
  uin: string;
  configId: string;
  directory: string;
}
export function readGroupFileDrag(
  value: string,
  identity: GroupFileDragIdentity,
  files: readonly GroupFileWire[],
): string[] {
  if (value.length > 64_000) throw new Error('拖拽内容过大，请减少选择');
  const data: unknown = JSON.parse(value);
  if (!data || typeof data !== 'object') throw new Error('无法识别拖拽来源');
  const p = data as Record<string, unknown>;
  if (
    p.version !== 1 ||
    p.groupId !== identity.groupId ||
    p.uin !== identity.uin ||
    p.configId !== identity.configId ||
    p.directory !== identity.directory ||
    !Array.isArray(p.ids) ||
    !p.ids.length ||
    p.ids.length > 256 ||
    p.ids.some((id) => typeof id !== 'string' || !files.some((file) => file.fileId === id))
  )
    throw new Error('拖拽来源或文件已改变，请重新选择');
  return [...new Set(p.ids as string[])];
}
