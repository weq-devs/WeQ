import { useState } from 'react';
import { Save } from 'lucide-react';
import type { AgentLabPersona } from '@weq/agentlab';
import {
  CLONE_GENERATION,
  CLONE_GENERATION_HELP,
  CLONE_GENERATION_KEYS,
  normalizeCloneGeneration,
  type AgentLabGenerationConfig,
} from '@weq/agentlab/generation';
import { trpc } from '../../trpc/client';
import { Row, Toggle } from './controls';
import { ApiModelSelect } from './ApiModelSelect';
import { useCloneSettingsSection } from '../../views/agentlab/cloneSettingsDraft';
import { useDialog } from '../Dialog';
import '../../styles/model-settings.css';

export function CloneGenerationPanel({
  persona,
  onSaved,
}: {
  persona: Pick<AgentLabPersona, 'id' | 'models' | 'generation'>;
  onSaved: () => void;
}) {
  const current = normalizeCloneGeneration(persona.generation);
  const [model, setModel] = useState(persona.models?.chat ?? null);
  const [draft, setDraft] = useState(() =>
    Object.fromEntries(CLONE_GENERATION_KEYS.map((key) => [key, String(current[key])])),
  );
  const [adaptive, setAdaptive] = useState(current.temperature === null);
  const [temperature, setTemperature] = useState(String(current.temperature ?? 0.8));
  const update = trpc.account.updateAgentLabPersona.useMutation();
  const showError = useDialog((s) => s.showError);
  const valid =
    !!model &&
    CLONE_GENERATION_KEYS.every((key) => {
      const rule = CLONE_GENERATION[key];
      const value = Number(draft[key]);
      return (
        draft[key]?.trim() && Number.isSafeInteger(value) && value >= rule.min && value <= rule.max
      );
    }) &&
    (adaptive ||
      (temperature.trim() !== '' &&
        Number.isFinite(Number(temperature)) &&
        Number(temperature) >= 0 &&
        Number(temperature) <= 2));
  const generation = Object.fromEntries(
    CLONE_GENERATION_KEYS.map((key) => [key, Number(draft[key])]),
  ) as Omit<AgentLabGenerationConfig, 'temperature'>;
  const guard = useCloneSettingsSection(
    'generation',
    { model, draft, adaptive, temperature },
    {
      ...(model ? { chatModel: model } : {}),
      generation: { ...generation, temperature: adaptive ? null : Number(temperature) },
    },
    valid,
    update.isLoading,
  );
  async function save() {
    if (!valid || !model || update.isLoading) return;
    try {
      const result = await update.mutateAsync({
        personaId: persona.id,
        chatModel: model,
        generation: { ...generation, temperature: adaptive ? null : Number(temperature) },
      });
      if (!result) throw new Error('克隆体已不存在');
      guard.reset({ model, draft, adaptive, temperature });
      onSaved();
    } catch (error) {
      showError('克隆设置保存失败', String(error));
    }
  }
  return (
    <div className="weq-set weq-clone-generation">
      <Row
        label="聊天 API 模型"
        desc="生成回复时会将本轮消息、所选历史与参考语料发送至该服务商。"
        control={
          <ApiModelSelect
            allowDefault
            required
            label="克隆聊天 API 模型"
            value={model}
            disabled={update.isLoading}
            onChange={(next) => {
              if (next) setModel(next);
            }}
          />
        }
      />
      <details className="weq-model-advanced">
        <summary>高级设置</summary>
        <div className="weq-clone-generation-fields">
          {CLONE_GENERATION_KEYS.map((key) => (
            <Row
              key={key}
              label={CLONE_GENERATION[key].label}
              desc={`${CLONE_GENERATION_HELP[key]} 默认 ${CLONE_GENERATION[key].default}；范围 ${CLONE_GENERATION[key].min}–${CLONE_GENERATION[key].max}。`}
              control={
                <input
                  className="weq-set-input"
                  type="number"
                  aria-label={CLONE_GENERATION[key].label}
                  min={CLONE_GENERATION[key].min}
                  max={CLONE_GENERATION[key].max}
                  step={1}
                  value={draft[key] ?? ''}
                  disabled={update.isLoading}
                  onChange={(event) =>
                    setDraft((value) => ({ ...value, [key]: event.target.value }))
                  }
                  style={{ width: 110 }}
                />
              }
            />
          ))}
          <Row
            label="温度随发言意愿调整"
            control={
              <Toggle
                label="自动调整克隆温度"
                checked={adaptive}
                disabled={update.isLoading}
                onChange={setAdaptive}
              />
            }
          />
          {!adaptive ? (
            <Row
              label="生成温度"
              control={
                <input
                  className="weq-set-input"
                  type="number"
                  aria-label="克隆生成温度"
                  min={0}
                  max={2}
                  step={0.1}
                  value={temperature}
                  disabled={update.isLoading}
                  onChange={(event) => setTemperature(event.target.value)}
                  style={{ width: 110 }}
                />
              }
            />
          ) : null}
        </div>
      </details>
      {!guard.managed ? (
        <Row
          label={null}
          control={
            <button
              type="button"
              className="weq-set-btn"
              disabled={!valid || update.isLoading}
              onClick={() => void save()}
            >
              <Save size={14} />
              保存
            </button>
          }
        />
      ) : null}
    </div>
  );
}
