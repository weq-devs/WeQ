import { NumericText } from '../NumericText';
import { EmptyState } from '../EmptyState';
import { useEffect, useState } from 'react';
import {
  Check,
  ChevronRight,
  LocateFixed,
  LogOut,
  MoreHorizontal,
  Trash2,
  X,
  ListTodo,
  UserRoundX,
} from 'lucide-react';
import { ConversationActionsMenu } from '../ConversationActionsMenu';
import { GroupFeatureSurface } from '../GroupFeatureSurface';
import { Card, Row } from '../settings/controls';
import {
  groupTodoHistoryKey,
  groupTodoKey,
  mergeGroupTodoHistory,
  mergeGroupTodoSources,
  readGroupTodoHistory,
  saveGroupTodoHistory,
  type GroupTodoRecord,
} from '../../lib/groupTodoHistory';
import '../../styles/group-content-management.css';
import { client, trpc } from '../../trpc/client';
import { useQQAutoRefresh, useQQReadActivity } from '../../hooks/useQQAutoRefresh';
import { GroupCategorySettings } from './GroupCategorySettings';
import { GroupManagementRules } from './GroupManagementRules';
import '../../styles/group-management.css';
import { ActionFeedback, ActionIcon } from './shared';
import { useQQAction, useQQGroupPermissions, withQQAccountScope } from './shared.shared';
import { useGroupExitActions } from './relationshipActions.shared';

