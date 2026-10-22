import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, MoreHorizontal, Plus, Send, Trash2, X } from 'lucide-react';
import { client, trpc } from '../../trpc/client';
import { useQQAutoRefresh } from '../../hooks/useQQAutoRefresh';
import { localFileUrl } from '../../lib/resourceUrl';
import {
  mergeGroupNotices,
  type GroupBulletinWire,
  type GroupNoticeEntry,
} from '../../lib/groupNotices';
import { useDraftClose, useDraftProtection } from '../../lib/draftClose';
import { ConversationActionsMenu } from '../ConversationActionsMenu';
import { GroupBulletinList } from '../GroupBulletinList';
import {
  ActionFeedback,
  ActionIcon,
  ImageAction,
  useQQAction,
  useQQGroupPermissions,
  withQQAccountScope,
} from './shared';
import '../../styles/group-content-management.css';

const emptyDraft = {
  content: '',
  picture: null as { path: string; fileName: string } | null,
  pinned: false,
  required: false,
  newMembers: false,
  popup: false,
  editCardGuide: false,
};
function GroupNoticeActionsBody({
  groupId,
  groupName = '',
  currentAnnouncement,
  bulletins = [],
}: {
  groupId: number;
  groupName?: string;
  currentAnnouncement?: string | null;
  bulletins?: GroupBulletinWire[];
}) {
  const a = useQQAction(`notice:${groupId}`);
  const permissions = useQQGroupPermissions(groupId, a);
  const canManage = permissions.data?.canManage === true;
  const autoRefresh = useQQAutoRefresh(a.available && canManage);
  const [editor, setEditor] = useState(false);
  const [draft, setDraft] = useState(emptyDraft);
  const revision = useRef(0);
  const mounted = useRef(true);
  const newButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [sending, setSending] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; entry: GroupNoticeEntry } | null>(null);
  const busy = a.busy || a.pending;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (editor) textarea.current?.focus();
  }, [editor]);
  useEffect(() => {
    if (!editor && !busy && restoreFocus.current) {
      newButton.current?.focus();
      restoreFocus.current = false;
    }
  }, [editor, busy]);
  function resetEditor() {
    revision.current++;
    setDraft(emptyDraft);
    restoreFocus.current = true;
    setEditor(false);
  }
  const registered = useDraftProtection(draft, busy);
  const closing = useDraftClose(
    () => {
      registered.reset(emptyDraft);
      closing.reset(emptyDraft);
      resetEditor();
    },
    draft,
    busy,
  );
  const notices = trpc.account.qqActions.notices.useQuery({ ...a.binding!, groupId }, autoRefresh);
  const entries = useMemo(
    () => mergeGroupNotices(bulletins, canManage ? notices.data : undefined),
    [bulletins, canManage, notices.data],
  );
  async function refresh() {
    const result = await notices.refetch();
    if (result.error) throw result.error;
  }
  function change(patch: Partial<typeof draft>) {
    revision.current++;
    setDraft((value) => ({ ...value, ...patch }));
  }
  async function publish() {
    if (sending || a.disabled || !canManage || !draft.content.trim()) return;
    const capturedRevision = revision.current;
    const selected = { ...draft };
    const before = new Set(notices.data?.map((notice) => notice.noticeId));
    let accepted = false;
    setSending(true);
    try {
      await a.perform(
        async (binding) => {
          const result = await client.account.qqActions.notice.mutate({
            ...binding,
            groupId,
            action: 'publish',
            content: selected.content,
            imagePath: selected.picture?.path,
            pinned: selected.pinned,
            popup: selected.popup,
            editCardGuide: selected.editCardGuide,
            confirmRequired: selected.required,
            newMembers: selected.newMembers,
          });
          accepted = result.state === 'accepted' || result.state === 'confirmed';
          return result;
        },
        async () => {
          if (accepted && mounted.current && capturedRevision === revision.current) {
            registered.reset(emptyDraft);
            closing.reset(emptyDraft);
            resetEditor();
          }
          await refresh();
        },
        `向 QQ 群 ${groupId} 发布公告？`,
        {
          readback: async () => {
            const result = await notices.refetch();
            if (result.error) throw result.error;
            return (
              result.data?.some(
                (notice) => !before.has(notice.noticeId) && notice.text.includes(selected.content),
              ) ?? false
            );
          },
        },
      );
    } finally {
      if (mounted.current) setSending(false);
    }
  }
  const options = [
    ['popup', '弹窗提醒'],
    ['editCardGuide', '群昵称引导'],
    ['pinned', '置顶'],
    ['required', '需要确认'],
    ['newMembers', '新成员公告'],
  ] as const;
  return (
    <section className="weq-notice-management" aria-label="群公告内容">
      <div className="weq-content-toolbar">
        <span>{entries.length} 条已读取公告</span>
        {canManage && (
          <div>
            <button
              ref={newButton}
              type="button"
              className="weq-set-iconbtn"
              title="新建公告"
              aria-label="新建公告"
              aria-expanded={editor}
              disabled={a.disabled || editor}
              onClick={() => setEditor(true)}
            >
              <Plus size={17} />
            </button>
          </div>
        )}
      </div>
      {notices.isFetching && canManage && (
        <p role="status" className="weq-content-status">
          读取在线公告中…
        </p>
      )}
      {notices.error && canManage && (
        <p role="alert" className="weq-content-error">
          {notices.error.message}
        </p>
      )}
      {permissions.error && (
        <p role="status" className="weq-content-status">
          管理权限未确认：{permissions.error.message}
        </p>
      )}
      {canManage && !a.available && (
        <p role="status" className="weq-content-status">
          QQ 在线能力未就绪，本地公告仍可阅读
        </p>
      )}
      {editor && (
        <section
          className="weq-notice-editor weq-qq-action-form"
          aria-label="公告发布编辑器"
          aria-busy={sending}
        >
          <div className="weq-content-toolbar">
            <h3>发布新公告</h3>
            <ActionIcon label="关闭公告编辑器" disabled={busy} onClick={closing.requestClose}>
              <X size={16} />
            </ActionIcon>
          </div>
          <textarea
            ref={textarea}
            aria-label="新公告内容"
            placeholder="公告内容"
            value={draft.content}
            maxLength={4096}
            onChange={(event) => change({ content: event.target.value })}
          />
          <div className="weq-qq-action-options">
            {options.map(([key, label]) => (
              <label key={key}>
                <input
                  type="checkbox"
                  checked={draft[key]}
                  onChange={(event) => change({ [key]: event.target.checked })}
                />
                {label}
              </label>
            ))}
          </div>
          {draft.picture && (
            <div className="weq-qq-action-image">
              <img src={localFileUrl(draft.picture.path)} alt={draft.picture.fileName} />
              <ActionIcon
                label="移除公告图片"
                disabled={busy}
                onClick={() => change({ picture: null })}
              >
                <Trash2 size={15} />
              </ActionIcon>
            </div>
          )}
          <div className="weq-qq-action-bar">
            <ImageAction
              disabled={a.disabled || !canManage}
              onClick={() =>
                void a.pickImage().then((picture) => {
                  if (picture) change({ picture });
                })
              }
            />
            <ActionIcon
              label="发布公告"
              disabled={a.disabled || !canManage || !draft.content.trim()}
              onClick={() => void publish()}
            >
              {sending ? <Loader2 size={16} className="weq-spin" /> : <Send size={16} />}
            </ActionIcon>
          </div>
        </section>
      )}
      <ActionFeedback action={a} />
      {currentAnnouncement?.trim() && (
        <section className="weq-current-notice">
          <h3>当前公告</h3>
          <p>{currentAnnouncement}</p>
        </section>
      )}
      <GroupBulletinList
        entries={entries}
        groupCode={String(groupId)}
        groupName={groupName}
        tools={(entry) =>
          canManage && entry.noticeId ? (
            <button
              type="button"
              className="weq-set-iconbtn weq-notice-row-menu"
              title="公告操作"
              aria-label={`公告操作 ${entry.noticeId}`}
              disabled={a.disabled}
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                setMenu({ x: rect.left, y: rect.bottom, entry });
              }}
            >
              <MoreHorizontal size={17} />
            </button>
          ) : null
        }
        onContextMenu={(event, entry) => {
          if (!canManage || !entry.noticeId || a.disabled) return;
          event.preventDefault();
          setMenu({ x: event.clientX, y: event.clientY, entry });
        }}
      />
      {!entries.length && !currentAnnouncement?.trim() && !notices.isFetching && (
        <p className="weq-content-status">暂无可显示的群公告</p>
      )}
      {menu && canManage && (
        <ConversationActionsMenu
          x={menu.x}
          y={menu.y}
          label="公告操作"
          onClose={() => setMenu(null)}
          actions={[
            {
              label: '删除公告',
              icon: <Trash2 size={15} />,
              disabled: a.disabled || !menu.entry.noticeId,
              action: () => {
                const selected = menu.entry;
                void a.perform(
                  (binding) =>
                    client.account.qqActions.notice.mutate({
                      ...binding,
                      groupId,
                      action: 'delete',
                      noticeId: selected.noticeId,
                    }),
                  refresh,
                  `删除公告「${selected.text.slice(0, 40)}」？不能撤销。`,
                  {
                    readback: async () => {
                      const result = await notices.refetch();
                      if (result.error) throw result.error;
                      return Boolean(
                        result.data &&
                          !result.data.some((notice) => notice.noticeId === selected.noticeId),
                      );
                    },
                  },
                );
              },
            },
          ]}
        />
      )}
    </section>
  );
}
const ScopedGroupNoticeActions = withQQAccountScope(GroupNoticeActionsBody);
export function GroupNoticeActions(props: Parameters<typeof GroupNoticeActionsBody>[0]) {
  return <ScopedGroupNoticeActions key={props.groupId} {...props} />;
}
