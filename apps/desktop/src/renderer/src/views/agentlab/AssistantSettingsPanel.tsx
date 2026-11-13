import { createContext, memo, useContext, useEffect, useId, useRef, useState } from 'react';
import {
  Brain,
  Cpu,
  Image,
  ListOrdered,
  Settings2,
  SlidersHorizontal,
  RotateCcw,
} from 'lucide-react';
import type { AssistantConfig } from '@weq/service';
import {
  ASSISTANT_PARAMETER_DEFAULTS,
  validateAssistantParameters,
} from '@weq/service/assistant-config';
import { isDefaultModelSelection } from '@weq/agentlab/model-selection';
import { trpc } from '../../trpc/client';
import { ApiModelSelect } from '../../components/settings/ApiModelSelect';
import { AiImagePreferenceSetting } from '../../components/settings/AiImageSettings';
import { Row } from '../../components/settings/controls';
import { ConversationSettingsFrame } from '../../components/ConversationSettingsFrame';
import { useAppDialog } from '../../lib/dialogUtils';
import { SegmentedControl } from '../../components/SegmentedControl';
import { useSettingsAutosave, type SettingsSection } from '../../hooks/useSettingsAutosave';
import '../../styles/assistant-settings.css';

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

export const ASSISTANT_SEND_MODES = [
  { value: 'interrupt', label: '立即补充' },
  { value: 'boundary', label: '下一步补充' },
  { value: 'queue', label: '排队发送' },
] as const;
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
          { okLabel: '开启任意权限', cancelLabel: '取消', tone: 'warning' },
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
  };
}
function EffortSelect({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const config = trpc.account.getAssistantConfig.useQuery();
  const providers = trpc.bootstrap.listAgentLabProviders.useQuery();
  const defaults = trpc.bootstrap.getAgentLabDefaultModel.useQuery();
  const model = config.data?.model;
  const ref = !model || isDefaultModelSelection(model) ? defaults.data?.ref : model;
  const declared =
    ref &&
    providers.data
      ?.find((provider) => provider.id === ref.providerId)
      ?.models.find((item) => item.id === ref.model)?.reasoningEfforts;
  const values = [
    'off',
    ...(declared ?? ['low', 'medium', 'high']).filter((item) => item !== 'off'),
  ];
  if (!values.includes(value)) values.push(value);
  return (
    <select
      className="weq-set-input"
      aria-label="思考等级"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      disabled={disabled}
    >
      {values.map((effort) => (
        <option value={effort} key={effort}>
          {effort === 'off' ? '不指定' : effort}
        </option>
      ))}
    </select>
  );
}
export const AssistantQuickTools = memo(function AssistantQuickTools() {
  const { data, save, saving, error } = useAssistantParameters();
  return (
    <div className="weq-conversation-tools">
      <span className="weq-assistant-parameter">
        <span>模型</span>
        <ApiModelSelect
          label="聊天模型"
          value={data?.model ?? { useDefault: true }}
          disabled={!data || saving}
          onChange={(model) => {
            if (model) void save({ model }).catch(() => {});
          }}
        />
      </span>
      <label className="weq-assistant-parameter">
        <span>思考</span>
        <EffortSelect
          value={data?.reasoningEffort ?? 'off'}
          onChange={(reasoningEffort) => void save({ reasoningEffort }).catch(() => {})}
          disabled={!data || saving}
        />
      </label>
      {error ? (
        <span role="alert">{error}</span>
      ) : saving ? (
        <span role="status">保存中…</span>
      ) : null}
    </div>
  );
});
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
  const focused = useRef(false);
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
              onFocus={() => {
                focused.current = true;
              }}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={() => {
                focused.current = false;
                void form?.flush();
              }}
            />
          ) : null}
          <button
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
    <div className="weq-agentlab-field">
      <div className="weq-setting-field-head">
        <label htmlFor={id}>{label}</label>
        <button
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

export function AssistantSettingsPanel({ onClose }: { onClose: () => void }) {
  const { data, save, saving, error, settle, retry } = useAssistantParameters();
  const form = useSettingsAutosave<AssistantConfig>(async (patch) => {
    validateAssistantParameters({ ...ASSISTANT_PARAMETER_DEFAULTS, ...data, ...patch });
    await save(patch);
  });
  const [section, setSection] = useState('model');
  const config = { ...ASSISTANT_PARAMETER_DEFAULTS, ...data };
  const fields: Array<{
    name: keyof typeof ASSISTANT_PARAMETER_DEFAULTS;
    label: string;
    section: string;
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
  return (
    <AssistantFields.Provider value={{ register: form.register, flush: form.flush }}>
      <ConversationSettingsFrame
        title="助手设置"
        subtitle="WeQ 助手"
        value={section}
        onValueChange={(next) => {
          void form.flush();
          setSection(next);
        }}
        onClose={() =>
          void form.flush().then(async (ok) => {
            if (ok) {
              try {
                await settle();
                onClose();
              } catch {
                /* 保留失败草稿。 */
              }
            }
          })
        }
        sections={[
          { id: 'model', label: '模型与生成', icon: <Cpu size={16} /> },
          { id: 'execution', label: '任务执行', icon: <Settings2 size={16} /> },
          { id: 'context', label: '上下文管理', icon: <Brain size={16} /> },
          { id: 'tools', label: '提示与工具', icon: <SlidersHorizontal size={16} /> },
          { id: 'images', label: '图片处理', icon: <Image size={16} /> },
          { id: 'sending', label: '运行中发送', icon: <ListOrdered size={16} /> },
        ]}
      >
        <div className="weq-cvs-body-scroll">
          <div role="status">
            {saving ? (
              '保存中…'
            ) : error || form.error ? (
              <span role="alert">
                保存失败：{error || form.error}
                <button
                  type="button"
                  disabled={saving || form.saving}
                  onClick={() =>
                    void (form.dirty || form.error ? form.flush() : retry()).catch(() => {})
                  }
                >
                  重试保存
                </button>
              </span>
            ) : data ? (
              form.status
            ) : (
              '读取中…'
            )}
          </div>
          <div hidden={section !== 'model'}>
            <Row
              label="聊天模型"
              control={
                <ApiModelSelect
                  label="聊天模型"
                  value={data?.model ?? { useDefault: true }}
                  onChange={(model) => {
                    if (model) void save({ model }).catch(() => {});
                  }}
                />
              }
            />
            <Row
              label="思考等级"
              control={
                <EffortSelect
                  value={data?.reasoningEffort ?? 'off'}
                  onChange={(reasoningEffort) => void save({ reasoningEffort }).catch(() => {})}
                  disabled={!data || saving}
                />
              }
            />
          </div>
          {fields.map((field) => (
            <div key={field.name} hidden={field.section !== section}>
              <NumberSetting {...field} value={config[field.name] as number | null} />
            </div>
          ))}
          <div hidden={section !== 'tools'}>
            <Row
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
            <TextSetting label="额外提示词" value={data?.customPrompt ?? ''} name="customPrompt" />
            <TextSetting label="外部 MCP 服务器" value={data?.mcpServers ?? ''} name="mcpServers" />
          </div>
          {section === 'images' ? <AiImagePreferenceSetting feature="assistant" /> : null}
          {section === 'sending' ? (
            <Row
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
            />
          ) : null}
        </div>
      </ConversationSettingsFrame>
    </AssistantFields.Provider>
  );
}
