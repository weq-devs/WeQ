import { FormSelect } from '../../components/FormSelect';
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Cpu, SlidersHorizontal, RefreshCw } from 'lucide-react';
import type { AssistantConfig } from '@weq/service';
import { DEFAULT_ASSISTANT_SEND_MODE, type AssistantSendMode } from '@weq/service/assistant-config';
import { trpc } from '../../trpc/client';
import { ConversationModelSettings } from '../../components/settings/ConversationModelSettings';
import { Card, Row, SectionHeader, Toggle } from '../../components/settings/controls';
import { useAppDialog } from '../../lib/dialogUtils';
import { SegmentedControl } from '../../components/SegmentedControl';
import { useSettingsAutosave, type SettingsSection } from '../../hooks/useSettingsAutosave';
import { useSettingsSaveBanner } from '../../hooks/useSettingsSaveBanner';
import { useDraftProtection } from '../../lib/draftClose';
import { settingsSaves } from '../../lib/settingsSaveQueue';
import { SettingsResetContext } from '../../components/settings/resetContext';
import { ConversationSettingsFrame } from '../../components/ConversationSettingsFrame';
import '../../styles/assistant-settings.css';
import { ASSISTANT_SEND_MODES } from './AssistantSettingsPanel.shared';

const AssistantFields = createContext<{
  register: (id: string, value: SettingsSection<AssistantConfig> | null) => void;
  flush: () => Promise<boolean>;
} | null>(null);
function useAssistantField(id: string, value: unknown, patch: AssistantConfig, valid: boolean) {
  const form = useContext(AssistantFields);
  const snapshot = JSON.stringify(value);
  const serializedPatch = JSON.stringify(patch);
  const current = useRef(patch);
  current.current = patch;
  useEffect(() => {
    form?.register(id, { snapshot, patch: current.current, valid });
  }, [form?.register, id, snapshot, serializedPatch, valid]);
  return form;
}
function useAssistantParameters() {
  const query = trpc.account.getAssistantConfig.useQuery();
  const mutation = trpc.account.setAssistantConfig.useMutation();
  const utils = trpc.useUtils();
  const dialog = useAppDialog();
  const [error, setError] = useState('');
  const [optimistic, setOptimistic] = useState<AssistantConfig>({});
  const pending = useRef<AssistantConfig>({});
  const clearPending = (patch: AssistantConfig) => {
    const next = { ...pending.current };
    for (const key of Object.keys(patch) as Array<keyof AssistantConfig>) {
      if (JSON.stringify(next[key]) === JSON.stringify(patch[key])) delete next[key];
    }
    pending.current = next;
    setOptimistic(next);
  };
  const queue = useRef<Promise<void>>(Promise.resolve());
  const failed = useRef<AssistantConfig | null>(null);
  const paused = useRef(false);
  const performSave = async (input: AssistantConfig) => {
    let patch = input;
    setError('');
    try {
      let confirmUnrestricted = false;
      if (
        patch.permissionMode === 'unrestricted' &&
        query.data?.permissionMode !== 'unrestricted'
      ) {
        confirmUnrestricted = await dialog.confirm(
          '开启任意权限？',
          '助手将以当前系统用户的权限执行操作，包括运行命令和修改外部文件。',
          { danger: 'solid', okLabel: '开启任意权限', cancelLabel: '取消', tone: 'warning' },
        );
        if (!confirmUnrestricted) {
          clearPending({ permissionMode: patch.permissionMode });
          patch = { ...patch };
          delete patch.permissionMode;
          if (!Object.keys(patch).length) {
            failed.current = null;
            return;
          }
        }
      }
      const next = await mutation.mutateAsync({ ...patch, confirmUnrestricted });
      utils.account.getAssistantConfig.setData(undefined, next);
      clearPending(patch);
      failed.current = null;
    } catch (reason) {
      failed.current = patch;
      setError(reason instanceof Error ? reason.message : String(reason));
      throw reason;
    }
  };
  const save = (patch: AssistantConfig) => {
    if (paused.current) return Promise.resolve();
    pending.current = { ...pending.current, ...patch };
    setOptimistic(pending.current);
    const operation = queue.current
      .catch(() => {})
      .then(() => performSave({ ...failed.current, ...patch }));
    queue.current = operation;
    return operation;
  };
  return {
    data: query.data ? { ...query.data, ...optimistic } : undefined,
    saving: mutation.isLoading,
    error: error || query.error?.message,
    save,
    settle: () => queue.current,
    suspend: async () => {
      paused.current = true;
      await queue.current.catch(() => {});
    },
    release: () => {
      paused.current = false;
    },
    retry: () => (failed.current ? save(failed.current) : Promise.resolve()),
    reload: () => query.refetch(),
  };
}
function TextSetting({
  label,
  value,
  name,
}: {
  label: string;
  value: string;
  name: 'customPrompt' | 'mcpServers';
}) {
  const [draft, setDraft] = useState(value);
  const id = useId();
  let error = '';
  if (name === 'mcpServers' && draft.trim().startsWith('{')) {
    try {
      JSON.parse(draft);
    } catch {
      error = 'MCP 配置 JSON 格式无效，请检查括号、引号和逗号';
    }
  }
  const form = useAssistantField(name, draft, { [name]: draft }, !error);
  const prior = useRef(value);
  useEffect(() => {
    const previous = prior.current;
    setDraft((current) => (current === previous ? value : current));
    prior.current = value;
  }, [value]);
  return (
    <div className="weq-set-text-field" data-setting-id={`weq-assistant-${name}`}>
      <label className="weq-set-row-label" htmlFor={id}>
        {label}
      </label>
      <textarea
        className="weq-set-input"
        id={id}
        aria-invalid={Boolean(error)}
        rows={5}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          void form?.flush();
        }}
      />
      {error ? <span role="alert">{error}</span> : null}
    </div>
  );
}

