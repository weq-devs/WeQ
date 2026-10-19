import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { client, trpc } from '../../trpc/client';
import { localFileUrl } from '../../lib/resourceUrl';
import {
  ActionFeedback,
  ActionIcon,
  ImageAction,
  RefreshAction,
  SaveAction,
  useQQAction,
  useQQGroupPermissions,
  withQQAccountScope,
} from './shared';

function GroupNoticeActionsBody({ groupId }: { groupId: number }) {
  const a = useQQAction(`notice:${groupId}`);
  const permissions = useQQGroupPermissions(groupId, a);
  const [open, setOpen] = useState(false),
    [content, setContent] = useState('');
  const [picture, setPicture] = useState<{ path: string; fileName: string } | null>(null);
  const [pinned, setPinned] = useState(false),
    [required, setRequired] = useState(false),
    [newMembers, setNewMembers] = useState(false);
  const [popup, setPopup] = useState(false),
    [editCardGuide, setEditCardGuide] = useState(false);
  const notices = trpc.account.qqActions.notices.useQuery(
    { ...a.binding!, groupId },
    { enabled: open && a.available, retry: false },
  );
  const refresh = async () => {
    const r = await notices.refetch();
    if (r.error) throw r.error;
  };
  if (!permissions.data?.canManage) return null;
  return (
    <details className="weq-qq-actions" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>公告管理</summary>
      <div className="weq-qq-action-form">
        <textarea
          aria-label="新公告内容"
          placeholder="公告内容"
          value={content}
          maxLength={4096}
          onChange={(e) => setContent(e.target.value)}
        />
        <div className="weq-qq-action-options">
          <label>
            <input type="checkbox" checked={popup} onChange={(e) => setPopup(e.target.checked)} />
            弹窗提醒
          </label>
          <label>
            <input
              type="checkbox"
              checked={editCardGuide}
              onChange={(e) => setEditCardGuide(e.target.checked)}
            />
            群名片引导
          </label>
          <label>
            <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
            置顶
          </label>
          <label>
            <input
              type="checkbox"
              checked={required}
              onChange={(e) => setRequired(e.target.checked)}
            />
            需要确认
          </label>
          <label>
            <input
              type="checkbox"
              checked={newMembers}
              onChange={(e) => setNewMembers(e.target.checked)}
            />
            新成员公告
          </label>
        </div>
        {picture && (
          <div className="weq-qq-action-image">
            <img src={localFileUrl(picture.path)} alt={picture.fileName} />
            <ActionIcon label="移除公告图片" disabled={a.disabled} onClick={() => setPicture(null)}>
              <Trash2 size={15} />
            </ActionIcon>
          </div>
        )}
        <div className="weq-qq-action-bar">
          <ImageAction
            disabled={a.disabled}
            onClick={() =>
              void a.pickImage().then((f) => {
                if (f) setPicture(f);
              })
            }
          />
          <SaveAction
            label="发布公告"
            disabled={a.disabled || !content.trim()}
            onClick={() =>
              void a.perform(
                (b) =>
                  client.account.qqActions.notice.mutate({
                    ...b,
                    groupId,
                    action: 'publish',
                    content,
                    imagePath: picture?.path,
                    pinned,
                    popup,
                    editCardGuide,
                    confirmRequired: required,
                    newMembers,
                  }),
                async () => {
                  setContent('');
                  setPicture(null);
                  await refresh();
                },
                `向 QQ 群 ${groupId} 发布公告？`,
              )
            }
          />
          <RefreshAction
            disabled={a.disabled || notices.isFetching}
            onClick={() => void notices.refetch()}
          />
        </div>
        {notices.error && <p role="alert">{notices.error.message}</p>}
        <ul className="weq-qq-action-list">
          {notices.data?.map((n) => (
            <li key={n.noticeId}>
              <span>{n.text}</span>
              <ActionIcon
                label="删除公告"
                disabled={a.disabled}
                onClick={() =>
                  void a.perform(
                    (b) =>
                      client.account.qqActions.notice.mutate({
                        ...b,
                        groupId,
                        action: 'delete',
                        noticeId: n.noticeId,
                      }),
                    refresh,
                    `删除公告「${n.text.slice(0, 40)}」？不能撤销。`,
                  )
                }
              >
                <Trash2 size={15} />
              </ActionIcon>
            </li>
          ))}
        </ul>
        <ActionFeedback action={a} />
      </div>
    </details>
  );
}
export const GroupNoticeActions = withQQAccountScope(GroupNoticeActionsBody);
