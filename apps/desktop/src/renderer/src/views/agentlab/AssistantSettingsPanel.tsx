import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  Brain,
  ChevronRight,
  Cpu,
  Image,
  ListOrdered,
  Settings2,
  SlidersHorizontal,
  RotateCcw,
  RefreshCw,
} from 'lucide-react';
import type { AssistantConfig } from '@weq/service';
import {
  ASSISTANT_PARAMETER_DEFAULTS,
  validateAssistantParameters,
} from '@weq/service/assistant-config';
import { trpc } from '../../trpc/client';
import { ApiModelSelect } from '../../components/settings/ApiModelSelect';
import { AiImagePreferenceSetting } from '../../components/settings/AiImageSettings';
import { Card, Row, SectionHeader } from '../../components/settings/controls';
import { useAppDialog } from '../../lib/dialogUtils';
import { SegmentedControl } from '../../components/SegmentedControl';
import { useSettingsAutosave, type SettingsSection } from '../../hooks/useSettingsAutosave';
import { useDraftProtection } from '../../lib/draftClose';
import { settingsSaves } from '../../lib/settingsSaveQueue';
import { AssistantEffortSelect } from './AssistantGenerationControls';
import { ConversationSettingsFrame } from '../../components/ConversationSettingsFrame';
import { requestOpenSettings } from '../../lib/callSettingsBridge';
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
    retry: () => (failed.current ? save(failed.current) : Promise.resolve()),
    reload: () => query.refetch(),
  };
}
function NumberSetting({
  name,
  label,
  value,
  nullable = false,
  scale = 1,
}: {
  name: keyof typeof ASSISTANT_PARAMETER_DEFAULTS;
  label: string;
  value: number | null;
  nullable?: boolean;
  scale?: number;
}) {
  const [draft, setDraft] = useState(value === null ? '' : String(value / scale));
  const [automatic, setAutomatic] = useState(value === null);
  const prior = useRef(value);
  const lastValue = useRef(
    value ??
      (ASSISTANT_PARAMETER_DEFAULTS[name] as number | null) ??
      (name === 'maxOutputTokens' ? 4096 : 1),
  );
  useEffect(() => {
    if (typeof value === 'number') lastValue.current = value;
  }, [value]);
  useEffect(() => {
    const old = prior.current;
    setDraft((current) =>
      current === (old === null ? '' : String(old / scale))
        ? value === null
          ? ''
          : String(value / scale)
        : current,
    );
    setAutomatic((current) => (current === (old === null) ? value === null : current));
    prior.current = value;
  }, [value, scale]);
  const next = automatic ? null : Number(draft) * scale;
  let error = '';
  try {
    if (!automatic && !draft.trim()) throw new Error('请输入数值');
    validateAssistantParameters({ [name]: next });
  } catch (reason) {
    error = reason instanceof Error ? reason.message : String(reason);
  }
  const form = useAssistantField(name, { draft, automatic }, { [name]: next }, !error);
  useEffect(() => {
    if (typeof next === 'number' && !error) lastValue.current = next;
  }, [next, error]);
  const immediate = () => setTimeout(() => void form?.flush(), 0);
  return (
    <Row
      settingId={`weq-assistant-${name}`}
      label={label}
      control={
        <div className="weq-conversation-tools">
          {nullable ? (
            <SegmentedControl
              label={`${label}模式`}
              value={automatic ? 'auto' : 'custom'}
              options={[
                {
                  value: 'auto',
                  label:
                    name === 'temperature' || name === 'maxOutputTokens' ? '跟随模型' : '不限制',
                },
                { value: 'custom', label: '自定义' },
              ]}
              onChange={(mode) => {
                setAutomatic(mode === 'auto');
                if (mode === 'custom') setDraft(String(lastValue.current / scale));
                immediate();
              }}
            />
          ) : null}
          {!automatic ? (
            <input
              className="weq-set-input weq-number"
              type="number"
              step="any"
              aria-label={label}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={() => void form?.flush()}
            />
          ) : null}
          <button
            data-danger="outline"
            type="button"
            className="weq-set-iconbtn"
            title={`恢复${label}默认值`}
            aria-label={`恢复${label}默认值`}
            onClick={() => {
              const fallback = ASSISTANT_PARAMETER_DEFAULTS[name] as number | null;
              setAutomatic(fallback === null);
              setDraft(fallback === null ? '' : String(fallback / scale));
              immediate();
            }}
          >
            <RotateCcw size={14} />
          </button>
          {error ? <span role="alert">{error}</span> : null}
        </div>
      }
    />
  );
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
    <div className="weq-agentlab-field" data-setting-id={`weq-assistant-${name}`}>
      <div className="weq-setting-field-head">
        <label htmlFor={id}>{label}</label>
        <button
          data-danger="outline"
          type="button"
          className="weq-set-iconbtn"
          title={`恢复${label}默认值`}
          aria-label={`恢复${label}默认值`}
          onClick={() => {
            setDraft('');
            setTimeout(() => void form?.flush(), 0);
          }}
        >
          <RotateCcw size={14} />
        </button>
      </div>
      <textarea
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
  { id: 'model', label: '模型与生成', icon: <Cpu size={16} /> },
  { id: 'execution', label: '任务执行', icon: <Settings2 size={16} /> },
  { id: 'context', label: '上下文管理', icon: <Brain size={16} /> },
  { id: 'tools', label: '提示与工具', icon: <SlidersHorizontal size={16} /> },
  { id: 'images', label: '图片处理', icon: <Image size={16} /> },
  { id: 'sending', label: '运行中发送', icon: <ListOrdered size={16} /> },
] as const;
type GlobalGroup = (typeof GLOBAL_GROUPS)[number]['id'];