const GLOBAL_GROUPS = [
  { id: 'model', label: '模型设置', icon: <Cpu size={16} /> },
  { id: 'tools', label: '提示与工具', icon: <SlidersHorizontal size={16} /> },
] as const;
type GlobalGroup = (typeof GLOBAL_GROUPS)[number]['id'];

type AssistantSettingsProps = {
  conversation?: {
    title: string;
    anchor?: HTMLElement;
    onClose: () => void;
  };
};

export function WeqAssistantSettingsSection(props: AssistantSettingsProps) {
  const [resetRevision, setResetRevision] = useState(0);
  return (
    <AssistantSettingsFields
      key={resetRevision}
      {...props}
      onReset={() => setResetRevision((previous) => previous + 1)}
    />
  );
}

function AssistantSettingsFields({
  conversation,
  onReset,
}: AssistantSettingsProps & { onReset: () => void }) {
  const [section, setSection] = useState<GlobalGroup>('model');
  const { data, save, saving, error, settle, suspend, release, retry, reload } =
    useAssistantParameters();
  const reset = useContext(SettingsResetContext);
  const form = useSettingsAutosave<AssistantConfig>(save);
  useSettingsSaveBanner(saving || form.saving);
  const protection = useDraftProtection(form.dirty || (data && error) ? true : null, false);
  if (!form.dirty && !(data && error)) protection.reset(null);
  const saveState = useRef({ form, saving, error, settle, suspend, release, onReset });
  saveState.current = { form, saving, error, settle, suspend, release, onReset };
  const resetSaves = conversation ? null : reset?.saves('assistant-config');
  useEffect(() => {
    let restored = false;
    const entry = {
      get pending() {
        const { form, saving } = saveState.current;
        return saving || form.saving || (form.dirty && form.valid && !form.error);
      },
      flush: async () => {
        const { form, error, settle } = saveState.current;
        if (form.error || error) return false;
        return (
          (await form.flush()) &&
          (await settle().then(
            () => true,
            () => false,
          ))
        );
      },
      suspend: async () => {
        const { form, suspend } = saveState.current;
        await Promise.all([form.suspend(), suspend()]);
      },
      reset: () => {
        restored = true;
        saveState.current.onReset();
      },
      release: () => {
        if (restored) return;
        saveState.current.release();
        saveState.current.form.release();
      },
    };
    settingsSaves.add(entry);
    resetSaves?.add(entry);
    return () => {
      settingsSaves.delete(entry);
      resetSaves?.delete(entry);
    };
  }, [resetSaves]);
  const group = (id: GlobalGroup, children: ReactNode) => {
    if (conversation)
      return (
        <div hidden={section !== id} inert={section !== id}>
          {children}
        </div>
      );
    const current = GLOBAL_GROUPS.find((item) => item.id === id)!;
    return (
      <Card
        settingId={id === 'model' ? 'weq-assistant-model-settings' : undefined}
        title={current.label}
        icon={current.icon}
      >
        {children}
      </Card>
    );
  };
  const closeConversation = async () => {
    if (!conversation || !(await form.flush())) return;
    try {
      await settle();
    } catch {
      return;
    }
    conversation.onClose();
  };
  const sendMode = data?.sendMode ?? DEFAULT_ASSISTANT_SEND_MODE;
  const contents = (
    <>
      {error || form.error || !data ? (
        <div role="status">
          {error || form.error ? (
            <span role="alert">
              {data ? '保存失败' : '读取失败'}：{error || form.error}{' '}
              <button
                type="button"
                disabled={saving || form.saving}
                onClick={() =>
                  void (!data ? reload() : form.dirty || form.error ? form.flush() : retry()).catch(
                    () => {},
                  )
                }
                className="weq-retry-button"
              >
                <RefreshCw size={14} aria-hidden />
                {data ? '重试保存' : '重新读取'}
              </button>
            </span>
          ) : (
            '读取中…'
          )}
        </div>
      ) : null}
      {data ? (
        <>
          {group(
            'model',
            <ConversationModelSettings
              feature="assistant"
              model={data.model ?? { useDefault: true }}
              effort={data.reasoningEffort ?? 'off'}
              disabled={saving}
              onModelChange={(model) => void save({ model }).catch(() => {})}
              onEffortChange={(reasoningEffort) => void save({ reasoningEffort }).catch(() => {})}
            >
              <Row
                settingId="weq-assistant-local-lightweight"
                label="本地模型轻量模式"
                control={
                  <Toggle
                    label="本地模型轻量模式"
                    checked={data.localLightweight === true}
                    disabled={saving}
                    onChange={(localLightweight) => void save({ localLightweight }).catch(() => {})}
                  />
                }
              />
              <Row
                settingId="weq-assistant-permission"
                label="运行模式"
                desc={
                  data.permissionMode === 'unrestricted'
                    ? '以当前系统用户权限执行操作。'
                    : '在沙箱中执行任务。'
                }
                control={
                  <SegmentedControl
                    label="运行模式"
                    value={data?.permissionMode ?? 'sandbox'}
                    onChange={(permissionMode) =>
                      void save({
                        permissionMode,
                      }).catch(() => {})
                    }
                    options={[
                      { value: 'sandbox', label: '沙箱模式' },
                      { value: 'unrestricted', label: '任意权限' },
                    ]}
                  />
                }
              />
              <Row
                settingId="weq-assistant-send-mode"
                label="运行中默认发送方式"
                desc={
                  sendMode === 'queue'
                    ? '当前任务完成后，按顺序启动独立任务。'
                    : sendMode === 'boundary'
                      ? '本次模型调用和工具批次结束后补入当前任务。'
                      : '中断当前模型请求，工具收尾后带补充继续。'
                }
                control={
                  <FormSelect
                    className="weq-set-input"
                    aria-label="运行中默认发送方式"
                    value={sendMode}
                    onChange={(event) =>
                      void save({ sendMode: event.target.value as AssistantSendMode }).catch(
                        () => {},
                      )
                    }
                  >
                    {ASSISTANT_SEND_MODES.map(({ value, label }) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </FormSelect>
                }
              />
            </ConversationModelSettings>,
          )}
          {group(
            'tools',
            <>
              <TextSetting
                label="额外提示词"
                value={data?.customPrompt ?? ''}
                name="customPrompt"
              />
              <TextSetting
                label="外部 MCP 服务器"
                value={data?.mcpServers ?? ''}
                name="mcpServers"
              />
            </>,
          )}
        </>
      ) : null}
    </>
  );
  return (
    <AssistantFields.Provider value={{ register: form.register, flush: form.flush }}>
      {conversation ? (
        <ConversationSettingsFrame
          title="助手设置"
          subtitle={conversation.title}
          anchor={conversation.anchor}
          onClose={() => void closeConversation()}
          sections={GLOBAL_GROUPS}
          value={section}
          sectionDescription="应用级设置，所有助手会话共用"
          onValueChange={(next) => {
            setSection(next);
            if (form.dirty && !form.error) void form.flush();
          }}
        >
          <div className="weq-set weq-cvs-body-scroll weq-assistant-settings">{contents}</div>
        </ConversationSettingsFrame>
      ) : (
        <div className="weq-set weq-assistant-settings">
          <SectionHeader page="weq-assistant" title="WeQ 助手" />
          {contents}
        </div>
      )}
    </AssistantFields.Provider>
  );
}
