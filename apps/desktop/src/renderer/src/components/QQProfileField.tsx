import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { trpc } from '../trpc/client';
import { useQQWriteSession } from '../hooks/useQQWriteSession';
import { ProfileInlineField } from './ProfileInlineField';
import { ContactInlineError, ContactRow } from './contactProfile/ContactRow';
import { QQWriteResult } from './QQWriteControls';

type Field = 'friendRemark' | 'groupRemark' | 'groupName' | 'friendCategory';
type Props = {
  field: Field;
  target: string;
  initial: string;
  label?: string;
  nameTarget?: string;
  valueClassName?: string;
  inline?: boolean;
};

/** 先显示名片已有值，点击后才挂载在线读取和编辑器。 */
export function QQProfileField(props: Props) {
  const { field, target, initial, valueClassName, inline = false } = props;
  const label =
    props.label ??
    (field === 'groupName' ? '群名称' : field === 'friendCategory' ? '好友分组' : '备注');
  const session = useQQWriteSession(`profile-field:${field}:${target}`, true);
  const scope = `${session.binding?.expectedAccountUin}:${session.binding?.expectedAccountConfigId}:${field}:${target}`;
  const [editing, setEditing] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ scope: string; value: string; previous: string } | null>(
    null,
  );
  const value = saved?.scope === scope && saved.previous === initial ? saved.value : initial;
  if (editing === scope)
    return (
      <QQProfileFieldEditor
        key={scope}
        {...props}
        label={label}
        onClose={() => setEditing(null)}
        onSaved={(next) => {
          setSaved({ scope, value: next, previous: initial });
          setEditing(null);
        }}
      />
    );
  const trigger = (
    <button
      type="button"
      className="weq-contact-value"
      aria-label={`编辑${label}`}
      title={`编辑${label}`}
      disabled={!session.available}
      onClick={(event) => {
        const selection = event.currentTarget.ownerDocument.getSelection();
        if (!selection?.toString() || !event.currentTarget.contains(selection.anchorNode))
          setEditing(scope);
      }}
    >
      {value ||
        (field === 'friendCategory'
          ? '设置好友分组'
          : field === 'groupName'
            ? '设置群名称'
            : '添加备注')}
    </button>
  );
  return inline ? (
    trigger
  ) : (
    <ContactRow label={label} valueClassName={valueClassName}>
      {trigger}
    </ContactRow>
  );
}

