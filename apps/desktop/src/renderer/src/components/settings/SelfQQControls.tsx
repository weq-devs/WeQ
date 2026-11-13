import { PersonStanding, RefreshCw, UserPen } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { trpc } from '../../trpc/client';
import { useQQAutoRefresh } from '../../hooks/useQQAutoRefresh';
import { useQQWriteSession } from '../../hooks/useQQWriteSession';
import {
  DisplaySelfProfileField as SelfProfileField,
  ProfileDisplayEntry,
} from '../ProfileDisplaySettings';
import { contactBirth } from '../../lib/contactBirth';
import '../../styles/self-profile-editor.css';
import { QQWriteSelectRow, QQWriteTextRow } from '../QQWriteControls';
import { useEditableSelfProfileFields } from './EditableSelfProfile';
import { SelfProfileFieldsContext, type SelfProfileFields } from '../SelfProfileFields';

export function SelfProfileProvider({ children }: { children: ReactNode }) {
  const additional = useEditableSelfProfileFields();
  const session = useQQWriteSession('self-profile');
  const utils = trpc.useUtils();
  const identityKey = `${session.binding?.expectedAccountUin}:${session.binding?.expectedAccountConfigId}`;
  const [syncIdentity, setSyncIdentity] = useState<string | null>(null);
  const [syncRevision, setSyncRevision] = useState(0);
  const syncing = syncIdentity === identityKey;
  const autoRefresh = useQQAutoRefresh(Boolean(session.binding));
  const local = trpc.account.getSelfProfile.useQuery(undefined, {
    enabled: Boolean(session.binding),
    staleTime: 30_000,
  });
  const profile = trpc.account.qqWrite.selfState.useQuery(
    {
      expectedAccountUin: session.binding?.expectedAccountUin ?? '',
      expectedAccountConfigId: session.binding?.expectedAccountConfigId ?? '',
    },
    {
      ...autoRefresh,
      refetchInterval: autoRefresh.enabled && syncing ? 1000 : false,
    },
  );
  const ownProfile =
    profile.data?.profile && profile.data.profile.uin === session.binding?.expectedAccountUin
      ? profile.data.profile
      : local.data?.uin.toString() === session.binding?.expectedAccountUin
        ? local.data
        : null;
  const patch = trpc.account.qqWrite.selfProfile.useMutation();
  const confirmed = useRef(ownProfile);
  useEffect(() => {
    confirmed.current = ownProfile;
  }, [ownProfile]);
  const [error, setError] = useState('');
  const currentIdentity = useRef(identityKey);
  currentIdentity.current = identityKey;
  useEffect(() => {
    setError('');
    setSyncIdentity(null);
  }, [identityKey]);
  useEffect(() => {
    if (!syncing) return;
    const timer = setTimeout(() => setSyncIdentity(null), 15_000);
    return () => clearTimeout(timer);
  }, [syncing, syncRevision]);
  useEffect(() => {
    if (!syncing || currentIdentity.current !== identityKey) return;
    // QQ 落库可能晚于写回执；每次真实回读后同步标题栏缓存，不覆盖编辑草稿。
    void Promise.all([
      utils.account.getSelfProfile.invalidate(),
      utils.account.getOnlineStatus.invalidate(),
    ]).catch(() => {});
  }, [syncing, identityKey, profile.dataUpdatedAt, utils]);
  const disabled = !session.available || session.busy;
  async function refresh() {
    const updated = await profile.refetch();
    if (updated.error) throw updated.error;
  }
  const act = async (
    action: Parameters<typeof session.run>[0],
    field: string,
    matches?: (data: NonNullable<typeof profile.data>) => boolean,
  ) => {
    const ok = await session.run(action, refresh, {
      backgroundRefresh: true,
      requireReadback: Boolean(matches),
      readbackSuccessText: `${field}已保存`,
      readback: matches
        ? async () => {
            const result = await profile.refetch();
            if (result.error) throw result.error;
            return Boolean(result.data && matches(result.data));
          }
        : undefined,
    });
    if (ok && currentIdentity.current === identityKey) {
      setSyncIdentity(identityKey);
      setSyncRevision((value) => value + 1);
    }
    return ok;
  };
  type Patch = Parameters<typeof patch.mutateAsync>[0]['patch'];
  async function saveProfile(value: Patch, field: string) {
    const matches = (data: typeof ownProfile) =>
      Object.entries(value).every(
        ([key, next]) =>
          data?.[key === 'nickname' ? 'nick' : (key as keyof NonNullable<typeof data>)] === next,
      );
    if (matches(confirmed.current)) return true;
    return act(
      (binding) => patch.mutateAsync({ ...binding, patch: value }),
      field,
      (data) => {
        const ok = matches(data.profile);
        if (ok) confirmed.current = data.profile;
        return ok;
      },
    );
  }
  const feedback = (
    <>
      {additional.feedback}
      {profile.error && (
        <button
          type="button"
          className="weq-set-iconbtn"
          aria-label="重试读取 QQ 资料"
          title="重试读取"
          disabled={session.busy || profile.isFetching}
          onClick={() => {
            setError('');
            void refresh().catch((cause: unknown) =>
              setError(cause instanceof Error ? cause.message : String(cause)),
            );
          }}
        >
          <RefreshCw size={16} />
        </button>
      )}
      {error && <p role="alert">{error}</p>}
    </>
  );
  const fields: SelfProfileFields = {
    ...additional.fields,
    nickname: (
      <SelfProfileField
        label="QQ 昵称"
        value={ownProfile ? ownProfile.nick || '未设置' : null}
        disabled={disabled}
      >
        <QQWriteTextRow
          label="QQ 昵称"
          icon={<UserPen size={14} strokeWidth={1.8} />}
          allowEmpty={false}
          initial={ownProfile?.nick ?? null}
          maxLength={256}
          disabled={disabled}
          onSave={(nickname) => saveProfile({ nickname }, 'QQ 昵称')}
        />
      </SelfProfileField>
    ),
    gender: (
      <SelfProfileField
        label="性别"
        displayField="gender"
        value={ownProfile ? (['未设置', '男', '女'][ownProfile.gender] ?? '未设置') : null}
        disabled={disabled}
      >
        <QQWriteSelectRow
          label="性别"
          segmented
          icon={<PersonStanding size={14} strokeWidth={1.8} />}
          initial={ownProfile?.gender ?? null}
          disabled={disabled}
          options={[
            { value: 0, label: '未设置' },
            { value: 1, label: '男' },
            { value: 2, label: '女' },
          ]}
          onSave={(gender) =>
            gender === 0 || gender === 1 || gender === 2
              ? saveProfile({ gender }, '性别')
              : Promise.resolve(false)
          }
        />
      </SelfProfileField>
    ),
    signature: (
      <SelfProfileField
        label="个性签名"
        value={ownProfile ? ownProfile.signature || '未设置' : null}
        disabled
      >
        {null}
      </SelfProfileField>
    ),
    age: (
      <ProfileDisplayEntry field="age">
        {ownProfile?.age ? `${ownProfile.age} 岁` : '未设置'}
      </ProfileDisplayEntry>
    ),
    constellation: (
      <ProfileDisplayEntry field="constellation">
        {ownProfile ? contactBirth(ownProfile).constellation?.name || '未设置' : '尚未读取'}
      </ProfileDisplayEntry>
    ),
  };
  return (
    <SelfProfileFieldsContext.Provider
      key={identityKey}
      value={{
        fields,
        uin: session.binding?.expectedAccountUin ?? '',
        feedback,
      }}
    >
      {children}
    </SelfProfileFieldsContext.Provider>
  );
}
