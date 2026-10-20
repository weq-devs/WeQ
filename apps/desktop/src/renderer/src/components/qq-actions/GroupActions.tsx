import { useState } from 'react';
import { Check, LogOut, Plus, Trash2 } from 'lucide-react';
import { client, trpc } from '../../trpc/client';
import { GroupReadTools } from './GroupReadTools';
import { GroupJoinSettings } from './GroupJoinSettings';
import {
  ActionFeedback,
  ActionIcon,
  RefreshAction,
  useQQAction,
  useQQGroupPermissions,
  withQQAccountScope,
} from './shared';

function GroupActionsBody({ groupId }: { groupId: number }) {
  const a = useQQAction(`group:${groupId}`);
  const [category, setCategory] = useState(''),
    [tag, setTag] = useState('');
  const tags = trpc.account.qqActions.tags.useQuery(
    { ...a.binding!, category: Number(category) },
    { enabled: a.available && category !== '', retry: false },
  );
  return (
    <section className="weq-qq-actions" aria-label="更多 QQ 群操作">
      <h4>群管理</h4>
      <div className="weq-qq-action-form">
        <GroupJoinSettings key={groupId} groupId={groupId} />
        <details>
          <summary>分类标签</summary>
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
        </details>
        <div className="weq-qq-action-bar">
          <ActionIcon
            label="退出 QQ 群"
            disabled={a.disabled}
            onClick={() =>
              void a.perform(
                (b) =>
                  client.account.qqActions.groupSettings.mutate({ ...b, groupId, action: 'leave' }),
                undefined,
                `退出 QQ 群 ${groupId}？重新加入需要再次申请，不能自动恢复。`,
              )
            }
          >
            <LogOut size={16} />
          </ActionIcon>
        </div>
        <ActionFeedback action={a} />
      </div>
      <GroupReadTools groupId={groupId} />
    </section>
  );
}
export const GroupActions = withQQAccountScope(GroupActionsBody);
export function GroupTodos({ groupId, embedded = false }: { groupId: number; embedded?: boolean }) {
  const a = useQQAction(`todos:${groupId}`),
    [open, setOpen] = useState(false);
  const permissions = useQQGroupPermissions(groupId, a);
  const todos = trpc.account.qqActions.todoList.useQuery(
    { ...a.binding!, groupId },
    { enabled: (embedded || open) && a.available, retry: false },
  );
  const refresh = async () => {
    const r = await todos.refetch();
    if (r.error) throw r.error;
  };
  const content = (
    <>
      <RefreshAction
        disabled={a.disabled || todos.isFetching}
        onClick={() => void todos.refetch()}
      />
      {!a.available && <p>QQ 在线能力未就绪</p>}
      {a.available && todos.isFetching && !todos.data && <p role="status">读取待办中…</p>}
      {todos.error && <p role="alert">{todos.error.message}</p>}
      {todos.data?.length === 0 && <p>暂无群待办</p>}
      <ul className="weq-qq-action-list">
        {todos.data?.map((t) => (
          <li key={t.sequence}>
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
              <ActionIcon
                label="取消群待办"
                disabled={a.disabled}
                onClick={() =>
                  void a.perform(
                    (b) =>
                      client.account.qqActions.todo.mutate({
                        ...b,
                        groupId,
                        sequence: String(t.sequence),
                        action: 'cancel',
                      }),
                    refresh,
                    '取消这项群待办？',
                  )
                }
              >
                <Trash2 size={15} />
              </ActionIcon>
            )}
          </li>
        ))}
      </ul>
      <ActionFeedback action={a} />
    </>
  );
  return embedded ? (
    <section className="weq-qq-actions" aria-label="群待办列表">
      {content}
    </section>
  ) : (
    <details className="weq-qq-actions" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>群待办</summary>
      {content}
    </details>
  );
}
