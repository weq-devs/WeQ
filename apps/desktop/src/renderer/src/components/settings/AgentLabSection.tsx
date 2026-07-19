import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { Boxes, FlaskConical, Loader2, Plus, Save, Server, Sparkles, Trash2, X } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { useAppDialog } from '../../lib/dialogUtils';
import { Card, CheckPill, Row, SectionHeader } from './controls';

type Capability = 'chat' | 'embedding' | 'vision';
const CAPABILITIES: { value: Capability; label: string }[] = [
  { value: 'chat', label: '聊天' },
  { value: 'embedding', label: '向量' },
  { value: 'vision', label: '视觉' },
];

type ModelForm = { id: string; label: string; capabilities: Capability[] };
type ProviderForm = {
  id: string;
  name: string;
  vendor: string;
  baseUrl: string;
  apiKey: string;
  models: ModelForm[];
};

function emptyForm(): ProviderForm {
  return { id: '', name: '', vendor: 'siliconflow', baseUrl: '', apiKey: '', models: [] };
}

function normalizeId(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function AgentLabSection(): ReactElement {
  const dialog = useAppDialog();
  const utils = trpc.useUtils();
  const catalog = trpc.bootstrap.getAgentLabCatalog.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
  const providers = trpc.bootstrap.listAgentLabProviders.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const saveProvider = trpc.bootstrap.saveAgentLabProvider.useMutation();
  const deleteProvider = trpc.bootstrap.deleteAgentLabProvider.useMutation();
  const testProvider = trpc.bootstrap.testAgentLabProvider.useMutation();

  const [selectedId, setSelectedId] = useState<string>('');
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<ProviderForm>(emptyForm);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    const current = providers.data?.find((item) => item.id === selectedId);
    if (current) {
      setForm({
        id: current.id,
        name: current.name,
        vendor: current.vendor,
        baseUrl: current.baseUrl,
        apiKey: current.apiKey,
        models: current.models.map((m) => ({
          id: m.id,
          label: m.label ?? '',
          capabilities: m.capabilities as Capability[],
        })),
      });
    }
  }, [providers.data, selectedId]);

  const vendorEntry = useMemo(
    () => catalog.data?.find((item) => item.vendor === form.vendor),
    [catalog.data, form.vendor],
  );

  function update<K extends keyof ProviderForm>(key: K, value: ProviderForm[K]): void {
    setForm((current) => ({ ...current, [key]: value }));
  }

  /** 点「新建」：正在新建则收回，否则展开一个空表单。 */
  function toggleCreate(): void {
    if (editing && !selectedId) {
      setEditing(false);
      return;
    }
    setSelectedId('');
    setForm(emptyForm());
    setEditing(true);
  }

  /** 点已有 provider：进入编辑（再点同一个则收回）。 */
  function editProvider(id: string): void {
    if (editing && selectedId === id) {
      setEditing(false);
      return;
    }
    setSelectedId(id);
    setEditing(true);
  }

  function mergeTemplateModels(currentModels: ModelForm[], vendor: string): ModelForm[] {
    const entry = catalog.data?.find((item) => item.vendor === vendor);
    if (!entry?.models.length) return currentModels;
    const seen = new Set(currentModels.map((m) => m.id));
    const extra = entry.models
      .filter((m) => !seen.has(m.id))
      .map((m) => ({ id: m.id, label: m.label ?? '', capabilities: m.capabilities as Capability[] }));
    return extra.length > 0 ? [...currentModels, ...extra] : currentModels;
  }

  function applyVendor(vendor: string): void {
    const entry = catalog.data?.find((item) => item.vendor === vendor);
    setForm((current) => ({
      ...current,
      vendor,
      baseUrl: current.baseUrl.trim() || entry?.baseUrl || current.baseUrl,
      name: current.name.trim() || entry?.label?.replace(/（.*?）/g, '') || current.name,
      models: mergeTemplateModels(current.models, vendor),
    }));
  }

  function importTemplateModels(): void {
    setForm((current) => ({
      ...current,
      models: mergeTemplateModels(current.models, form.vendor),
    }));
  }

  /** 模板中有多少个模型尚未添加（用于按钮 badge）。 */
  const newModelCount = useMemo(() => {
    const entry = catalog.data?.find((item) => item.vendor === form.vendor);
    if (!entry?.models.length) return 0;
    const seen = new Set(form.models.map((m) => m.id));
    return entry.models.filter((m) => !seen.has(m.id)).length;
  }, [catalog.data, form.vendor, form.models]);

  function addModel(): void {
    setForm((c) => ({ ...c, models: [...c.models, { id: '', label: '', capabilities: ['chat'] }] }));
  }
  function removeModel(index: number): void {
    setForm((c) => ({ ...c, models: c.models.filter((_, i) => i !== index) }));
  }
  function updateModel(index: number, patch: Partial<ModelForm>): void {
    setForm((c) => ({
      ...c,
      models: c.models.map((m, i) => (i === index ? { ...m, ...patch } : m)),
    }));
  }
  function toggleCap(index: number, cap: Capability): void {
    setForm((c) => ({
      ...c,
      models: c.models.map((m, i) => {
        if (i !== index) return m;
        const has = m.capabilities.includes(cap);
        return {
          ...m,
          capabilities: has ? m.capabilities.filter((x) => x !== cap) : [...m.capabilities, cap],
        };
      }),
    }));
  }

  async function onSave(): Promise<void> {
    const id = normalizeId(form.id || form.name);
    if (!id) {
      dialog.error('保存失败', '请先填写 provider id 或名称。');
      return;
    }
    const models = form.models
      .map((m) => ({ id: m.id.trim(), label: m.label.trim() || undefined, capabilities: m.capabilities }))
      .filter((m) => m.id);
    if (models.length === 0) {
      dialog.error('保存失败', '至少配置一个模型（可点「导入模板推荐」）。');
      return;
    }
    try {
      await saveProvider.mutateAsync({
        id,
        name: form.name.trim() || id,
        vendor: form.vendor,
        baseUrl: form.baseUrl.trim(),
        apiKey: form.apiKey.trim(),
        models,
      });
      setSelectedId(id);
      setEditing(true);
      await utils.bootstrap.listAgentLabProviders.invalidate();
      dialog.success('已保存', `provider「${form.name.trim() || id}」配置已更新`);
    } catch (error) {
      dialog.error('保存 provider 失败', error instanceof Error ? error.message : String(error));
    }
  }

  /** 测试连通性：用表单里第一个带「聊天」能力的模型探活，把详细错误（状态码/响应体）展示出来。 */
  async function onTest(): Promise<void> {
    if (!form.baseUrl.trim()) {
      dialog.error('无法测试', '请先填写 Base URL。');
      return;
    }
    const chatModel = form.models.find((m) => m.capabilities.includes('chat') && m.id.trim())?.id.trim();
    if (!chatModel) {
      dialog.error('无法测试', '请先添加并填写一个带「聊天」能力的模型。');
      return;
    }
    setTesting(true);
    try {
      const res = await testProvider.mutateAsync({
        baseUrl: form.baseUrl.trim(),
        apiKey: form.apiKey.trim(),
        model: chatModel,
      });
      if (res.ok) {
        dialog.success('测试通过', `模型「${chatModel}」可正常调用${res.reply ? `，回了：${res.reply}` : '。'}`);
      } else {
        dialog.error('测试失败', res.error ?? '未知错误');
      }
    } catch (error) {
      dialog.error('测试失败', error instanceof Error ? error.message : String(error));
    } finally {
      setTesting(false);
    }
  }

  async function onDelete(): Promise<void> {
    if (!selectedId) return;
    const ok = await dialog.confirm('删除 provider', `确认删除「${selectedId}」？`, {
      okLabel: '删除',
      cancelLabel: '返回',
      tone: 'warning',
    });
    if (!ok) return;
    try {
      const removed = selectedId;
      await deleteProvider.mutateAsync({ id: selectedId });
      setSelectedId('');
      setForm(emptyForm());
      setEditing(false);
      await utils.bootstrap.listAgentLabProviders.invalidate();
      dialog.success('已删除', `provider「${removed}」已移除`);
    } catch (error) {
      dialog.error('删除 provider 失败', error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div className="weq-set">
      <SectionHeader
        icon={<Boxes size={18} strokeWidth={1.8} />}
        title="模型服务商（Provider）"
        desc="只在这里配置厂商（base_url + api_key + 可用模型）。具体用哪个模型，在克隆体里按任务选择。推荐硅基流动：一个 key 覆盖聊天 / 向量 / 视觉。"
      />

      <Card
        title="已保存的 provider"
        action={
          <button
            type="button"
            className="weq-set-btn weq-set-btn-soft weq-set-btn-sm"
            onClick={toggleCreate}
          >
            <Plus size={12} />
            {editing && !selectedId ? '收起' : '新建'}
          </button>
        }
      >
        {(providers.data ?? []).length === 0 ? (
          <div className="weq-set-row-desc" style={{ padding: '4px 2px' }}>
            还没有 provider，点右上角「新建」添加一个厂商。
          </div>
        ) : (
          <div className="weq-agentlab-provider-list">
            {(providers.data ?? []).map((item) => (
              <button
                key={item.id}
                type="button"
                className={`weq-agentlab-provider-item${editing && selectedId === item.id ? ' is-active' : ''}`}
                onClick={() => editProvider(item.id)}
              >
                <span className="weq-agentlab-provider-name">
                  <Server size={14} strokeWidth={1.8} aria-hidden style={{ marginRight: 6, verticalAlign: '-2px', opacity: 0.7 }} />
                  {item.name}
                </span>
                <small>{item.models.length} 个模型 · {item.baseUrl}</small>
              </button>
            ))}
          </div>
        )}
      </Card>

      {editing ? (
      <Card title={selectedId ? '编辑 provider' : '新建 provider'}>
        <Row
          label="厂商模板"
          desc="选模板自动带入 base_url 与推荐模型。"
          control={
            <select
              className="weq-set-input"
              value={form.vendor}
              onChange={(e) => applyVendor(e.target.value)}
            >
              {(catalog.data ?? []).map((item) => (
                <option key={item.vendor} value={item.vendor}>
                  {item.label}
                </option>
              ))}
            </select>
          }
        />
        <Row
          label="Provider ID"
          desc="稳定标识。留空时默认用名称自动生成。"
          control={<input className="weq-set-input" value={form.id} onChange={(e) => update('id', e.target.value)} placeholder="siliconflow-main" />}
        />
        <Row
          label="显示名称"
          control={<input className="weq-set-input" value={form.name} onChange={(e) => update('name', e.target.value)} placeholder="硅基流动" />}
        />
        <Row
          label="Base URL"
          desc={vendorEntry ? `模板默认：${vendorEntry.baseUrl || '（自定义）'}` : 'OpenAI 兼容接口根路径'}
          control={<input className="weq-set-input" value={form.baseUrl} onChange={(e) => update('baseUrl', e.target.value)} placeholder="https://api.siliconflow.cn/v1" />}
        />
        <Row
          label="API Key"
          desc={vendorEntry?.apiKeyHint}
          control={<input className="weq-set-input" type="password" value={form.apiKey} onChange={(e) => update('apiKey', e.target.value)} placeholder="sk-..." />}
        />

        <div className="weq-set-card-head" style={{ marginTop: 8 }}>
          <div className="weq-set-card-title">可用模型</div>
          <div className="weq-set-card-action" style={{ display: 'flex', gap: 6 }}>
            <button type="button" className="weq-set-btn weq-set-btn-soft weq-set-btn-sm" onClick={importTemplateModels} disabled={!vendorEntry?.models.length}>
              <Sparkles size={12} /> 导入模板推荐{newModelCount > 0 ? ` (${newModelCount})` : ''}
            </button>
            <button type="button" className="weq-set-btn weq-set-btn-soft weq-set-btn-sm" onClick={addModel}>
              <Plus size={12} /> 手动添加
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {form.models.length === 0 ? (
            <div className="weq-set-row-desc" style={{ padding: '6px 0' }}>还没有模型，点上方按钮添加。</div>
          ) : (
            form.models.map((model, index) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: 列表按位置渲染,无稳定唯一键
                key={index}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  flexWrap: 'wrap',
                  padding: '8px 10px',
                  borderRadius: 8,
                  background: 'rgba(127,127,127,0.07)',
                }}
              >
                <input
                  className="weq-set-input"
                  style={{ flex: '1 1 200px' }}
                  value={model.id}
                  onChange={(e) => updateModel(index, { id: e.target.value })}
                  placeholder="模型 id，如 deepseek-ai/DeepSeek-V3"
                />
                <div style={{ display: 'flex', gap: 4 }}>
                  {CAPABILITIES.map((cap) => (
                    <CheckPill
                      key={cap.value}
                      checked={model.capabilities.includes(cap.value)}
                      onChange={() => toggleCap(index, cap.value)}
                    >
                      {cap.label}
                    </CheckPill>
                  ))}
                </div>
                <button type="button" className="weq-set-btn weq-set-btn-soft weq-set-btn-sm" onClick={() => removeModel(index)}>
                  <X size={12} />
                </button>
              </div>
            ))
          )}
        </div>

        <div className="weq-set-actions">
          <button type="button" className="weq-set-btn" onClick={() => void onSave()} disabled={saveProvider.isLoading}>
            <Save size={14} />
            保存 provider
          </button>
          <button type="button" className="weq-set-btn weq-set-btn-soft" onClick={() => void onTest()} disabled={testing}>
            {testing ? <Loader2 size={14} className="weq-spin" /> : <FlaskConical size={14} />}
            测试连通性
          </button>
          <button type="button" className="weq-set-btn weq-set-btn-soft" onClick={() => void onDelete()} disabled={!selectedId || deleteProvider.isLoading}>
            <Trash2 size={14} />
            删除
          </button>
        </div>
      </Card>
      ) : null}
    </div>
  );
}
