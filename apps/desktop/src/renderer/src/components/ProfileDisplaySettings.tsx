import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react';
import { Check, Loader2, RotateCcw } from 'lucide-react';
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
  available: boolean;
  loading: boolean;
  error: string | null;
  fields: Partial<Record<ProfileDisplayField, FieldState>>;
  save: (field: ProfileDisplayField, value: number) => Promise<boolean>;
  refresh: () => void;
}
const Context = createContext<DisplayContext | null>(null);
export function ReadonlyProfileDisplay({ children }: { children: ReactNode }) {
  return <Context.Provider value={null}>{children}</Context.Provider>;
}

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
    enabled: available,
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
    if (!available || pending.current.has(field) || !session.binding) return false;
    const previous = fields[field]?.setting;
    if (previous?.status !== 'known') return false;
    if (previous.value === value) return true;
    pending.current.add(field);
    versions.current.set(field, (versions.current.get(field) ?? 0) + 1);
    setOverrides((states) => ({ ...states, [field]: { setting: previous, pending: true } }));
    try {
      const result = await mutation.mutateAsync({ ...session.binding, field, value });
      if (!current()) return false;
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
      return result.state === 'confirmed' || result.state === 'unchanged';
    } catch (error) {
      if (current())
        setOverrides((states) => ({
          ...states,
          [field]: {
            setting: previous,
            error: error instanceof Error ? error.message : '保存失败，请重新读取核对',
          },
        }));
      return false;
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
        available,
        loading: query.isFetching,
        error: query.error?.message ?? null,
        fields,
        save,
        refresh: () => {
          void refresh();
        },
      }}
    >
      {children}
    </Context.Provider>
  );
}

export function ProfileDisplayControl({
  field,
  value,
  onChange,
}: {
  field: ProfileDisplayField;
  value: number | null;
  onChange: (value: number) => void;
}) {
  const context = useContext(Context);
  if (!context) return null;
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
          ? '当前不可修改'
          : context.error
            ? '读取失败'
            : !setting
              ? context.loading
                ? '读取中'
                : '尚未读取'
              : setting.status === 'missing'
                ? 'QQ 未返回这项'
                : setting.status === 'unknown'
                  ? '当前设置无法识别'
                  : setting.status === 'incomplete'
                    ? '读取不完整'
                    : '');
  return (
    <div
      className="weq-profile-display-control"
      data-display-field={field}
      aria-busy={state?.pending || undefined}
    >
      <SegmentedControl<number>
        label={`${definition.label}展示范围`}
        value={value}
        options={definition.options}
        disabled={!context.available || setting?.status !== 'known' || Boolean(state?.pending)}
        onChange={onChange}
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
        {(state?.error || context.error || setting?.status !== 'known') && (
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

/** 展示范围与内容共用一次保存；范围读取失败不阻塞内容编辑。 */
export function DisplaySelfProfileField({
  displayField,
  ...props
}: ComponentProps<typeof SelfProfileField> & { displayField?: ProfileDisplayField }) {
  const context = useContext(Context);
  const [editing, setEditing] = useState(false);
  const [rangeEditing, setRangeEditing] = useState(false);
  const [draft, setDraft] = useState<number | null>(null);
  const [partial, setPartial] = useState(false);
  const setting = displayField ? context?.fields[displayField]?.setting : undefined;
  const value = draft ?? (setting?.status === 'known' ? setting.value : null);
  const definition = displayField ? PROFILE_DISPLAY_FIELDS[displayField] : undefined;
  const summary =
    setting?.status === 'known'
      ? (definition?.options.find((option) => option.value === setting.value)?.label ?? '无法识别')
      : context?.error
        ? '读取失败'
        : context?.loading
          ? '读取中'
          : setting
            ? '无法读取'
            : '未读取';
  return (
    <SelfProfileField
      {...props}
      onEditingChange={(next) => {
        setEditing(next);
        props.onEditingChange?.(next);
      }}
      onClose={() => {
        setRangeEditing(false);
        setDraft(null);
        setPartial(false);
        props.onClose?.();
      }}
      afterSave={async () => {
        if (props.afterSave && !(await props.afterSave())) return false;
        if (!displayField || !context || value === null || value === setting?.value) return true;
        const ok = await context.save(displayField, value);
        setPartial(!ok);
        return ok;
      }}
      auxiliaryEditing={rangeEditing}
      auxiliarySaveDisabled={!context?.available || setting?.status !== 'known'}
      auxiliary={
        displayField && context ? (
          rangeEditing ? (
            <ProfileDisplayControl
              field={displayField}
              value={value}
              onChange={(next) => {
                setDraft(next);
                setPartial(false);
              }}
            />
          ) : context.available ? (
            <button
              type="button"
              className="weq-profile-display-summary"
              aria-label={`编辑${definition?.label}展示范围`}
              title={`编辑${definition?.label}展示范围`}
              onClick={(event) => {
                const selection = event.currentTarget.ownerDocument.getSelection();
                if (selection?.toString() && event.currentTarget.contains(selection.anchorNode))
                  return;
                setRangeEditing(true);
              }}
            >
              （{summary}）
            </button>
          ) : setting?.status === 'known' ? (
            <span className="weq-profile-display-summary">（{summary}）</span>
          ) : null
        ) : (
          props.auxiliary
        )
      }
      editorFooter={
        (editing || rangeEditing) && displayField ? (
          <>
            {partial ? <p role="alert">展示范围尚未保存。请重试保存或重新读取。</p> : null}
            {props.editorFooter}
          </>
        ) : (
          props.editorFooter
        )
      }
    />
  );
}
export function ProfileDisplayEntry({
  field,
  children,
  unframed = false,
  label,
}: {
  field: ProfileDisplayField;
  children: ReactNode;
  unframed?: boolean;
  label?: string;
}) {
  const context = useContext(Context);
  if (!context || unframed) return children;
  return (
    <DisplaySelfProfileField
      label={label ?? PROFILE_DISPLAY_FIELDS[field].label}
      value={children}
      displayField={field}
      disabled={!context.available}
      unframed={unframed}
      valueHasAction
    >
      {null}
    </DisplaySelfProfileField>
  );
}

export function ProfileDisplaySettingField({ field }: { field: ProfileDisplayField }) {
  const context = useContext(Context);
  if (!context) return null;
  return (
    <DisplaySelfProfileField
      label="展示范围"
      value={null}
      displayField={field}
      valueHasAction
      rangeOnly
      disabled={!context.available}
    >
      {null}
    </DisplaySelfProfileField>
  );
}
