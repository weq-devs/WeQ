import { useEffect, useState } from 'react';
import { Check, ChevronRight, LogOut, MoreHorizontal, Plus, Trash2, X } from 'lucide-react';
import { ConversationActionsMenu } from '../ConversationActionsMenu';
import { OverlayLayer } from '../OverlayLayer';
import {
  groupTodoHistoryKey,
  groupTodoKey,
  mergeGroupTodoHistory,
  readGroupTodoHistory,
  saveGroupTodoHistory,
  type GroupTodoRecord,
} from '../../lib/groupTodoHistory';
import '../../styles/group-content-management.css';
import '../../styles/qq-management.css';
import { client, trpc } from '../../trpc/client';
import { useQQAutoRefresh } from '../../hooks/useQQAutoRefresh';
import { GroupReadTools } from './GroupReadTools';
import { GroupJoinSettings } from './GroupJoinSettings';
import {
  ActionFeedback,
  ActionIcon,
  useQQAction,
  useQQGroupPermissions,
  withQQAccountScope,
} from './shared';

function GroupActionsBody({ groupId }: { groupId: number }) {
  const a = useQQAction(`group:${groupId}`);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [tag, setTag] = useState('');
  const groupRefresh = useQQAutoRefresh(a.available);
  const info = trpc.account.qqActions.groupJoinSettings.useQuery(
    { ...a.binding!, groupId },
    groupRefresh,
  );
  const category =
    a.available && !info.error && info.data?.groupId === groupId
      ? (info.data.categoryId ?? null)
      : null;
  const tagsRefresh = useQQAutoRefresh(a.available && category !== null);
  const tags = trpc.account.qqActions.tags.useQuery(
    { ...a.binding!, category: category ?? 0 },
    tagsRefresh,
  );
  return (
    <section className="weq-qq-actions" aria-label="更多 QQ 群操作">
      <div className="weq-group-management-heading">
        <h4>群管理</h4>
        <button
          type="button"
          className="weq-set-iconbtn"
          title="群管理菜单"
          aria-label="群管理菜单"
          disabled={a.disabled}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            setMenu({ x: rect.left, y: rect.bottom });
          }}
        >
          <MoreHorizontal size={16} />
        </button>
      </div>
      <div className="weq-qq-action-form">
        <GroupJoinSettings key={groupId} groupId={groupId} />
        <section className="weq-group-tags" aria-label="群分类标签">
          <h5>分类标签目录</h5>
          <div className="weq-qq-action-form">
            <select
              key={category ?? 'unknown'}
              aria-label="群分类"
              defaultValue={category ?? ''}
              disabled={a.disabled || category === null}
            >
              {category === null ? (
                <option value="">{info.isFetching ? '读取分类中…' : '未取得群分类'}</option>
              ) : (
                <option value={category}>{info.data?.categoryName || `分类 ${category}`}</option>
              )}
            </select>
            {info.error && <p role="alert">{info.error.message}</p>}
            <input
              aria-label="分类标签名称"
              placeholder="标签名称"
              value={tag}
              maxLength={64}
              onChange={(e) => setTag(e.target.value)}
            />
            <div className="weq-qq-action-bar">
              <ActionIcon
                label="添加分类标签"
                disabled={a.disabled || category === null || !tag.trim()}
                onClick={() =>
                  void a.perform(
                    (b) =>
                      client.account.qqActions.groupSettings.mutate({
                        ...b,
                        groupId,
                        action: 'addTag',
                        category: category ?? undefined,
                        tag,
                      }),
                    async () => {
                      const result = await tags.refetch();
                      if (result.error) throw result.error;
                    },
                    undefined,
                    {
                      readback: async () => {
                        const result = await tags.refetch();
                        if (result.error) throw result.error;
                        return result.data?.some((item) => item.name === tag) ?? false;
                      },
                    },
                  )
                }
              >
                <Plus size={16} />
              </ActionIcon>
            </div>
            {tags.error && <p role="alert">{tags.error.message}</p>}
            <ul className="weq-qq-action-list">
              {category !== null &&
                tags.data?.map((t) => (
                  <li key={t.name}>
                    <span>{t.name}</span>
                    <ActionIcon
                      label="删除分类标签"
                      disabled={a.disabled || category === null}
                      onClick={() =>
                        void a.perform(
                          (b) =>
                            client.account.qqActions.groupSettings.mutate({
                              ...b,
                              groupId,
                              action: 'deleteTag',
                              category: category ?? undefined,
                              tag: t.name,
                            }),
                          async () => {
                            const result = await tags.refetch();
                            if (result.error) throw result.error;
                          },
                          `删除分类标签「${t.name}」？`,
                          {
                            readback: async () => {
                              const result = await tags.refetch();
                              if (result.error) throw result.error;
                              return Boolean(
                                result.data && !result.data.some((item) => item.name === t.name),
                              );
                            },
                          },
                        )
                      }
                    >
                      <Trash2 size={15} />
                    </ActionIcon>
                  </li>
                ))}
            </ul>
          </div>
        </section>
        <ActionFeedback action={a} />
      </div>
      <GroupReadTools groupId={groupId} />
      {menu && (
        <ConversationActionsMenu
          x={menu.x}
          y={menu.y}
          label="群管理菜单"
          onClose={() => setMenu(null)}
          actions={[
            {
              label: '退出 QQ 群',
              icon: <LogOut size={16} />,
              disabled: a.disabled,
              action: () =>
                void a.perform(
                  (b) =>
                    client.account.qqActions.groupSettings.mutate({
                      ...b,
                      groupId,
                      action: 'leave',
                    }),
                  undefined,
                  `退出 QQ 群 ${groupId}？重新加入需要再次申请，不能自动恢复。`,
                  {
                    readback: async () => {
                      const rows = await client.account.listAllGroups.query();
                      return !rows.some((row) => String(row.groupCode) === String(groupId));
                    },
                  },
                ),
            },
          ]}
        />
      )}
    </section>
  );
}
export const GroupActions = withQQAccountScope(GroupActionsBody);
function GroupTodosBody({
  groupId,
  groupName,
  embedded = false,
}: {
  groupId: number;
  groupName?: string;
  embedded?: boolean;
}) {
  const a = useQQAction(`todos:${groupId}`);
  const [opened, setOpened] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; sequence: string } | null>(null);
  const key = a.binding
    ? groupTodoHistoryKey(a.binding.expectedAccountUin, a.binding.expectedAccountConfigId, groupId)
    : '';
  const [history, setHistory] = useState(() => ({ key, rows: readGroupTodoHistory(key) }));
  const [historyError, setHistoryError] = useState('');
  useEffect(() => {
    setHistory({ key, rows: readGroupTodoHistory(key) });
    setHistoryError('');
  }, [key]);
  const permissions = useQQGroupPermissions(groupId, a);
  const autoRefresh = useQQAutoRefresh(a.available);
  const todos = trpc.account.qqActions.todoList.useQuery({ ...a.binding!, groupId }, autoRefresh);
  useEffect(() => {
    const live = todos.data;
    if (!key || !live) return;
    setHistory((previous) => {
      const rows = mergeGroupTodoHistory(
        live,
        previous.key === key ? previous.rows : readGroupTodoHistory(key),
      ).filter((row) => row.completed);
      return previous.key === key && JSON.stringify(previous.rows) === JSON.stringify(rows)
        ? previous
        : { key, rows };
    });
  }, [key, todos.data]);
  useEffect(() => {
    if (!key || history.key !== key) return;
    try {
      saveGroupTodoHistory(key, history.rows);
    } catch {
      setHistoryError('已完成状态保留在当前窗口，但本地记录保存失败，重新打开后可能无法恢复。');
    }
  }, [key, history]);
  const entries = mergeGroupTodoHistory(todos.data ?? [], history.key === key ? history.rows : []);
  const refresh = async () => {
    const r = await todos.refetch();
    if (r.error) throw r.error;
  };
  const isEmpty = a.available && !todos.isFetching && !todos.error && entries.length === 0;
  async function complete(todo: GroupTodoRecord) {
    await a.perform(
      async (binding) => {
        const result = await client.account.qqActions.todo.mutate({
          ...binding,
          groupId,
          sequence: todo.sequence,
          action: 'complete',
        });
        if (result.state === 'accepted' || result.state === 'confirmed') {
          const finished = { ...todo, completed: true, updatedAt: Math.floor(Date.now() / 1000) };
          setHistory((previous) => ({
            key,
            rows: mergeGroupTodoHistory(
              [finished],
              previous.key === key ? previous.rows : [],
            ).filter((row) => row.completed),
          }));
        }
        return result;
      },
      refresh,
      undefined,
      {
        readback: async () => {
          const result = await todos.refetch();
          if (result.error) throw result.error;
          return (
            result.data?.some(
              (row) => String(row.sequence) === String(todo.sequence) && row.completed,
            ) ?? false
          );
        },
      },
    );
  }
  const content = (
    <section className="weq-notice-management weq-todo-content" aria-label="群待办列表">
      {!embedded ? (
        <div className="weq-content-toolbar">
          <h3>群待办</h3>
        </div>
      ) : null}
      {!a.available && (
        <p className="weq-content-status" role="status">
          QQ 在线能力未就绪
        </p>
      )}
      {a.available && todos.isFetching && !todos.data && (
        <p className="weq-content-status" role="status">
          读取待办中…
        </p>
      )}
      {todos.error && (
        <p className="weq-content-error" role="alert">
          {todos.error.message}
        </p>
      )}
      {a.available && isEmpty && (
        <div className="group-announcements-empty weq-todo-empty">暂无群待办</div>
      )}
      <ul className="group-bulletins-list weq-todo-list">
        {entries.map((t) => (
          <li
            key={groupTodoKey(t)}
            className="group-bulletin-item"
            onContextMenu={(event) => {
              if (!permissions.data?.canManage || a.disabled) return;
              event.preventDefault();
              setMenu({ x: event.clientX, y: event.clientY, sequence: String(t.sequence) });
            }}
          >
            <div className="group-bulletin-header">
              <span className="group-bulletin-date">{t.completed ? '已完成' : '待完成'}</span>
              <div className="weq-todo-row-actions">
                <ActionIcon
                  label="完成待办"
                  disabled={a.disabled || Boolean(t.completed)}
                  onClick={() => void complete(t)}
                >
                  <Check size={15} />
                </ActionIcon>
                {permissions.data?.canManage && (
                  <button
                    type="button"
                    className="weq-set-iconbtn"
                    title="待办操作"
                    aria-label={`待办操作 ${t.sequence}`}
                    disabled={a.disabled}
                    onClick={(event) => {
                      const rect = event.currentTarget.getBoundingClientRect();
                      setMenu({ x: rect.left, y: rect.bottom, sequence: String(t.sequence) });
                    }}
                  >
                    <MoreHorizontal size={16} />
                  </button>
                )}
              </div>
            </div>
            <div className="group-bulletin-content">
              <p>{t.text || `消息 ${t.sequence}`}</p>
            </div>
          </li>
        ))}
      </ul>
      <ActionFeedback action={a} />
      {historyError && (
        <p className="weq-content-error" role="alert">
          {historyError}
        </p>
      )}
      {menu && permissions.data?.canManage && (
        <ConversationActionsMenu
          x={menu.x}
          y={menu.y}
          label="待办操作"
          onClose={() => setMenu(null)}
          actions={[
            {
              label: '取消群待办',
              icon: <Trash2 size={15} />,
              disabled: a.disabled,
              action: () =>
                void a.perform(
                  async (binding) => {
                    const canceled = menu.sequence;
                    const result = await client.account.qqActions.todo.mutate({
                      ...binding,
                      groupId,
                      sequence: menu.sequence,
                      action: 'cancel',
                    });
                    if (result.state === 'accepted' || result.state === 'confirmed')
                      setHistory((previous) => ({
                        key,
                        rows: (previous.key === key ? previous.rows : []).filter(
                          (row) => row.sequence !== canceled,
                        ),
                      }));
                    return result;
                  },
                  refresh,
                  '取消这项群待办？',
                  {
                    readback: async () => {
                      const result = await todos.refetch();
                      if (result.error) throw result.error;
                      return Boolean(
                        result.data &&
                          !result.data.some((row) => String(row.sequence) === menu.sequence),
                      );
                    },
                  },
                ),
            },
          ]}
        />
      )}
    </section>
  );
  if (!embedded) return content;
  const latest = entries.find((todo) => !todo.completed) ?? entries[0];
  const close = () => {
    setOpened(false);
    setMenu(null);
  };
  return (
    <>
      <section className="weq-group-announcement weq-group-todos" aria-label="群待办">
        <button
          type="button"
          onClick={() => setOpened(true)}
          title="查看群待办"
          aria-label="查看群待办"
        >
          <span>
            <strong>群待办</strong>
            <ChevronRight size={14} />
          </span>
        </button>
        <p tabIndex={0} aria-label="待办内容">
          {latest
            ? `${latest.completed ? '已完成 · ' : ''}${latest.text || `消息 ${latest.sequence}`}`
            : todos.isFetching
              ? '读取待办中…'
              : '暂无群待办'}
        </p>
        {historyError && <p role="alert">{historyError}</p>}
      </section>
      {opened && (
        <OverlayLayer
          presentation="sidecar"
          title="群待办"
          className="modal-scrim group-announcements-scrim"
          onClose={close}
        >
          <section
            className="group-announcements-dialog"
            role="region"
            aria-label={`${groupName || groupId}的群待办`}
          >
            <header>
              <div>
                <strong>群待办</strong>
                <span>{groupName || groupId}</span>
              </div>
              <button
                type="button"
                className="icon-button"
                title="关闭"
                aria-label="关闭群待办"
                onClick={close}
              >
                <X size={18} />
              </button>
            </header>
            <div className="group-announcements-body">{content}</div>
          </section>
        </OverlayLayer>
      )}
    </>
  );
}
const ScopedGroupTodos = withQQAccountScope(GroupTodosBody);
export function GroupTodos(props: Parameters<typeof GroupTodosBody>[0]) {
  return <ScopedGroupTodos key={props.groupId} {...props} />;
}
