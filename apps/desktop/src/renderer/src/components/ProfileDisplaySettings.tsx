import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react';
import { Check, Loader2, RotateCcw, SlidersHorizontal } from 'lucide-react';
import {
  PROFILE_DISPLAY_FIELDS,
  type ProfileDisplayField,
  type ProfileDisplaySetting,
} from '@weq/protocol/profile-display';
import { trpc } from '../trpc/client';
import { useQQWriteSession } from '../hooks/useQQWriteSession';
import { SegmentedControl } from './SegmentedControl';
import { SelfProfileField } from './SelfProfileField';
import '../styles/profile-display-settings.css';

interface FieldState {
  setting?: ProfileDisplaySetting;
  pending?: boolean;
  error?: string;
  saved?: boolean;
}
interface DisplayContext {
  enabled: boolean;
  available: boolean;
  loading: boolean;
  error: string | null;
  fields: Partial<Record<ProfileDisplayField, FieldState>>;
  enable: (enabled: boolean) => void;
  save: (field: ProfileDisplayField, value: number) => void;
  refresh: () => void;
}
const Context = createContext<DisplayContext | null>(null);
export const useProfileDisplayMode = () => useContext(Context)?.enabled ?? false;

export function SelfProfileDisplayProvider({
  uin,
  children,
}: {
  uin: string;
  children: ReactNode;
}) {
  const session = useQQWriteSession(`profile-display:${uin}`);
  const key = `${uin}:${session.binding?.expectedAccountUin}:${session.binding?.expectedAccountConfigId}`;
  return (
    <Controller key={key} uin={uin} session={session}>
      {children}
    </Controller>
  );
}
function Controller({
  uin,
  session,
  children,
}: {
  uin: string;
  session: ReturnType<typeof useQQWriteSession>;
  children: ReactNode;
}) {
  const [enabled, enable] = useState(false);
  const [overrides, setOverrides] = useState<DisplayContext['fields']>({});
  const pending = useRef(new Set<ProfileDisplayField>());
  const versions = useRef(new Map<ProfileDisplayField, number>());
  const identity = `${session.binding?.expectedAccountUin}:${session.binding?.expectedAccountConfigId}`;
  const latest = useRef(identity);
  latest.current = identity;
  const mounted = useRef(true);
  // 清理与 key 重建覆盖账号、联系人和关闭页面三种来源变化。
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const available = session.available && session.binding?.expectedAccountUin === uin;
  const query = trpc.account.qqWrite.selfProfileDisplaySettings.useQuery(session.binding!, {
    enabled: enabled && available,
    retry: false,
    staleTime: Infinity,
    cacheTime: 0,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
  });
  const mutation = trpc.account.qqWrite.setSelfProfileDisplaySetting.useMutation();
  const fields: DisplayContext['fields'] = {};
  if (query.data?.targetUin === uin)
    for (const setting of query.data.settings) fields[setting.field] = { setting };
  for (const [field, state] of Object.entries(overrides))
    fields[field as ProfileDisplayField] = state;
  const current = () => mounted.current && latest.current === identity;
  async function save(field: ProfileDisplayField, value: number) {
    if (!available || !enabled || pending.current.has(field) || !session.binding) return;
    const previous = fields[field]?.setting;
    if (previous?.status !== 'known' || previous.value === value) return;
    pending.current.add(field);
    versions.current.set(field, (versions.current.get(field) ?? 0) + 1);
    setOverrides((states) => ({ ...states, [field]: { setting: previous, pending: true } }));
    try {
      const result = await mutation.mutateAsync({ ...session.binding, field, value });
      if (!current()) return;
      if (result.targetUin !== uin || result.field !== field)
        throw new Error('资料展示返回目标不匹配');
      setOverrides((states) => ({
        ...states,
        [field]: {
          setting: result.setting ?? previous,
          saved: result.state === 'confirmed' || result.state === 'unchanged',
          error: result.error ?? undefined,
        },
      }));
    } catch (error) {
      if (current())
        setOverrides((states) => ({
          ...states,
          [field]: {
            setting: previous,
            error: error instanceof Error ? error.message : '保存失败，请重新读取核对',
          },
        }));
    } finally {
      pending.current.delete(field);
    }
  }
  async function refresh() {
    if (!available || query.isFetching) return;
    const before = new Map(versions.current);
    const result = await query.refetch();
    if (!current() || result.error || result.data?.targetUin !== uin) return;
    setOverrides((states) => {
      const next = { ...states };
      for (const setting of result.data!.settings)
        if (
          !pending.current.has(setting.field) &&
          before.get(setting.field) === versions.current.get(setting.field)
        )
          next[setting.field] = { setting };
      return next;
    });
  }
  return (
    <Context.Provider
      value={{
        enabled,
        available,
        loading: query.isFetching,
        error: query.error?.message ?? null,
        fields,
        enable: (next) => {
          enable(next);
          if (next && query.data) void refresh();
        },
        save: (field, value) => {
          void save(field, value);
        },
        refresh: () => {
          void refresh();
        },
      }}
    >
      {children}
    </Context.Provider>
  );
}

