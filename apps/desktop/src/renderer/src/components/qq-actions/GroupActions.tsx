import { useState } from 'react';
import { Check, LogOut, MoreHorizontal, Plus, Trash2 } from 'lucide-react';
import { ConversationActionsMenu } from '../ConversationActionsMenu';
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
  const [category, setCategory] = useState(''),
    [tag, setTag] = useState('');
  const tagsRefresh = useQQAutoRefresh(a.available && category !== '');
  const tags = trpc.account.qqActions.tags.useQuery(
    { ...a.binding!, category: Number(category) },
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
          <h5>分类标签</h5>
          <div className="weq-qq-action-form">
            <input
              aria-label="群分类编号"
              type="number"
              min={0}
              max={0xffffffff}
              placeholder="群分类编号"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            />
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
                disabled={a.disabled || category === '' || !tag.trim()}
                onClick={() =>
                  void a.perform(
                    (b) =>
                      client.account.qqActions.groupSettings.mutate({
                        ...b,
                        groupId,
                        action: 'addTag',
                        category: Number(category),
                        tag,
                      }),
                    async () => {
                      await tags.refetch();
                    },
                  )
                }
              >
                <Plus size={16} />
              </ActionIcon>
            </div>
            {tags.error && <p role="alert">{tags.error.message}</p>}
            <ul className="weq-qq-action-list">
              {tags.data?.map((t) => (
                <li key={t.name}>
                  <span>{t.name}</span>
                  <ActionIcon
                    label="删除分类标签"
                    disabled={a.disabled}
                    onClick={() =>
                      void a.perform(
                        (b) =>
                          client.account.qqActions.groupSettings.mutate({
                            ...b,
                            groupId,
                            action: 'deleteTag',
                            category: Number(category),
                            tag: t.name,
                          }),
                        async () => {
                          await tags.refetch();
                        },
                        `删除分类标签「${t.name}」？`,
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
                ),
            },
          ]}
        />
      )}
    </section>
  );
}
export const GroupActions = withQQAccountScope(GroupActionsBody);
function GroupTodosBody({ groupId, embedded = false }: { groupId: number; embedded?: boolean }) {
  const a = useQQAction(`todos:${groupId}`);
  const [menu, setMenu] = useState<{ x: number; y: number; sequence: string } | null>(null);
  const permissions = useQQGroupPermissions(groupId, a);
  const autoRefresh = useQQAutoRefresh(a.available);
  const todos = trpc.account.qqActions.todoList.useQuery({ ...a.binding!, groupId }, autoRefresh);
  const refresh = async () => {
    const r = await todos.refetch();
    if (r.error) throw r.error;
  };
  return (
    <section className="weq-qq-actions weq-todo-content" aria-label="群待办列表">
      <div className="weq-content-toolbar">
        {embedded ? <span>{todos.data?.length ?? 0} 项已读取待办</span> : <h3>群待办</h3>}
      </div>
      {!a.available && <p>QQ 在线能力未就绪</p>}
      {a.available && todos.isFetching && !todos.data && <p role="status">读取待办中…</p>}
      {todos.error && <p role="alert">{todos.error.message}</p>}
      {todos.data?.length === 0 && <p>暂无群待办</p>}
      <ul className="weq-qq-action-list">
        {todos.data?.map((t) => (
          <li
            key={t.sequence}
            onContextMenu={(event) => {
              if (!permissions.data?.canManage || a.disabled) return;
              event.preventDefault();
              setMenu({ x: event.clientX, y: event.clientY, sequence: String(t.sequence) });
            }}
          >
            <span>
              {t.text || `消息 ${t.sequence}`}
              {t.completed ? ' · 已完成' : ''}
            </span>
            <ActionIcon
              label="完成待办"
              disabled={a.disabled || t.completed}
              onClick={() =>
                void a.perform(
                  (b) =>
                    client.account.qqActions.todo.mutate({
                      ...b,
                      groupId,
                      sequence: String(t.sequence),
                      action: 'complete',
                    }),
                  refresh,
                )
              }
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
          </li>
        ))}
      </ul>
      <ActionFeedback action={a} />
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
                  (binding) =>
                    client.account.qqActions.todo.mutate({
                      ...binding,
                      groupId,
                      sequence: menu.sequence,
                      action: 'cancel',
                    }),
                  refresh,
                  '取消这项群待办？',
                ),
            },
          ]}
        />
      )}
    </section>
  );
}
const ScopedGroupTodos = withQQAccountScope(GroupTodosBody);
export function GroupTodos(props: Parameters<typeof GroupTodosBody>[0]) {
  return <ScopedGroupTodos key={props.groupId} {...props} />;
}
