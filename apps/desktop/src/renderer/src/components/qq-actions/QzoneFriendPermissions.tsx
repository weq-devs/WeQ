import { useState } from 'react';
import { trpc } from '../../trpc/client';
import { QQWriteToggleRow } from '../QQWriteControls';
import { ActionFeedback, ActionIcon, useQQAction, withQQAccountScope } from './shared';
import { QueryError } from '../settings/controls';
import { QqAvatar } from '../QqAvatar';
import { Plus, RefreshCw, Search, X } from 'lucide-react';
import '../../styles/qzone-permissions.css';

function PermissionKind({
  targetUin,
  kind,
  label,
  action,
}: {
  targetUin?: string;
  kind: 'blocked' | 'hidden';
  label: string;
  action: ReturnType<typeof useQQAction>;
}) {
  const [adding, setAdding] = useState(false);
  const lists = trpc.account.qqActions.qzoneFriendPermissionList.useQuery(
    { ...action.binding!, kind },
    {
      enabled: action.available,
      staleTime: 0,
      retry: false,
    },
  );
  const mutate = trpc.account.qqActions.qzoneFriendPermission.useMutation();
  const toggle = (target: string, enabled: boolean) =>
    action.perform(
      (binding) => mutate.mutateAsync({ ...binding, kind, targetUin: target, enabled }),
      undefined,
      !targetUin && !enabled ? `将 QQ ${target} 从「${label}」名单中移除？` : undefined,
      {
        requireReadback: true,
        readbackSuccessText: '空间权限已更新',
        readback: async () => {
          const result = await lists.refetch();
          if (result.error) throw result.error;
          return (
            Array.isArray(result.data) && result.data.some((row) => row.uin === target) === enabled
          );
        },
      },
    );
  const readError = lists.error ? (
    <QueryError
      message={`${label}：${lists.error.message}`}
      retryLabel={`重新读取${label}`}
      retrying={lists.isFetching}
      onRetry={() => void lists.refetch()}
    />
  ) : null;
  if (targetUin)
    return (
      <>
        {readError}
        <QQWriteToggleRow
          key={kind}
          label={label}
          disabled={action.disabled || !Array.isArray(lists.data) || Boolean(lists.error)}
          initial={
            !lists.error && lists.data ? lists.data.some((row) => row.uin === targetUin) : null
          }
          onSave={(enabled) => toggle(targetUin, enabled)}
        />
      </>
    );
  const disabled = action.disabled || !Array.isArray(lists.data) || Boolean(lists.error);
  const existing = new Set(lists.data?.map((row) => row.uin));
  const allowed = (uin: string) =>
    /^[1-9]\d{4,11}$/.test(uin) && uin !== action.binding?.expectedAccountUin && !existing.has(uin);
  const add = async (uin: string) => {
    if (disabled || !allowed(uin)) return;
    if (await toggle(uin, true)) {
      setAdding(false);
    }
  };
  return (
    <section className="weq-qzone-permissions" aria-label={label}>
      <header>
        <h4>{label}</h4>
        {!lists.error && lists.data && (
          <span className="weq-qzone-permissions-count">{lists.data.length} 人</span>
        )}
        <div className="weq-qzone-permissions-tools">
          <ActionIcon
            label={`刷新${label}`}
            disabled={!action.available || action.pending || lists.isFetching}
            onClick={() => void lists.refetch()}
          >
            <RefreshCw size={15} />
          </ActionIcon>
          <ActionIcon
            label={`添加到${label}`}
            disabled={disabled || adding}
            onClick={() => setAdding(true)}
          >
            <Plus size={16} />
          </ActionIcon>
        </div>
      </header>
      {readError}
      {!lists.data && !lists.error && (
        <p role="status">{action.available ? '正在读取名单…' : '当前账号暂不可用'}</p>
      )}
      {lists.data?.length === 0 && !lists.error && <p>暂无好友</p>}
      <ul className="weq-qzone-permission-users">
        {lists.data?.map((row) => (
          <li key={row.uin}>
            <QqAvatar uin={row.uin} size={24} />
            <span title={`${row.name || row.uin}（${row.uin}）`}>{row.name || row.uin}</span>
            <ActionIcon
              label={`从${label}移除 ${row.name || row.uin}（${row.uin}）`}
              disabled={disabled}
              onClick={() => void toggle(row.uin, false)}
            >
              <X size={13} />
            </ActionIcon>
          </li>
        ))}
      </ul>
      {adding && (
        <PermissionAdder
          label={label}
          action={action}
          disabled={disabled}
          existing={existing}
          add={add}
          onClose={() => setAdding(false)}
        />
      )}
    </section>
  );
}

