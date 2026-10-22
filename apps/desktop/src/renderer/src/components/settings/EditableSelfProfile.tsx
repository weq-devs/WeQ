import { useEffect, useState } from 'react';
import {
  Save,
  MapPin,
  Cake,
  Mail,
  GraduationCap,
  BriefcaseBusiness,
  RefreshCw,
} from 'lucide-react';
import { trpc } from '../../trpc/client';
import { useQQWriteSession } from '../../hooks/useQQWriteSession';
import { QQWriteTextRow, QQWriteSelectRow } from '../QQWriteControls';
import { Row } from './controls';
import { withQQAccountScope } from '../qq-actions/shared';

interface Region {
  code: string;
  name: string;
  children: Region[];
}
function RegionEditor({
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
  const [path, setPath] = useState<Array<string | null>>(
    value ?? Array.from({ length: layers }, () => null),
  );
  useEffect(() => {
    setPath(value ?? Array.from({ length: layers }, () => null));
  }, [value, layers]);
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
              disabled={disabled || !nodes.length}
              value={path[index] ?? '__unset'}
              onChange={(event) => {
                const next = path.slice(0, index);
                next.push(event.target.value);
                let children =
                  nodes.find((node) => node.code === event.target.value)?.children ?? [];
                for (let depth = index + 1; depth < layers; depth++) {
                  const single = children.length === 1 ? children[0] : undefined;
                  next.push(single?.code ?? null);
                  children = single?.children ?? [];
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
              if (valid) void onSave(path as string[]);
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
  const mutation = trpc.account.qqWrite.editSelfProfile.useMutation();
  const [birthday, setBirthday] = useState('');
  useEffect(() => {
    setBirthday(profile.data?.birthday ?? '');
  }, [profile.data?.birthday]);
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
              value={birthday}
              disabled={disabled || Boolean(errors.birthday)}
              onChange={(event) => setBirthday(event.target.value)}
            />
            <button
              type="button"
              className="weq-set-iconbtn"
              title="保存生日"
              aria-label="保存生日"
              disabled={disabled || Boolean(errors.birthday) || !birthday}
              onClick={() => void save({ birthday })}
            >
              <Save size={16} />
            </button>
          </div>
        }
      />
      <RegionEditor
        label="当前地区"
        value={profile.data?.region ?? null}
        layers={3}
        regions={directory.data?.regions ?? []}
        disabled={disabled || Boolean(errors.region)}
        onSave={(region) => save({ region })}
      />
      <QQWriteTextRow
        label="邮箱"
        icon={<Mail size={14} />}
        initial={profile.data?.email ?? null}
        disabled={disabled || Boolean(errors.email)}
        maxLength={996}
        onSave={(email) => save({ email })}
      />
      <QQWriteSelectRow
        label="职业"
        autoSave
        icon={<BriefcaseBusiness size={14} />}
        initial={profile.data?.profession ?? null}
        disabled={disabled || Boolean(errors.profession)}
        options={directory.data?.professions ?? []}
        onSave={(profession) => save({ profession })}
      />
      <RegionEditor
        label="家乡"
        value={profile.data?.hometown ?? null}
        layers={4}
        regions={directory.data?.regions ?? []}
        disabled={disabled || Boolean(errors.hometown)}
        onSave={(hometown) => save({ hometown })}
      />
      <QQWriteTextRow
        label="学校"
        icon={<GraduationCap size={14} />}
        initial={profile.data?.school ?? null}
        disabled={disabled || Boolean(errors.school)}
        maxLength={996}
        onSave={(school) => save({ school })}
      />
    </div>
  );
}
export const EditableSelfProfile = withQQAccountScope(EditableSelfProfileBody);
