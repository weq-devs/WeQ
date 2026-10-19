import { useState } from 'react';
import { ArrowLeft, FileUp, FolderPlus, Trash2, Pencil, FolderInput } from 'lucide-react';
import { client, trpc } from '../../trpc/client';
import type { GroupFileWire, GroupFolderWire } from '../../lib/groupFile';
import { formatSize } from '../../lib/groupFile';
import {
  ActionFeedback,
  ActionIcon,
  useQQAction,
  useQQGroupPermissions,
  withQQAccountScope,
} from './shared';

function GroupFileActionsBody({
  groupId,
  directory,
  files,
  folders,
  onChanged,
}: {
  groupId: number;
  directory: string;
  files: GroupFileWire[];
  folders: GroupFolderWire[];
  onChanged: () => void;
}) {
  const a = useQQAction(`files:${groupId}:${directory}`);
  const permissions = useQQGroupPermissions(groupId, a);
  const canManage = permissions.data?.canManage ?? false;
  const manageableFiles = files.filter(
    (file) => canManage || String(file.uploaderUin) === permissions.data?.selfUin,
  );
  const [selectedMode, setMode] = useState<
    'upload' | 'createFolder' | 'rename' | 'move' | 'delete' | 'renameFolder' | 'deleteFolder'
  >('createFolder');
  const mode =
    !canManage && ['createFolder', 'renameFolder', 'deleteFolder'].includes(selectedMode)
      ? 'upload'
      : selectedMode;
  const [target, setTarget] = useState('');
  const [name, setName] = useState('');
  const [destination, setDestination] = useState('/');
  const [destinationCrumbs, setDestinationCrumbs] = useState([{ id: '/', name: '全部文件' }]);
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<{ path: string; fileName: string } | null>(null);
  const summary = trpc.account.qqActions.fileSummary.useQuery(
    { ...a.binding!, groupId },
    { enabled: open && a.available, retry: false, staleTime: 60_000 },
  );
  const roots = trpc.account.qqActions.folders.useQuery(
    { ...a.binding!, groupId, directory: destination },
    { enabled: open && a.available && mode === 'move', retry: false },
  );
  const folderMode = mode === 'renameFolder' || mode === 'deleteFolder';
  const selected = folderMode
    ? folders.find((f) => f.folderId === target)
    : manageableFiles.find((f) => f.fileId === target);
  const needsName = mode === 'rename' || mode === 'renameFolder' || mode === 'createFolder';
  const valid =
    (!needsName || Boolean(name.trim())) &&
    (mode === 'createFolder' || (mode === 'upload' ? Boolean(file) : Boolean(selected))) &&
    (mode !== 'move' || destination !== directory);
  return (
    <details className="weq-qq-actions" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>文件管理</summary>
      <div className="weq-qq-action-form">
        {summary.data && (
          <span className="weq-qq-action-summary">
            {summary.data.fileCount} / {summary.data.maxCount} 个文件 ·{' '}
            {formatSize(summary.data.usedSpace)} / {formatSize(summary.data.totalSpace)}
          </span>
        )}
        {summary.error && <p role="alert">{summary.error.message}</p>}
        <select
          aria-label="文件操作"
          value={mode}
          onChange={(e) => {
            setMode(e.target.value as typeof mode);
            setTarget('');
            setName('');
          }}
        >
          {canManage && <option value="createFolder">新建文件夹</option>}
          <option value="upload">上传到当前目录</option>
          <option value="rename">重命名文件</option>
          <option value="move">移动文件</option>
          <option value="delete">删除文件</option>
          {canManage && <option value="renameFolder">重命名文件夹</option>}
          {canManage && <option value="deleteFolder">删除文件夹</option>}
        </select>
        {mode === 'upload' && (
          <div className="weq-qq-action-bar">
            <ActionIcon
              label="选择上传文件"
              disabled={a.disabled}
              onClick={() =>
                void a.pickFile().then((f) => {
                  if (f) setFile(f);
                })
              }
            >
              <FileUp size={16} />
            </ActionIcon>
            <span>{file?.fileName}</span>
          </div>
        )}
        {mode !== 'createFolder' && mode !== 'upload' && (
          <select aria-label="操作目标" value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">选择{folderMode ? '文件夹' : '文件'}</option>
            {folderMode
              ? folders.map((f) => (
                  <option key={f.folderId} value={f.folderId}>
                    {f.folderName}
                  </option>
                ))
              : manageableFiles.map((f) => (
                  <option key={f.fileId} value={f.fileId}>
                    {f.fileName}
                  </option>
                ))}
          </select>
        )}
        {needsName && (
          <input
            aria-label="新名称"
            placeholder="新名称"
            maxLength={256}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        )}
        {mode === 'move' && (
          <>
            <div className="weq-qq-action-bar">
              <ActionIcon
                label="目标目录返回上级"
                disabled={destinationCrumbs.length < 2 || roots.isFetching}
                onClick={() => {
                  const next = destinationCrumbs.slice(0, -1);
                  setDestinationCrumbs(next);
                  setDestination(next.at(-1)!.id);
                }}
              >
                <ArrowLeft size={16} />
              </ActionIcon>
              <span>{destinationCrumbs.map((c) => c.name).join(' / ')}</span>
            </div>
            <select
              aria-label="目标文件夹"
              value=""
              disabled={roots.isFetching}
              onChange={(e) => {
                const folder = roots.data?.folders.find((f) => f.folderId === e.target.value);
                if (folder) {
                  setDestination(folder.folderId);
                  setDestinationCrumbs((old) => [
                    ...old,
                    { id: folder.folderId, name: folder.folderName },
                  ]);
                }
              }}
            >
              <option value="">选择下级目录（当前目录为目标）</option>
              {roots.data?.folders.map((f) => (
                <option key={f.folderId} value={f.folderId}>
                  {f.folderName}
                </option>
              ))}
            </select>
          </>
        )}
        <div className="weq-qq-action-bar">
          <ActionIcon
            label="执行文件操作"
            disabled={a.disabled || !valid}
            onClick={() =>
              void a.perform(
                (b) => {
                  if (mode === 'upload') {
                    if (!file) return Promise.reject(new Error('请选择文件'));
                    return client.account.qqActions.fileUpload.mutate({
                      ...b,
                      groupId,
                      path: file.path,
                      directory,
                    });
                  }
                  return client.account.qqActions.file.mutate({
                    ...b,
                    groupId,
                    action: mode,
                    id: mode === 'createFolder' ? undefined : target,
                    directory,
                    name: needsName ? name : undefined,
                    destination: mode === 'move' ? destination : undefined,
                  });
                },
                async () => {
                  setName('');
                  setTarget('');
                  setFile(null);
                  await summary.refetch();
                  onChanged();
                },
                mode === 'upload'
                  ? `上传文件到 QQ 群 ${groupId} 的当前目录并发布群文件消息？`
                  : mode.startsWith('delete')
                    ? `将从 QQ 群 ${groupId} 删除所选${folderMode ? '文件夹及其内容' : '文件'}，此操作不能撤销。`
                    : undefined,
              )
            }
          >
            {mode === 'upload' ? (
              <FileUp size={16} />
            ) : mode.startsWith('delete') ? (
              <Trash2 size={16} />
            ) : mode === 'move' ? (
              <FolderInput size={16} />
            ) : mode === 'createFolder' ? (
              <FolderPlus size={16} />
            ) : (
              <Pencil size={16} />
            )}
          </ActionIcon>
        </div>
        {roots.error && <p role="alert">{roots.error.message}</p>}
        <ActionFeedback action={a} />
      </div>
    </details>
  );
}
export const GroupFileActions = withQQAccountScope(GroupFileActionsBody);
