import { memo, useEffect, useRef, useState } from 'react';
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
import { ASSISTANT_PARAMETER_DEFAULTS } from '@weq/service/assistant-config';
import { isDefaultModelSelection } from '@weq/agentlab/model-selection';
import { trpc } from '../../trpc/client';
import { ApiModelSelect } from '../../components/settings/ApiModelSelect';
import { AiImagePreferenceSetting } from '../../components/settings/AiImageSettings';
import { Row } from '../../components/settings/controls';
import { ConversationSettingsFrame } from '../../components/ConversationSettingsFrame';
import { useAppDialog } from '../../lib/dialogUtils';

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
  const save = async (patch: AssistantConfig) => {
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
        if (!confirmUnrestricted) return;
      }
      const next = await mutation.mutateAsync({ ...patch, confirmUnrestricted });
      utils.account.getAssistantConfig.setData(undefined, next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      throw reason;
    }
  };
  return {
    data: query.data,
    saving: mutation.isLoading,
    error: error || query.error?.message,
    save,
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
      <ApiModelSelect
        label="聊天模型"
        value={data?.model ?? { useDefault: true }}
        disabled={!data || saving}
        onChange={(model) => {
          if (model) void save({ model }).catch(() => {});
        }}
      />
      <EffortSelect
        value={data?.reasoningEffort ?? 'off'}
        onChange={(reasoningEffort) => void save({ reasoningEffort }).catch(() => {})}
        disabled={!data || saving}
      />
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
  onSave,
  nullable = false,
  scale = 1,
}: {
  name: keyof typeof ASSISTANT_PARAMETER_DEFAULTS;
  label: string;
  value: number | null;
  onSave: (value: number | null) => Promise<void>;
  nullable?: boolean;
  scale?: number;
}) {
  const [draft, setDraft] = useState(value === null ? '' : String(value / scale));
  const [error, setError] = useState('');
  const focused = useRef(false);
  const lastValue = useRef(
    value ??
      (ASSISTANT_PARAMETER_DEFAULTS[name] as number | null) ??
      (name === 'maxOutputTokens' ? 4096 : 1),
  );
  useEffect(() => {
    if (typeof value === 'number') lastValue.current = value;
  }, [value]);
  useEffect(() => {
    if (!focused.current) setDraft(value === null ? '' : String(value / scale));
  }, [value, scale]);
  async function save(next: number | null) {
    try {
      await onSave(next);
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }
  return (
    <Row
      label={label}
      control={
        <div className="weq-conversation-tools">
          <input
            className="weq-set-input weq-number"
            type="number"
            step="any"
            aria-label={label}
            value={draft}
            disabled={value === null}
            onFocus={() => {
              focused.current = true;
            }}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => {
              focused.current = false;
              if (draft.trim() && Number(draft) * scale !== value) void save(Number(draft) * scale);
            }}
          />
          {nullable ? (
            <label>
              <input
                type="checkbox"
                checked={value === null}
                onChange={(event) => void save(event.target.checked ? null : lastValue.current)}
              />
              {name === 'temperature' || name === 'maxOutputTokens' ? '跟随模型' : '不限制'}
            </label>
          ) : null}
          <button
            type="button"
            className="weq-set-iconbtn"
            title={`恢复${label}默认值`}
            aria-label={`恢复${label}默认值`}
            onClick={() => void save(ASSISTANT_PARAMETER_DEFAULTS[name] as number | null)}
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
  onSave,
}: {
  label: string;
  value: string;
  onSave: (value: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState('');
  const prior = useRef(value);
  useEffect(() => {
    const previous = prior.current;
    setDraft((current) => (current === previous ? value : current));
    prior.current = value;
  }, [value]);
  const save = async () => {
    try {
      await onSave(draft);
      setError('');
    } catch (reason) {
      setError(String(reason));
    }
  };
  return (
    <label className="weq-agentlab-field">
      <span>{label}</span>
      <textarea
        rows={5}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (draft !== value) void save();
        }}
      />
      <button
        type="button"
        className="weq-set-iconbtn"
        title={`恢复${label}默认值`}
        aria-label={`恢复${label}默认值`}
        onClick={() => {
          setDraft('');
          void onSave('').catch((reason) => setError(String(reason)));
        }}
      >
        <RotateCcw size={14} />
      </button>
      {error ? (
        <span role="alert">
          {error}
          <button type="button" onClick={() => void save()}>
            重试保存
          </button>
        </span>
      ) : null}
    </label>
  );
}

export function AssistantSettingsPanel({ onClose }: { onClose: () => void }) {
  const { data, save, saving, error } = useAssistantParameters();
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
    <ConversationSettingsFrame
      title="助手设置"
      subtitle="WeQ 助手"
      value={section}
      onValueChange={setSection}
      onClose={onClose}
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
          ) : error ? (
            <span role="alert">{error}</span>
          ) : data ? (
            '已保存'
          ) : (
            '读取中…'
          )}
        </div>
        {section === 'model' ? (
          <>
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
          </>
        ) : null}
        {fields
          .filter((field) => field.section === section)
          .map((field) => (
            <NumberSetting
              key={field.name}
              {...field}
              value={config[field.name] as number | null}
              onSave={(value) => save({ [field.name]: value })}
            />
          ))}
        {section === 'tools' ? (
          <>
            <Row
              label="运行模式"
              control={
                <select
                  aria-label="运行模式"
                  value={data?.permissionMode ?? 'sandbox'}
                  onChange={(event) =>
                    void save({
                      permissionMode: event.target.value as 'sandbox' | 'unrestricted',
                    }).catch(() => {})
                  }
                >
                  <option value="sandbox">沙箱模式</option>
                  <option value="unrestricted">任意权限</option>
                </select>
              }
            />
            <TextSetting
              label="额外提示词"
              value={data?.customPrompt ?? ''}
              onSave={(customPrompt) => save({ customPrompt })}
            />
            <TextSetting
              label="外部 MCP 服务器"
              value={data?.mcpServers ?? ''}
              onSave={(mcpServers) => save({ mcpServers })}
            />
          </>
        ) : null}
        {section === 'images' ? <AiImagePreferenceSetting feature="assistant" /> : null}
        {section === 'sending' ? (
          <Row
            label="运行中默认发送方式"
            control={
              <select
                aria-label="运行中默认发送方式"
                value={data?.sendMode ?? 'interrupt'}
                onChange={(event) =>
                  void save({
                    sendMode: event.target.value as 'interrupt' | 'boundary' | 'queue',
                  }).catch(() => {})
                }
              >
                {ASSISTANT_SEND_MODES.map((mode) => (
                  <option key={mode.value} value={mode.value}>
                    {mode.label}
                  </option>
                ))}
              </select>
            }
          />
        ) : null}
      </div>
    </ConversationSettingsFrame>
  );
}
