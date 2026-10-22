import { useEffect, useRef, useState } from 'react';
import { Plus, Pencil, Trash2, Save, X } from 'lucide-react';
import { client } from '../../trpc/client';
import { Modal } from '../Dialog';
import { ActionIcon, useQQAction, withQQAccountScope } from './shared';
import type { GroupAlbumWire } from '../GroupAlbumDialog';
import '../../styles/friend-directory.css';

function GroupAlbumManagementBody({
  groupCode,
  album,
  onChanged,
}: {
  groupCode: string;
  album?: GroupAlbumWire | null;
  onChanged: () => void;
}) {
  const a = useQQAction(`album-management:${groupCode}:${album?.id ?? ''}`);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  async function submit(action: 'create' | 'modify' | 'delete') {
    let oldIds: string[] = [];
    let matched = false;
    const ok = await a.perform(
      async (binding) => {
        if (action === 'create')
          oldIds = (await client.account.listGroupAlbums.query({ groupCode })).map((row) => row.id);
        if (!live.current) throw new Error('相册编辑已关闭，未提交写入');
        return client.account.qqActions.albumManagement.mutate({
          ...binding,
          groupId: Number(groupCode),
          action,
          albumId: album?.id,
          title: title.trim() || undefined,
          description,
        });
      },
      async () => {
        if (matched && live.current) onChanged();
      },
      action === 'delete'
        ? `删除相册「${album?.title}」及其中全部照片和视频？此操作不可恢复。`
        : undefined,
      {
        requireReadback: true,
        readbackSuccessText: action === 'delete' ? '相册已删除' : '相册已保存',
        readback: async () => {
          const rows = await client.account.listGroupAlbums.query({ groupCode });
          matched =
            action === 'delete'
              ? !rows.some((row) => row.id === album?.id)
              : action === 'create'
                ? rows.some((row) => !oldIds.includes(row.id) && row.title === title.trim())
                : rows.some(
                    (row) =>
                      row.id === album?.id &&
                      row.title === title.trim() &&
                      row.desc.trim() === description.trim(),
                  );
          return matched;
        },
      },
    );
    if (ok && live.current) setEditing(false);
  }
  return (
    <div className="weq-qq-action-bar">
      <ActionIcon
        label={album ? '编辑相册' : '新建相册'}
        disabled={a.disabled}
        onClick={() => {
          setTitle(album?.title ?? '');
          setDescription(album?.desc.trim() ?? '');
          setEditing(true);
        }}
      >
        {album ? <Pencil size={16} /> : <Plus size={16} />}
      </ActionIcon>
      {album && (
        <ActionIcon
          label="删除相册"
          disabled={a.disabled}
          onClick={() => {
            void submit('delete');
          }}
        >
          <Trash2 size={16} />
        </ActionIcon>
      )}
      {editing && (
        <Modal
          centered
          width={440}
          title={album ? '编辑相册' : '新建相册'}
          className="weq-friend-directory-editor"
          onClose={() => {
            if (!a.disabled) setEditing(false);
          }}
        >
          <header>
            <h3>{album ? '编辑相册' : '新建相册'}</h3>
            <button
              type="button"
              aria-label="关闭"
              title="关闭"
              disabled={a.disabled}
              onClick={() => setEditing(false)}
            >
              <X size={18} />
            </button>
          </header>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit(album ? 'modify' : 'create');
            }}
          >
            <label>
              相册名称
              <input
                autoFocus
                required
                maxLength={30}
                value={title}
                disabled={a.disabled}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            <label>
              描述
              <textarea
                maxLength={2000}
                rows={4}
                value={description}
                disabled={a.disabled}
                onChange={(event) => setDescription(event.target.value)}
              />
            </label>
            <footer>
              <button type="submit" disabled={a.disabled || !title.trim()}>
                <Save size={16} />
                保存
              </button>
            </footer>
          </form>
        </Modal>
      )}
    </div>
  );
}
export const GroupAlbumManagement = withQQAccountScope(GroupAlbumManagementBody);
