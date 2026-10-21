import { useState } from 'react';
import { Settings2, Save, Users } from 'lucide-react';
import type { AgentLabPersona } from '@weq/agentlab';
import {
  CLONE_GENERATION,
  CLONE_GENERATION_HELP,
  CLONE_GENERATION_KEYS,
  normalizeCloneGeneration,
  type AgentLabGenerationConfig,
} from '@weq/agentlab/generation';
import { trpc } from '../../trpc/client';
import { Card, Row, SectionHeader, Toggle } from './controls';
import { ApiModelSelect } from './ApiModelSelect';
import { PersonaSettingsModal } from '../../views/agentlab/PersonaSettingsModal';
import { useDraftProtection } from '../../lib/draftClose';
import { useDialog } from '../Dialog';
import '../../styles/model-settings.css';

function CloneGenerationPanel({
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
  const guard = useDraftProtection({ model, draft, adaptive, temperature }, update.isLoading);
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
  async function save() {
    if (!valid || !model || update.isLoading) return;
    try {
      const generation = Object.fromEntries(
        CLONE_GENERATION_KEYS.map((key) => [key, Number(draft[key])]),
      ) as Omit<AgentLabGenerationConfig, 'temperature'>;
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
    <div className="weq-set">
      <Row
        label="聊天 API 模型"
        desc="生成回复时会将本轮消息、所选历史与参考语料发送至该服务商。"
        control={
          <ApiModelSelect
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
        <Row
          label="训练检索模型"
          control={<span>{persona.models?.embedding?.model ?? '未使用'}</span>}
        />
        <Row
          label="训练视觉模型"
          control={<span>{persona.models?.vision?.model ?? '未使用'}</span>}
        />
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
                onChange={(event) => setDraft((value) => ({ ...value, [key]: event.target.value }))}
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
      </details>
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
    </div>
  );
}

export function CloneSettingsSection() {
  const utils = trpc.useUtils();
  const personas = trpc.account.listAgentLabPersonas.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const [selected, setSelected] = useState('');
  const [open, setOpen] = useState(false);
  const list = personas.data ?? [];
  const persona = list.find((item) => item.id === selected) ?? list[0];
  const saved = () => {
    void utils.account.listAgentLabPersonas.invalidate();
    void utils.account.getAgentLabPersonaDetail.invalidate();
  };
  return (
    <div className="weq-set">
      <SectionHeader title="好友克隆" icon={<Users size={18} />} />
      <Card title="克隆体配置">
        {personas.error ? <p role="alert">{personas.error.message}</p> : null}
        {list.length === 0 ? (
          <div className="weq-set-empty">{personas.isLoading ? '加载中…' : '暂无好友克隆'}</div>
        ) : (
          <>
            <Row
              label="克隆体"
              control={
                <select
                  className="weq-set-input"
                  aria-label="设置好友克隆"
                  value={persona?.id ?? ''}
                  onChange={(event) => setSelected(event.target.value)}
                >
                  {list.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              }
            />
            <Row
              label="模型、提示、发言意愿与语音"
              control={
                <button
                  type="button"
                  className="weq-set-btn"
                  onClick={() => setOpen(true)}
                  disabled={!persona}
                >
                  <Settings2 size={14} />
                  配置
                </button>
              }
            />
          </>
        )}
      </Card>
      {open && persona ? (
        <PersonaSettingsModal
          key={persona.id}
          persona={persona}
          paramsTitle="模型与生成"
          paramsContent={<CloneGenerationPanel persona={persona} onSaved={saved} />}
          onClose={() => setOpen(false)}
          onSaved={saved}
        />
      ) : null}
    </div>
  );
}
