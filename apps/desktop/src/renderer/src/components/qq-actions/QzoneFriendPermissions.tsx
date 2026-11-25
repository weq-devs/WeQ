import { ProfileChatShortcutContext } from '../../lib/chatNavigation';
import { activateProfile } from '../../lib/profileClick';
import { EmptyState } from '../EmptyState';
import { useContext, useLayoutEffect, useRef, useState } from 'react';
import { trpc } from '../../trpc/client';
import { QQWriteToggleRow } from '../QQWriteControls';
import { ActionFeedback, ActionIcon } from './shared';
import { useQQAction, withQQAccountScope } from './shared.shared';
import { Card, QueryError, Row } from '../settings/controls';
import { QqAvatar } from '../QqAvatar';
import { EditorDialog } from '../EditorDialog';
import { ProfileNavigationContext, profileTargetUser } from '../../lib/profileNavigation';
import { useTabActive } from '../RetainedTabs.shared';
import { useQQAutoRefresh } from '../../hooks/useQQAutoRefresh';
import { Plus, Search, ShieldBan, X, UsersRound } from 'lucide-react';
import '../../styles/qzone-permissions.css';

function PermissionProfile({ uin, name }: { uin: string; name: string }) {
  const active = useTabActive();
  const navigate = useContext(ProfileNavigationContext);
  const chatShortcut = useContext(ProfileChatShortcutContext);
  const providedName = name.trim() !== uin ? name.trim() : '';
  const profile = trpc.account.getProfileByUin.useQuery(
    { uin },
    {
      enabled: active && !providedName,
      staleTime: 60_000,
      refetchOnWindowFocus: false,
    },
  );
  const nickname = providedName || profile.data?.nick || '昵称未获取';
  return (
    <button
      type="button"
      className="weq-qzone-permission-profile"
      title={`${nickname}（${uin}）`}
      aria-label={`查看${nickname}的名片`}
      disabled={!navigate}
      onClick={(event) => {
        const user = profileTargetUser({ identity: profile.data?.uid || uin, uin, name: nickname });
        if (!user || !navigate) return;
        const anchor = { x: event.clientX, y: event.clientY, trigger: event.currentTarget };
        activateProfile(
          event,
          () => navigate(user, anchor),
          chatShortcut?.({ kind: 'direct', user }),
        );
      }}
    >
      <QqAvatar uin={uin} size={24} />
      <span>{nickname}</span>
    </button>
  );
}

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
  const [managing, setManaging] = useState(false);
  const [adding, setAdding] = useState(false);
  const addButton = useRef<HTMLButtonElement>(null);
  const restoreAddFocus = useRef(false);
  useLayoutEffect(() => {
    if (!adding && restoreAddFocus.current) {
      restoreAddFocus.current = false;
      addButton.current?.focus({ preventScroll: true });
    }
  }, [adding]);
  const lists = trpc.account.qqActions.qzoneFriendPermissionList.useQuery(
    { ...action.binding!, kind },
    useQQAutoRefresh(action.available),
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
      restoreAddFocus.current = true;
      setAdding(false);
    }
  };
  return (
    <>
      <Row
        settingId={`qzone-${kind}`}
        label={label}
        control={
          <>
            {!lists.error && lists.data && (
              <span className="weq-qzone-permissions-count">
                <span className="weq-number weq-number-inherit">{lists.data.length}</span> 人
              </span>
            )}
            <button
              type="button"
              className="weq-set-btn weq-set-btn-sm"
              aria-haspopup="dialog"
              aria-label={`管理名单：${label}`}
              onClick={() => setManaging(true)}
            >
              管理名单
            </button>
          </>
        }
      />
      {managing && (
        <EditorDialog
          title={label}
          onClose={() => {
            setManaging(false);
            setAdding(false);
          }}
          busy={action.pending || action.busy}
        >
          <div className="weq-qzone-permissions">
            <div className="weq-qzone-permissions-tools">
              <button
                ref={addButton}
                type="button"
                className="weq-set-btn weq-set-btn-sm"
                aria-expanded={adding}
                aria-label={adding ? '取消添加' : `添加到${label}`}
                disabled={!adding && disabled}
                onClick={() => setAdding(!adding)}
              >
                {adding ? '取消添加' : '添加'}
              </button>
            </div>
            {adding && (
              <PermissionAdder
                label={label}
                action={action}
                disabled={disabled}
                existing={existing}
                add={add}
              />
            )}
            {readError}
            {!lists.data && !lists.error && (
              <p role="status">{action.available ? '正在读取名单…' : '当前账号暂不可用'}</p>
            )}
            {lists.data?.length === 0 && !lists.error && (
              <EmptyState compact icon={<UsersRound />} title="暂无好友" />
            )}
            {lists.data && lists.data.length > 0 && (
              <ul className="weq-qzone-permission-users">
                {lists.data.map((row) => (
                  <li key={row.uin}>
                    <PermissionProfile uin={row.uin} name={row.name} />
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
            )}
            <ActionFeedback action={action} />
          </div>
        </EditorDialog>
      )}
    </>
  );
}

function PermissionAdder({
  label,
  action,
  disabled,
  existing,
  add,
}: {
  label: string;
  action: ReturnType<typeof useQQAction>;
  disabled: boolean;
  existing: Set<string>;
  add: (uin: string) => Promise<void>;
}) {
  const [keyword, setKeyword] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    input.current?.focus({ preventScroll: true });
  }, []);
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
          ref={input}
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
                <small>
                  <span className="weq-number weq-number-inherit">{row.uin}</span>
                </small>
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
  const action = useQQAction(`space-permissions:${targetUin ?? 'lists'}`, 'failure-only');
  const permissions = (
    <>
      <PermissionKind
        action={action}
        targetUin={targetUin}
        kind="blocked"
        label="不让 ta 看我的空间"
      />
      <PermissionKind action={action} targetUin={targetUin} kind="hidden" label="不看 ta 的空间" />
    </>
  );
  return targetUin ? (
    <>
      {permissions}
      <ActionFeedback action={action} />
    </>
  ) : (
    <Card title="好友权限" icon={<ShieldBan size={15} strokeWidth={1.8} />}>
      {permissions}
    </Card>
  );
}
export const QzoneFriendPermissions = withQQAccountScope(QzoneFriendPermissionsBody);
