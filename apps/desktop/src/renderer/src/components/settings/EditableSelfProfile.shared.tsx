import { useEffect, useRef } from 'react';
import { formatQqRegion } from '@weq/protocol/profile-regions';
import { Mail, BriefcaseBusiness, RefreshCw, FileText } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { useQQWriteSession } from '../../hooks/useQQWriteSession';
import { QQWriteTextRow, QQWriteSelectRow } from '../QQWriteControls';
import { DisplaySelfProfileField as SelfProfileField } from '../ProfileDisplaySettings';
import type { SelfProfileFields } from '../SelfProfileFields';
import { BirthdayEditor, RegionEditor } from './EditableSelfProfileEditors';

export function useEditableSelfProfileFields() {
  const a = useQQWriteSession('editable-self-profile');
  const profile = trpc.account.qqWrite.editableSelfProfile.useQuery(a.binding!, {
    enabled: a.available,
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const directory = trpc.account.qqWrite.profileRegions.useQuery(undefined, {
    staleTime: Infinity,
  });
  const local = trpc.account.getSelfProfile.useQuery(undefined, { staleTime: 30_000 });
  const mutation = trpc.account.qqWrite.editSelfProfile.useMutation();
  const confirmed = useRef(profile.data);
  useEffect(() => {
    confirmed.current = profile.data;
  }, [profile.data]);
  type Patch = Parameters<typeof mutation.mutateAsync>[0]['patch'];
  const save = (patch: Patch) => {
    const matches = (data: typeof profile.data) =>
      Object.entries(patch).every(
        ([key, value]) =>
          JSON.stringify(data?.[key as keyof NonNullable<typeof data>]) === JSON.stringify(value),
      );
    if (matches(confirmed.current)) return Promise.resolve(true);
    return a.run((binding) => mutation.mutateAsync({ ...binding, patch }), undefined, {
      requireReadback: true,
      readbackSuccessText: '资料已保存',
      readback: async () => {
        const result = await profile.refetch();
        if (result.error) throw result.error;
        const ok = matches(result.data);
        if (ok) confirmed.current = result.data;
        return ok;
      },
    });
  };
  const disabled = !a.available || a.busy || !profile.data || Boolean(profile.error);
  const errors = profile.data?.errors ?? {};
  const cached = local.data?.uin.toString() === a.binding?.expectedAccountUin ? local.data : null;
  const regionText = (path: string[] | null | undefined) =>
    formatQqRegion(path, directory.data?.regions);
  const feedback = (
    <>
      {Object.entries(errors).map(([field, message]) => (
        <p role="alert" key={field}>
          {message}
          <button
            type="button"
            className="weq-set-iconbtn"
            aria-label="重新读取资料"
            title="重新读取资料"
            disabled={profile.isFetching || a.busy}
            onClick={() => void profile.refetch()}
          >
            <RefreshCw size={16} />
          </button>
        </p>
      ))}
      {profile.error && (
        <p role="alert">
          {profile.error.message}
          <button
            type="button"
            className="weq-set-iconbtn"
            aria-label="重新读取资料"
            title="重新读取资料"
            onClick={() => void profile.refetch()}
          >
            <RefreshCw size={16} />
          </button>
        </p>
      )}
    </>
  );
  const fields: SelfProfileFields = {
    birthday: (
      <SelfProfileField
        label="生日"
        displayField="birthday"
        value={
          profile.data?.birthday ||
          (cached?.birthMonth
            ? `${cached.birthYear || ''}-${cached.birthMonth}-${cached.birthDay}`
            : errors.birthday || profile.error
              ? '读取失败'
              : profile.data
                ? '未设置'
                : null)
        }
        disabled={disabled || Boolean(errors.birthday)}
      >
        <BirthdayEditor
          initial={profile.data?.birthday ?? ''}
          disabled={disabled || Boolean(errors.birthday)}
          onSave={(birthday) => save({ birthday })}
        />
      </SelfProfileField>
    ),
    region: (
      <SelfProfileField
        label="所在地"
        displayField="region"
        value={
          regionText(profile.data?.region) ??
          (cached?.extInfo
            ? [cached.extInfo.country, cached.extInfo.province, cached.extInfo.city]
                .filter(Boolean)
                .join(' · ') || null
            : null) ??
          (errors.region || profile.error ? '读取失败' : profile.data ? '未设置' : null)
        }
        disabled={disabled || Boolean(errors.region)}
      >
        <RegionEditor
          label="所在地"
          value={profile.data?.region ?? null}
          layers={3}
          regions={directory.data?.regions ?? []}
          disabled={disabled || Boolean(errors.region)}
          onSave={(region) => save({ region })}
        />
      </SelfProfileField>
    ),
    email: (
      <SelfProfileField
        label="邮箱"
        displayField="email"
        value={
          errors.email || profile.error
            ? '读取失败'
            : profile.data
              ? profile.data.email || '未设置'
              : null
        }
        disabled={disabled || Boolean(errors.email)}
      >
        <QQWriteTextRow
          label="邮箱"
          icon={<Mail size={14} />}
          initial={profile.data?.email ?? null}
          disabled={disabled || Boolean(errors.email)}
          maxLength={996}
          onSave={(email) => save({ email })}
        />
      </SelfProfileField>
    ),
    profession: (
      <SelfProfileField
        label="职业"
        displayField="profession"
        value={
          errors.profession || profile.error
            ? '读取失败'
            : profile.data
              ? (directory.data?.professions.find((item) => item.value === profile.data.profession)
                  ?.label ??
                (profile.data.profession === null ? '未设置' : String(profile.data.profession)))
              : null
        }
        disabled={disabled || Boolean(errors.profession)}
      >
        <QQWriteSelectRow
          label="职业"
          icon={<BriefcaseBusiness size={14} />}
          initial={profile.data?.profession ?? null}
          disabled={disabled || Boolean(errors.profession)}
          options={directory.data?.professions ?? []}
          onSave={(profession) => save({ profession })}
        />
      </SelfProfileField>
    ),
    hometown: (
      <SelfProfileField
        label="家乡"
        displayField="hometown"
        value={
          regionText(profile.data?.hometown) ??
          (errors.hometown || profile.error ? '读取失败' : profile.data ? '未设置' : null)
        }
        disabled={disabled || Boolean(errors.hometown)}
      >
        <RegionEditor
          label="家乡"
          value={profile.data?.hometown ?? null}
          layers={4}
          regions={directory.data?.regions ?? []}
          disabled={disabled || Boolean(errors.hometown)}
          onSave={(hometown) => save({ hometown })}
        />
      </SelfProfileField>
    ),
    company: (
      <SelfProfileField
        label="公司"
        displayField="company"
        value={
          errors.company || profile.error
            ? '读取失败'
            : profile.data
              ? profile.data.company || '未设置'
              : null
        }
        disabled={disabled || Boolean(errors.company)}
      >
        <QQWriteTextRow
          label="公司"
          icon={<BriefcaseBusiness size={14} />}
          initial={profile.data?.company ?? null}
          disabled={disabled || Boolean(errors.company)}
          maxLength={996}
          onSave={(company) => save({ company })}
        />
      </SelfProfileField>
    ),
    personalNote: (
      <SelfProfileField
        label="个人说明"
        displayField="personalNote"
        value={
          errors.personalDescription || profile.error
            ? '读取失败'
            : profile.data
              ? profile.data.personalDescription || '未设置'
              : null
        }
        disabled={disabled || Boolean(errors.personalDescription)}
      >
        <QQWriteTextRow
          label="个人说明"
          icon={<FileText size={14} />}
          initial={profile.data?.personalDescription ?? null}
          disabled={disabled || Boolean(errors.personalDescription)}
          maxLength={383}
          multiline
          onSave={(personalDescription) => save({ personalDescription })}
        />
      </SelfProfileField>
    ),
  };
  return { fields, feedback };
}