function QQProfileFieldEditor({
  field,
  target,
  label,
  nameTarget,
  inline = false,
  onClose,
  onSaved,
}: Props & {
  label: string;
  onClose: () => void;
  onSaved: (value: string) => void;
}) {
  const session = useQQWriteSession(`profile-edit:${field}:${target}`);
  const cache = useQueryClient();
  const utils = trpc.useUtils();
  const group = field === 'groupRemark' || field === 'groupName';
  const input = {
    expectedAccountUin: session.binding?.expectedAccountUin ?? '',
    expectedAccountConfigId: session.binding?.expectedAccountConfigId ?? '',
  };
  const options = {
    enabled: session.available,
    staleTime: 0,
    refetchOnWindowFocus: false,
    retry: false,
  } as const;
  const peer = trpc.account.qqWrite.peerState.useQuery(
    {
      ...input,
      target: group ? { kind: 'group', groupId: Number(target) } : { kind: 'c2c', uid: target },
    },
    options,
  );
  const remark = trpc.account.qqWrite.friendRemarkState.useQuery(
    { ...input, uid: target },
    { ...options, enabled: session.available && field === 'friendRemark' },
  );
  const roster = trpc.account.qqWrite.friendRoster.useQuery(input, {
    ...options,
    enabled: session.available && field === 'friendCategory',
  });
  const friendRemark = trpc.account.qqWrite.friendRemark.useMutation();
  const groupRemark = trpc.account.qqWrite.groupRemark.useMutation();
  const groupName = trpc.account.qqWrite.groupName.useMutation();
  const category = trpc.account.qqWrite.friendCategory.useMutation();
  const error =
    peer.error ??
    (field === 'friendRemark' ? remark.error : field === 'friendCategory' ? roster.error : null);
  const categories = roster.data?.categories;
  const categoryOptions = categories
    ? [{ id: 0, name: '默认分组' }, ...categories.filter((row) => row.id !== 0)]
    : undefined;
  const categoryId =
    roster.data?.friends.find((row) => row.uid === target)?.categoryId ?? peer.data?.categoryId;
  const ready = Boolean(
    peer.data &&
      (field !== 'friendRemark' || remark.data) &&
      (field !== 'friendCategory' || (categoryOptions && categoryId != null)),
  );
  const allowed = group
    ? field !== 'groupName' || peer.data?.role === 'owner' || peer.data?.role === 'admin'
    : Boolean(peer.data?.friend);
  const initial =
    field === 'friendRemark'
      ? (remark.data?.remark ?? '')
      : field === 'groupName'
        ? (peer.data?.groupName ?? '')
        : field === 'friendCategory'
          ? String(categoryId ?? '')
          : (peer.data?.remark ?? '');
  const retry = async () => {
    await Promise.all([
      peer.refetch(),
      field === 'friendRemark'
        ? remark.refetch()
        : field === 'friendCategory'
          ? roster.refetch()
          : undefined,
    ]);
  };
  return (
    <div data-qq-action className={inline ? 'weq-profile-field-inline' : undefined}>
      {ready && allowed ? (
        <ProfileInlineField
          label={label}
          initial={initial}
          initialEditing
          editable
          disabled={!session.available || session.busy || Boolean(error)}
          maxLength={field === 'groupName' ? 256 : 1024}
          allowEmpty={field !== 'groupName' && field !== 'friendCategory'}
          options={
            field === 'friendCategory'
              ? categoryOptions?.map((row) => ({ value: String(row.id), label: row.name }))
              : undefined
          }
          onCancel={onClose}
          onSave={async (value) => {
            const ok = await session.run(
              (binding) => {
                if (field === 'friendRemark')
                  return friendRemark.mutateAsync({ ...binding, uid: target, remark: value });
                if (field === 'groupRemark')
                  return groupRemark.mutateAsync({
                    ...binding,
                    groupId: Number(target),
                    remark: value,
                  });
                if (field === 'groupName')
                  return groupName.mutateAsync({
                    ...binding,
                    groupId: Number(target),
                    name: value,
                  });
                return category.mutateAsync({ ...binding, uid: target, categoryId: Number(value) });
              },
              undefined,
              {
                profileUid: group ? undefined : target,
                requireReadback: true,
                readbackSuccessText: value ? `${label}已保存` : `${label}已清空`,
                readback: async () => {
                  if (field === 'friendRemark') {
                    const updated = await remark.refetch();
                    if (updated.error) throw updated.error;
                    return updated.data?.remark === value;
                  }
                  if (field === 'friendCategory') {
                    const updated = await roster.refetch();
                    if (updated.error) throw updated.error;
                    return (
                      updated.data?.friends.some(
                        (row) => row.uid === target && row.categoryId === Number(value),
                      ) ?? false
                    );
                  }
                  const updated = await peer.refetch();
                  if (updated.error) throw updated.error;
                  return (
                    (field === 'groupName' ? updated.data?.groupName : updated.data?.remark) ===
                    value
                  );
                },
              },
            );
            if (ok) {
              onSaved(
                field === 'friendCategory'
                  ? (categoryOptions?.find((row) => row.id === Number(value))?.name ?? value)
                  : value,
              );
              // 名片的云端名称和群详情使用独立 Query key，写入后也要刷新。
              void cache.invalidateQueries({
                queryKey: [
                  'contact-cloud-name',
                  session.binding,
                  group ? 'group' : 'user',
                  nameTarget ?? target,
                ],
              });
              if (group) {
                void cache.invalidateQueries({ queryKey: ['group-profile'] });
                void cache.invalidateQueries({ queryKey: ['group-profile-name'] });
              }
              if (field === 'friendCategory') void utils.account.listCategories.invalidate();
            }
            return ok;
          }}
        />
      ) : (
        <>
          {!error ? (
            <p className="weq-qq-write-result" role="status">
              {!session.available
                ? 'QQ 在线能力未就绪'
                : ready && !allowed
                  ? `当前不能修改${label}`
                  : `正在读取${label}…`}
            </p>
          ) : null}
          <button type="button" className="weq-contact-value" onClick={onClose}>
            取消编辑{label}
          </button>
        </>
      )}
      {error ? (
        <ContactInlineError
          message={error.message}
          onRetry={() => void retry()}
          retrying={peer.isFetching || remark.isFetching || roster.isFetching}
        />
      ) : null}
      <QQWriteResult result={session.result} />
    </div>
  );
}