export function ProfileDisplayToolbar() {
  const context = useContext(Context);
  if (!context) return null;
  return (
    <div className="weq-profile-display-toolbar">
      <button
        type="button"
        className="weq-set-btn weq-profile-display-mode-button"
        data-profile-display-mode
        aria-expanded={context.enabled}
        onClick={() => context.enable(!context.enabled)}
      >
        {context.enabled ? <Check size={14} /> : <SlidersHorizontal size={14} />}
        {context.enabled ? '完成资料展示设置' : '资料展示设置'}
      </button>
      {context.enabled && (
        <>
          <span role="status">
            {!context.available
              ? '暂不可在线读取'
              : (context.error ?? (context.loading ? '读取中' : ''))}
          </span>
          <button
            type="button"
            title="重新读取展示设置"
            aria-label="重新读取展示设置"
            className="weq-set-iconbtn"
            disabled={!context.available || context.loading}
            onClick={context.refresh}
          >
            <RotateCcw size={14} />
          </button>
        </>
      )}
    </div>
  );
}

export function ProfileDisplayControl({ field }: { field: ProfileDisplayField }) {
  const context = useContext(Context);
  if (!context?.enabled) return null;
  const definition = PROFILE_DISPLAY_FIELDS[field];
  const state = context.fields[field];
  const setting = state?.setting;
  const status =
    state?.error ??
    (state?.pending
      ? '保存中'
      : state?.saved
        ? '已保存'
        : !context.available
          ? '暂不可在线修改'
          : context.error
            ? '读取失败'
            : !setting
              ? context.loading
                ? '读取中'
                : '尚未读取'
              : setting.status === 'missing'
                ? '未返回此项'
                : setting.status === 'unknown'
                  ? `未知状态（${setting.raw}）`
                  : setting.status === 'incomplete'
                    ? '尚未完整返回'
                    : '');
  return (
    <div
      className="weq-profile-display-control"
      data-display-field={field}
      aria-busy={state?.pending || undefined}
    >
      <SegmentedControl<number>
        label={`${definition.label}展示范围`}
        value={setting?.value ?? null}
        options={definition.options}
        disabled={!context.available || setting?.status !== 'known' || Boolean(state?.pending)}
        onChange={(value) => context.save(field, value)}
      />
      <span
        className="weq-profile-display-status"
        role="status"
        data-error={Boolean(state?.error) || undefined}
      >
        {state?.pending ? (
          <Loader2 size={12} className="animate-spin" />
        ) : state?.saved ? (
          <Check size={12} />
        ) : null}
        {status}
        {state?.error && (
          <button
            type="button"
            title={`重新读取${definition.label}展示设置`}
            aria-label={`重新读取${definition.label}展示设置`}
            disabled={!context.available || context.loading}
            onClick={context.refresh}
          >
            <RotateCcw size={12} />
          </button>
        )}
      </span>
    </div>
  );
}

/** 原有编辑组件不依赖展示设置；关闭模式时保持原布局。 */
export function DisplaySelfProfileField({
  displayField,
  ...props
}: ComponentProps<typeof SelfProfileField> & { displayField?: ProfileDisplayField }) {
  const enabled = useProfileDisplayMode();
  return (
    <div
      className={enabled && displayField ? 'weq-profile-display-field' : 'weq-profile-display-pass'}
    >
      <SelfProfileField {...props} />
      {displayField ? <ProfileDisplayControl field={displayField} /> : null}
    </div>
  );
}
export function ProfileDisplayEntry({
  field,
  children,
}: {
  field: ProfileDisplayField;
  children: ReactNode;
}) {
  return useProfileDisplayMode() ? (
    <div className="weq-profile-display-entry">
      {children}
      <ProfileDisplayControl field={field} />
    </div>
  ) : (
    children
  );
}
export function ProfileDisplayValue({
  field,
  value,
}: {
  field: ProfileDisplayField;
  value: ReactNode;
}) {
  if (!useProfileDisplayMode()) return null;
  return (
    <div className="weq-profile-display-field">
      <div className="weq-profile-display-value">
        <span>{PROFILE_DISPLAY_FIELDS[field].label}</span>
        <strong data-privacy-sensitive>{value ?? '暂无本地资料'}</strong>
      </div>
      <ProfileDisplayControl field={field} />
    </div>
  );
}