function PermissionAdder({
  label,
  action,
  disabled,
  existing,
  add,
  onClose,
}: {
  label: string;
  action: ReturnType<typeof useQQAction>;
  disabled: boolean;
  existing: Set<string>;
  add: (uin: string) => Promise<void>;
  onClose: () => void;
}) {
  const [keyword, setKeyword] = useState('');
  const needle = keyword.trim();
  const candidates = trpc.account.searchQuick.useQuery(
    { keyword: needle, limit: 20 },
    { enabled: action.available && Boolean(needle), staleTime: 30_000, retry: false },
  );
  const allowed = (uin: string) =>
    /^[1-9]\d{4,11}$/.test(uin) && uin !== action.binding?.expectedAccountUin && !existing.has(uin);
  const friends = (!needle || candidates.error ? [] : (candidates.data?.friends ?? [])).filter(
    (row) => allowed(row.uin),
  );
  const canAddNumber = allowed(needle);
  const manual = canAddNumber && !friends.some((row) => row.uin === needle);
  return (
    <div className="weq-qzone-permission-add">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (canAddNumber) void add(needle);
        }}
      >
        <Search size={15} aria-hidden />
        <input
          autoFocus
          aria-label={`搜索好友或输入 QQ 号：${label}`}
          placeholder="搜索好友或输入 QQ 号"
          value={keyword}
          disabled={action.disabled}
          onChange={(event) => setKeyword(event.target.value)}
        />
        <button
          type="submit"
          className="weq-set-iconbtn"
          title="添加此 QQ 号"
          aria-label="添加此 QQ 号"
          disabled={disabled || !canAddNumber}
        >
          <Plus size={16} />
        </button>
        <ActionIcon label={`取消添加到${label}`} disabled={action.pending} onClick={onClose}>
          <X size={16} />
        </ActionIcon>
      </form>
      {needle && candidates.isFetching && <p role="status">正在搜索…</p>}
      {needle && candidates.error && (
        <QueryError
          message={`好友搜索失败：${candidates.error.message}`}
          retryLabel="重试好友搜索"
          retrying={candidates.isFetching}
          onRetry={() => void candidates.refetch()}
        />
      )}
      <ul className="weq-qzone-permission-candidates">
        {friends.map((row) => (
          <li key={row.uin}>
            <button
              type="button"
              disabled={disabled}
              title={`添加 ${row.remark || row.nick || row.uin}`}
              onClick={() => void add(row.uin)}
            >
              <QqAvatar uin={row.uin} size={24} />
              <span>
                {row.remark || row.nick || row.uin}
                <small>{row.uin}</small>
              </span>
              <Plus size={15} />
            </button>
          </li>
        ))}
        {manual && (
          <li>
            <button type="button" disabled={disabled} onClick={() => void add(needle)}>
              <QqAvatar uin={needle} size={24} />
              <span>{needle}</span>
              <Plus size={15} />
            </button>
          </li>
        )}
      </ul>
      {needle && !candidates.isFetching && !candidates.error && !friends.length && !manual && (
        <p>
          {existing.has(needle)
            ? '已在名单中'
            : needle === action.binding?.expectedAccountUin
              ? '不能添加自己'
              : '没有可添加的好友'}
        </p>
      )}
    </div>
  );
}
function QzoneFriendPermissionsBody({ targetUin }: { targetUin?: string }) {
  const action = useQQAction(`space-permissions:${targetUin ?? 'lists'}`);
  return (
    <>
      <PermissionKind
        action={action}
        targetUin={targetUin}
        kind="blocked"
        label="不让 ta 看我的空间"
      />
      <PermissionKind action={action} targetUin={targetUin} kind="hidden" label="不看 ta 的空间" />
      <ActionFeedback action={action} />
    </>
  );
}
export const QzoneFriendPermissions = withQQAccountScope(QzoneFriendPermissionsBody);
