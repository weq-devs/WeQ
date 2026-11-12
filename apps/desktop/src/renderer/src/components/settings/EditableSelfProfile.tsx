import { useEffect, useRef, useState } from 'react';
import {
  Save,
  MapPin,
  Cake,
  Mail,
  GraduationCap,
  BriefcaseBusiness,
  RefreshCw,
  FileText,
} from 'lucide-react';
import { trpc } from '../../trpc/client';
import { useQQWriteSession } from '../../hooks/useQQWriteSession';
import { QQWriteTextRow, QQWriteSelectRow } from '../QQWriteControls';
import { Row } from './controls';
import { withQQAccountScope } from '../qq-actions/shared';
import { useSelfProfileSave } from '../SelfProfileField';
import { DisplaySelfProfileField as SelfProfileField } from '../ProfileDisplaySettings';

interface Region {
  code: string;
  name: string;
  children: Region[];
}
export function RegionEditor({
  label,
  value,
  layers,
  regions,
  disabled,
  onSave,
}: {
  label: string;
  value: string[] | null;
  layers: 3 | 4;
  regions: Region[];
  disabled: boolean;
  onSave: (value: string[]) => Promise<boolean>;
}) {
  const saveField = useSelfProfileSave();
  const [path, setPath] = useState<Array<string | null>>(
    value ?? Array.from({ length: layers }, () => null),
  );
  const previous = useRef(JSON.stringify(value ?? Array.from({ length: layers }, () => null)));
  const incoming = JSON.stringify(value ?? Array.from({ length: layers }, () => null));
  useEffect(() => {
    const before = previous.current;
    setPath((current) =>
      JSON.stringify(current) === before ? (JSON.parse(incoming) as Array<string | null>) : current,
    );
    previous.current = incoming;
  }, [incoming]);
  const menus: Region[][] = [];
  let siblings = regions;
  for (let i = 0; i < layers; i++) {
    menus.push(siblings);
    siblings = siblings.find((node) => node.code === path[i])?.children ?? [];
  }
  const valid =
    path.length === layers &&
    path.every(
      (value, index) => value !== null && menus[index]?.some((node) => node.code === value),
    );
  return (
    <Row
      label={
        <span className="weq-set-row-icon">
          <MapPin size={14} />
          {label}
        </span>
      }
      control={
        <div className="weq-profile-region-editor">
          {menus.map((nodes, index) => (
            <select
              key={['country', 'province', 'city', 'district'][index]}
              aria-label={`${label}${['国家', '省', '市', '区县'][index]}`}
              disabled={disabled || !nodes.length || (nodes.length === 1 && nodes[0]?.code === '0')}
              value={path[index] ?? '__unset'}
              onChange={(event) => {
                const next = path.slice(0, index);
                next.push(event.target.value);
                let children =
                  nodes.find((node) => node.code === event.target.value)?.children ?? [];
                for (let depth = index + 1; depth < layers; depth++) {
                  const single = children.length === 1 ? children[0] : undefined;
                  const selected = children.find((node) => node.code === '0') ?? single;
                  next.push(selected?.code ?? null);
                  children = selected?.children ?? [];
                }
                setPath(next);
              }}
            >
              <option value="__unset" disabled>
                {['国家', '省', '市', '区县'][index]}
              </option>
              {nodes.map((node) => (
                <option key={node.code} value={node.code}>
                  {node.name || '未指定'}
                </option>
              ))}
            </select>
          ))}
          <button
            type="button"
            className="weq-set-iconbtn"
            title={`保存${label}`}
            aria-label={`保存${label}`}
            disabled={disabled || !valid}
            onClick={() => {
              if (valid) void saveField(() => onSave(path as string[]));
            }}
          >
            <Save size={16} />
          </button>
        </div>
      }
    />
  );
}
function EditableSelfProfileBody() {
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
  type Patch = Parameters<typeof mutation.mutateAsync>[0]['patch'];
  const save = (patch: Patch) =>
    a.run((binding) => mutation.mutateAsync({ ...binding, patch }), undefined, {
      requireReadback: true,
      readbackSuccessText: '资料已保存',
      readback: async () => {
        const result = await profile.refetch();
        if (result.error) throw result.error;
        return Object.entries(patch).every(
          ([key, value]) =>
            JSON.stringify(result.data?.[key as keyof NonNullable<typeof result.data>]) ===
            JSON.stringify(value),
        );
      },
    });
  const disabled = !a.available || a.busy || !profile.data || Boolean(profile.error);
  const errors = profile.data?.errors ?? {};
  const cached = local.data?.uin.toString() === a.binding?.expectedAccountUin ? local.data : null;
  const regionText = (path: string[] | null | undefined) => {
    if (!path) return null;
    let nodes = directory.data?.regions ?? [];
    return (
      path
        .map((code) => {
          const node = nodes.find((node) => node.code === code);
          nodes = node?.children ?? [];
          return node?.name ?? (code === '0' ? '' : code);
        })
        .filter(Boolean)
        .join(' · ') || '未设置'
    );
  };
  return (
    <div className="weq-self-profile-additional">
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
      <SelfProfileField
        label="当前地区"
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
          label="当前地区"
          value={profile.data?.region ?? null}
          layers={3}
          regions={directory.data?.regions ?? []}
          disabled={disabled || Boolean(errors.region)}
          onSave={(region) => save({ region })}
        />
      </SelfProfileField>
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
      <SelfProfileField
        label="学校"
        displayField="education"
        value={
          profile.data?.school ||
          cached?.extInfo?.school ||
          (errors.school || profile.error ? '读取失败' : profile.data ? '未设置' : null)
        }
        disabled={disabled || Boolean(errors.school)}
      >
        <QQWriteTextRow
          label="学校"
          icon={<GraduationCap size={14} />}
          initial={profile.data?.school ?? null}
          disabled={disabled || Boolean(errors.school)}
          maxLength={996}
          onSave={(school) => save({ school })}
        />
      </SelfProfileField>
    </div>
  );
}
function BirthdayEditor({
  initial,
  disabled,
  onSave,
}: {
  initial: string;
  disabled: boolean;
  onSave: (value: string) => Promise<boolean>;
}) {
  const [value, setValue] = useState(initial);
  const saveField = useSelfProfileSave();
  return (
    <Row
      label={
        <span className="weq-set-row-icon">
          <Cake size={14} />
          生日
        </span>
      }
      control={
        <div className="weq-profile-region-editor">
          <input
            type="date"
            aria-label="公历生日"
            value={value}
            disabled={disabled}
            onChange={(event) => setValue(event.target.value)}
          />
          <button
            type="button"
            title="保存生日"
            aria-label="保存生日"
            disabled={disabled || !value}
            onClick={() => void saveField(() => onSave(value))}
          >
            <Save size={16} />
          </button>
        </div>
      }
    />
  );
}
export const EditableSelfProfile = withQQAccountScope(EditableSelfProfileBody);