function GroupActionsBody({
  groupId,
  groupName = 'QQ 群',
}: {
  groupId: number;
  groupName?: string;
}) {
  const a = useQQAction(`group:${groupId}`);
  const permissions = useQQGroupPermissions(groupId, a);
  const canManage = permissions.data?.canManage === true;
  const exits = useGroupExitActions(a);
  const role = permissions.error ? null : permissions.data?.role;
  const exit = role === 'owner' ? exits.disband : role ? exits.leave : null;
  return (
    <div key={groupId} className="weq-group-management">
      <GroupManagementRules groupId={groupId} canManage={canManage} />
      <GroupCategorySettings groupId={groupId} canManage={canManage} action={a} />
      {exit && (
        <Card title="其他操作" icon={<MoreHorizontal />}>
          <Row
            label={role === 'owner' ? '解散会影响所有群成员' : '退出后将无法接收群消息'}
            control={
              <button
                data-danger="outline"
                type="button"
                className="weq-set-btn"
                aria-label={exit.label}
                disabled={exit.disabled}
                onClick={() => void exit.run(groupId, groupName)}
              >
                {role === 'owner' ? (
                  <UserRoundX size={16} aria-hidden />
                ) : (
                  <LogOut size={16} aria-hidden />
                )}
                {exit.label}
              </button>
            }
          />
        </Card>
      )}
      <ActionFeedback action={a} />
    </div>
  );
}
export const GroupActions = withQQAccountScope(GroupActionsBody);
function GroupTodosBody({
  groupId,
  groupName,
  embedded = false,
  onJumpToMessage,
  popoverOpen,
  onPopoverOpenChange,
  popoverAnchor,
  showSummary = true,
}: {
  groupId: number;
  groupName?: string;
  embedded?: boolean;
  onJumpToMessage?: (sequence: string) => void;
  popoverOpen?: boolean;
  onPopoverOpenChange?: (open: boolean, anchor: HTMLElement | null) => void;
  popoverAnchor?: HTMLElement | null;
  showSummary?: boolean;
}) {
  const a = useQQAction(`todos:${groupId}`);
  const [opened, setOpened] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const visible = popoverOpen ?? opened;
  const changeOpen = (next: boolean, element: HTMLElement | null = anchor) => {
    setAnchor(element);
    setOpened(next);
    onPopoverOpenChange?.(next, element);
    if (!next) setMenu(null);
  };
  const [menu, setMenu] = useState<{ x: number; y: number; sequence: string } | null>(null);
  const key = a.binding
    ? groupTodoHistoryKey(a.binding.expectedAccountUin, a.binding.expectedAccountConfigId, groupId)
    : '';
  const [history, setHistory] = useState(() => ({ key, rows: readGroupTodoHistory(key) }));
  const [historyError, setHistoryError] = useState('');
  useEffect(() => {
    const refresh = () => setHistory({ key, rows: readGroupTodoHistory(key) });
    window.addEventListener('weq-shared-account-state', refresh);
    return () => window.removeEventListener('weq-shared-account-state', refresh);
  }, [key]);
  useEffect(() => {
    setHistory({ key, rows: readGroupTodoHistory(key) });
    setHistoryError('');
  }, [key]);
  const permissions = useQQGroupPermissions(groupId, a);
  const autoRefresh = useQQAutoRefresh(a.available);
  const todos = trpc.account.qqActions.todoList.useQuery({ ...a.binding!, groupId }, autoRefresh);
  const localActivity = useQQReadActivity(Boolean(a.binding), { onlineOnly: false });
  const localTodos = trpc.account.qqActions.todoLocalList.useQuery(
    { ...a.binding!, groupId },
    {
      enabled: localActivity.enabled,
      staleTime: 0,
      refetchOnMount: 'always',
      refetchOnWindowFocus: 'always',
    },
  );
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
  const entries = mergeGroupTodoHistory(
    mergeGroupTodoSources(localTodos.data ?? [], todos.data ?? []),
    history.key === key ? history.rows : [],
  );
  const refresh = async () => {
    const [remote, local] = await Promise.all([todos.refetch(), localTodos.refetch()]);
    if (remote.error) throw remote.error;
    if (local.error) throw local.error;
  };
  const readError = localTodos.error || (a.available && todos.error);
  const reading = localTodos.isFetching || (a.available && todos.isFetching);
  const hasRead = localTodos.data !== undefined || (a.available && todos.data !== undefined);
  const isEmpty = hasRead && !readError && entries.length === 0;
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
      {reading && !hasRead && !entries.length && (
        <p className="weq-content-status" role="status">
          读取待办中…
        </p>
      )}
      {todos.error && (
        <p className="weq-content-error" role="alert">
          {todos.error.message}
        </p>
      )}
      {localTodos.error && (
        <p className="weq-content-error" role="alert">
          本地待办读取失败：{localTodos.error.message}
        </p>
      )}
      {isEmpty && <EmptyState compact icon={<ListTodo />} title="暂无群待办" />}
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
                {onJumpToMessage && (
                  <ActionIcon
                    label="定位原消息"
                    disabled={!/^[1-9]\d*$/.test(t.sequence)}
                    onClick={() => {
                      changeOpen(false);
                      setMenu(null);
                      onJumpToMessage(t.sequence);
                    }}
                  >
                    <LocateFixed size={15} />
                  </ActionIcon>
                )}
                <ActionIcon
                  label="完成待办"
                  disabled={a.disabled || Boolean(t.completed) || !/^[1-9]\d*$/.test(t.sequence)}
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
    changeOpen(false);
    setMenu(null);
  };
  return (
    <>
      {showSummary ? (
        <section className="weq-group-summary weq-group-todos" aria-label="群待办">
          <button
            type="button"
            onClick={(event) => changeOpen(!visible, event.currentTarget)}
            title="查看群待办"
            aria-label="查看群待办"
            aria-expanded={visible}
          >
            <strong>待办</strong>
            <span className="weq-todo-summary" aria-label="待办内容">
              {latest ? (
                <>
                  {latest.completed ? '已完成 · ' : ''}
                  {latest.text || <NumericText>{`消息 ${latest.sequence}`}</NumericText>}
                </>
              ) : hasRead ? (
                '暂无待办'
              ) : reading ? (
                '读取中…'
              ) : readError ? (
                '读取失败'
              ) : localTodos.data === undefined ? (
                '尚未读取'
              ) : (
                '暂无待办'
              )}
            </span>
            <ChevronRight size={14} aria-hidden />
          </button>
        </section>
      ) : null}
      {visible && (
        <GroupFeatureSurface
          presentation="popover"
          anchor={popoverAnchor ?? anchor}
          title="群待办"
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
                <span>{groupName || <NumericText>{groupId}</NumericText>}</span>
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
        </GroupFeatureSurface>
      )}
    </>
  );
}
const ScopedGroupTodos = withQQAccountScope(GroupTodosBody, (props) => ({
  kind: 'group',
  id: String(props.groupId),
  section: 'todos',
}));
export function GroupTodos(props: Parameters<typeof GroupTodosBody>[0]) {
  return <ScopedGroupTodos key={props.groupId} {...props} />;
}