export function WeqAssistantSettingsSection({
  conversation,
}: {
  conversation?: {
    title: string;
    anchor?: HTMLElement;
    onClose: () => void;
  };
}) {
  const [section, setSection] = useState<GlobalGroup>('model');
  const { data, save, saving, error, settle, retry, reload } = useAssistantParameters();
  const form = useSettingsAutosave<AssistantConfig>(async (patch) => {
    validateAssistantParameters({ ...ASSISTANT_PARAMETER_DEFAULTS, ...data, ...patch });
    await save(patch);
  });
  const protection = useDraftProtection(form.dirty || (data && error) ? true : null, false);
  if (!form.dirty && !(data && error)) protection.reset(null);
  const saveState = useRef({ form, saving, error, settle });
  saveState.current = { form, saving, error, settle };
  useEffect(() => {
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
    };
    settingsSaves.add(entry);
    return () => {
      settingsSaves.delete(entry);
    };
  }, []);
  const config = { ...ASSISTANT_PARAMETER_DEFAULTS, ...data };
  const fields: Array<{
    name: keyof typeof ASSISTANT_PARAMETER_DEFAULTS;
    label: string;
    section: GlobalGroup;
    nullable?: boolean;
    scale?: number;
  }> = [
    { name: 'temperature', label: '温度', section: 'model', nullable: true },
    { name: 'maxOutputTokens', label: '单次输出 Token 上限', section: 'model', nullable: true },
    { name: 'maxRounds', label: '任务最大轮数', section: 'execution', nullable: true },
    {
      name: 'toolTimeoutMs',
      label: '单工具超时（秒）',
      section: 'execution',
      nullable: true,
      scale: 1000,
    },
    {
      name: 'taskTimeoutMs',
      label: '任务总时限（秒）',
      section: 'execution',
      nullable: true,
      scale: 1000,
    },
    { name: 'historyMessages', label: '带入历史消息条数', section: 'context' },
    { name: 'contextTokens', label: '上下文预算（Token）', section: 'context' },
    { name: 'compressionTrigger', label: '压缩触发比例（%）', section: 'context', scale: 0.01 },
    { name: 'compressionTarget', label: '压缩目标比例（%）', section: 'context', scale: 0.01 },
    { name: 'summaryTokens', label: '摘要 Token 上限', section: 'context' },
  ];
  const numbers = (section: GlobalGroup) =>
    fields
      .filter((field) => field.section === section)
      .map((field) => (
        <NumberSetting key={field.name} {...field} value={config[field.name] as number | null} />
      ));
  const group = (id: GlobalGroup, children: ReactNode) => {
    const current = GLOBAL_GROUPS.find((item) => item.id === id)!;
    return (
      <div hidden={Boolean(conversation && section !== id)}>
        <Card
          title={conversation ? undefined : current.label}
          icon={conversation ? undefined : current.icon}
        >
          {children}
        </Card>
      </div>
    );
  };
  const closeConversation = async (afterClose?: () => void) => {
    if (!conversation || !(await form.flush())) return;
    try {
      await settle();
    } catch {
      return;
    }
    conversation.onClose();
    afterClose?.();
  };
  const contents = (
    <>
      {saving || form.saving || error || form.error || !data ? (
        <div role="status">
          {saving || form.saving ? (
            '保存中…'
          ) : error || form.error ? (
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
            <>
              <Row
                settingId="weq-assistant-default-model"
                label="默认聊天模型"
                desc="在会话未单独选择模型时使用。"
                control={
                  <ApiModelSelect
                    label="默认聊天模型"
                    value={data?.model ?? { useDefault: true }}
                    disabled={saving}
                    onChange={(model) => {
                      if (model) void save({ model }).catch(() => {});
                    }}
                  />
                }
              />
              <Row
                settingId="weq-assistant-default-effort"
                label="默认思考强度"
                desc="在会话未单独选择思考强度时使用。"
                control={
                  <AssistantEffortSelect
                    label="默认思考强度"
                    model={data.model}
                    value={data?.reasoningEffort ?? 'off'}
                    onChange={(reasoningEffort) => void save({ reasoningEffort }).catch(() => {})}
                    disabled={!data || saving}
                  />
                }
              />
              {numbers('model')}
            </>,
          )}
          {group('execution', numbers('execution'))}
          {group('context', numbers('context'))}
          {group(
            'tools',
            <>
              <Row
                settingId="weq-assistant-permission"
                label="运行模式"
                control={
                  <div>
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
                    <small>
                      {data?.permissionMode === 'unrestricted'
                        ? '以当前系统用户权限执行操作。'
                        : '在沙箱中执行任务。'}
                    </small>
                  </div>
                }
              />
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
          {group('images', <AiImagePreferenceSetting feature="assistant" />)}
          {group(
            'sending',
            <Row
              settingId="weq-assistant-send-mode"
              label="运行中默认发送方式"
              control={
                <div>
                  <SegmentedControl
                    label="运行中默认发送方式"
                    value={data?.sendMode ?? 'interrupt'}
                    onChange={(sendMode) =>
                      void save({
                        sendMode,
                      }).catch(() => {})
                    }
                    options={ASSISTANT_SEND_MODES}
                  />
                  <small>
                    {data?.sendMode === 'queue'
                      ? '当前任务完成后，按顺序启动独立任务。'
                      : data?.sendMode === 'boundary'
                        ? '当前模型调用与工具批次结束后补入当前任务。'
                        : '中断当前模型请求，工具收尾后带补充继续。'}
                  </small>
                </div>
              }
            />,
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
          <div className="weq-cvs-body-scroll weq-assistant-settings">
            {contents}
            <button
              type="button"
              className="weq-set-btn weq-set-btn-soft weq-assistant-open-settings"
              onClick={() => void closeConversation(() => requestOpenSettings('weqAssistant'))}
            >
              在设置中打开 <ChevronRight size={14} aria-hidden />
            </button>
          </div>
        </ConversationSettingsFrame>
      ) : (
        <div className="weq-set weq-assistant-settings">
          <SectionHeader page="weq-assistant" title="WeQ 助手" pageReset={false} />
          {contents}
        </div>
      )}
    </AssistantFields.Provider>
  );
}
