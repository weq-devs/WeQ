import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { usePageSnapshotReset } from '../PageSnapshots';
import { Loader2, Plus, Play, Save, Trash2, Volume2, X } from 'lucide-react';
import { trpc, client } from '../../trpc/client';
import { useTabActive } from '../RetainedTabs';
import { Modal } from '../Dialog';
import { useAppDialog } from '../../lib/dialogUtils';
import { Card, QueryError, Row } from './controls';
import '../../styles/provider-settings.css';
import { useDraftClose } from '../../lib/draftClose';
import { providerDisplayLabels } from '../../lib/providerDisplayLabels';
import {
  connectionTestKey,
  runConnectionTest,
  useConnectionTestTasks,
} from '../../lib/connectionTestTask';
import { useToast } from '../Toast';

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── TTS 语音合成服务商（克隆体发语音 / 语音克隆用）──────────────────────────────

const TTS_VENDORS = [
  'openai-compatible',
  'gsv2p',
  'minimax',
  'mimo',
  'doubao',
  'gpt-sovits',
  'cosyvoice',
] as const;
type TtsVendorLocal = (typeof TTS_VENDORS)[number];

interface TtsForm {
  id: string;
  name: string;
  vendor: TtsVendorLocal;
  baseUrl: string;
  apiKey: string;
  appId: string;
  resourceId: string;
  model: string;
  cloneModel: string;
  voice: string;
  format: string;
  speed: string;
}

function emptyTtsForm(): TtsForm {
  return {
    id: crypto.randomUUID(),
    name: '',
    vendor: 'cosyvoice',
    baseUrl: '',
    apiKey: '',
    appId: '',
    resourceId: '',
    model: '',
    cloneModel: '',
    voice: '',
    format: '',
    speed: '',
  };
}

export function TtsProvidersCard(): ReactElement {
  const active = useTabActive();
  const dialog = useAppDialog();
  const utils = trpc.useUtils();
  const catalog = trpc.bootstrap.getTtsCatalog.useQuery(undefined, {
    enabled: active,
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
  const providers = trpc.bootstrap.listTtsProviders.useQuery(undefined, {
    enabled: active,
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const saveProvider = trpc.bootstrap.saveTtsProvider.useMutation();
  const providerLabels = providerDisplayLabels(providers.data ?? []);
  const deleteProvider = trpc.bootstrap.deleteTtsProvider.useMutation();

  const [selectedId, setSelectedId] = useState('');
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<TtsForm>(emptyTtsForm);
  const legacyOpen = usePageSnapshotReset('tts:open');
  const legacyForm = usePageSnapshotReset('tts:form');
  useEffect(() => {
    // 与 LLM 编辑器一致，旧页面草稿不再参与设置页的离开检查。
    legacyOpen.reset();
    legacyForm.reset();
  }, [legacyOpen, legacyForm]);
  const testKey = connectionTestKey('tts', form.id);
  const testing = useConnectionTestTasks((state) => state.running.has(testKey));
  const guard = useDraftClose(
    () => setOpen(false),
    form,
    saveProvider.isLoading || deleteProvider.isLoading,
  );

  /** 把已保存的 TTS 服务商数据填进表单。 */
  const fillFormFrom = useCallback(
    (item: {
      id: string;
      name: string;
      vendor: string;
      baseUrl: string;
      apiKey: string;
      appId?: string | null;
      resourceId?: string | null;
      model?: string | null;
      cloneModel?: string | null;
      voice?: string | null;
      format?: string | null;
      speed?: number | null;
    }) => {
      const next: TtsForm = {
        id: item.id,
        name: item.name,
        vendor: item.vendor as TtsVendorLocal,
        baseUrl: item.baseUrl,
        apiKey: item.apiKey,
        appId: item.appId ?? '',
        resourceId: item.resourceId ?? '',
        model: item.model ?? '',
        cloneModel: item.cloneModel ?? '',
        voice: item.voice ?? '',
        format: item.format ?? '',
        speed: item.speed !== undefined && item.speed !== null ? String(item.speed) : '',
      };
      setForm(next);
      guard.reset(next);
    },
    [guard.reset, setForm],
  );

  const vendorEntry = useMemo(
    () => catalog.data?.find((item) => item.vendor === form.vendor),
    [catalog.data, form.vendor],
  );
  const has = (field: keyof TtsForm): boolean =>
    vendorEntry ? vendorEntry.fields.some((item) => item === field) : form[field].trim().length > 0;

  function update<K extends keyof TtsForm>(key: K, value: TtsForm[K]): void {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function toggleCreate(): void {
    setSelectedId('');
    const next = emptyTtsForm();
    setForm(next);
    guard.reset(next);
    setOpen(true);
  }

  function editProvider(id: string): void {
    const current = providers.data?.find((item) => item.id === id);
    if (!current) return;
    fillFormFrom(current);
    setSelectedId(id);
    setOpen(true);
  }

  function applyVendor(vendor: string): void {
    const entry = catalog.data?.find((item) => item.vendor === vendor);
    setForm((current) => ({
      ...current,
      vendor: vendor as TtsVendorLocal,
      baseUrl: current.baseUrl.trim() || entry?.baseUrl || current.baseUrl,
      name: current.name.trim() || entry?.label?.replace(/（.*?）/g, '') || current.name,
    }));
  }

  /** 把表单收成 mutation 入参（含 server 端字段类型）。 */
  function toPayload(id: string) {
    const speed = form.speed.trim() ? Number(form.speed) : undefined;
    return {
      id,
      name: form.name.trim() || id,
      vendor: form.vendor,
      baseUrl: form.baseUrl.trim(),
      apiKey: form.apiKey.trim(),
      appId: form.appId.trim() || undefined,
      resourceId: form.resourceId.trim() || undefined,
      model: form.model.trim() || undefined,
      cloneModel: form.cloneModel.trim() || undefined,
      voice: form.voice.trim() || undefined,
      format: form.format.trim() || undefined,
      speed: speed !== undefined && Number.isFinite(speed) ? speed : undefined,
    };
  }

  async function onSave(): Promise<void> {
    // 同名语音服务商也使用独立 ID，编辑与重存保持现有克隆体引用。
    const id = form.id;
    if (!form.name.trim()) {
      dialog.error('保存失败', '请先填写显示名称。');
      return;
    }
    if (!form.baseUrl.trim()) {
      dialog.error('保存失败', '请填写服务地址（Base URL）。');
      return;
    }
    try {
      await saveProvider.mutateAsync(toPayload(id));
      guard.reset(form);
      setSelectedId(id);
      setOpen(true);
      await utils.bootstrap.listTtsProviders.invalidate();
      dialog.success('已保存', `TTS 服务商「${form.name.trim() || id}」已更新`);
    } catch (error) {
      dialog.error('保存失败', error instanceof Error ? error.message : String(error));
    }
  }

  async function onDelete(): Promise<void> {
    if (!selectedId) return;
    const ok = await dialog.confirm('删除 TTS 服务商', `确认删除「${selectedId}」？`, {
      okLabel: '删除',
      cancelLabel: '返回',
      tone: 'warning',
    });
    if (!ok) return;
    try {
      const removed = selectedId;
      await deleteProvider.mutateAsync({ id: selectedId });
      setSelectedId('');
      setForm(emptyTtsForm());
      setOpen(false);
      await utils.bootstrap.listTtsProviders.invalidate();
      dialog.success('已删除', `TTS 服务商「${removed}」已移除`);
    } catch (error) {
      dialog.error('删除失败', error instanceof Error ? error.message : String(error));
    }
  }

  function onTest(): void {
    if (!form.baseUrl.trim()) {
      useToast.getState().push({
        tone: 'warning',
        durationKind: 'success',
        title: '无法测试',
        detail: '请先填写服务地址（Base URL）。',
      });
      return;
    }
    const input = toPayload(form.id);
    const label = `${form.name.trim() || 'TTS'} · ${form.id.slice(-8)}`;
    void runConnectionTest(testKey, label, async () => {
      const res = await client.bootstrap.testTtsProvider.mutate(input);
      if (!res.ok) throw new Error(res.error ?? '未知错误');
      if (res.audioBase64) {
        const audio = new Audio(`data:audio/${res.format ?? 'mp3'};base64,${res.audioBase64}`);
        const play = () => {
          void audio.play().catch((error: unknown) => {
            useToast
              .getState()
              .push({ tone: 'warning', title: '样例语音播放失败', detail: errMsg(error) });
          });
        };
        play();
        return { detail: '已生成样例语音。', action: { label: '播放样例语音', run: play } };
      }
      return { detail: res.error ?? '配置可用。' };
    });
  }

  return (
    <>
      <Card
        title="TTS 语音合成"
        icon={<Volume2 size={15} strokeWidth={1.8} />}
        settingId="tts-providers"
        action={
          <button
            type="button"
            className="weq-set-btn weq-set-btn-soft weq-set-btn-sm"
            onClick={toggleCreate}
          >
            <Plus size={12} />
            新建
          </button>
        }
      >
        <p className="weq-set-desc">
          用于好友克隆的文字转语音与声音复刻；合成时会向所选服务商提交对应文本或参考语音。
        </p>
        {providers.error ? (
          <QueryError
            message={`TTS 配置读取失败：${providers.error.message}`}
            retryLabel="重新读取 TTS 配置"
            retrying={providers.isFetching}
            onRetry={() => void providers.refetch()}
          />
        ) : null}
        {providers.isLoading ? (
          <p className="weq-set-empty" role="status">
            正在读取 TTS 配置…
          </p>
        ) : (providers.data ?? []).length === 0 ? (
          providers.error ? null : (
            <div className="weq-set-row-desc" style={{ padding: '4px 2px' }}>
              暂无语音合成服务商。
            </div>
          )
        ) : (
          <div className="weq-agentlab-provider-list">
            {(providers.data ?? []).map((item) => {
              const entry = catalog.data?.find((c) => c.vendor === item.vendor);
              return (
                <button
                  key={item.id}
                  type="button"
                  title={providerLabels.get(item.id)}
                  className={`weq-agentlab-provider-item${open && selectedId === item.id ? ' is-active' : ''}`}
                  onClick={() => editProvider(item.id)}
                >
                  <span className="weq-agentlab-provider-name">
                    <Volume2
                      size={14}
                      strokeWidth={1.8}
                      aria-hidden
                      style={{ marginRight: 6, verticalAlign: '-2px', opacity: 0.7 }}
                    />
                    {providerLabels.get(item.id)}
                    {entry?.capabilities.clone ? (
                      <span className="weq-set-badge weq-set-badge-ok"> 可复刻</span>
                    ) : null}
                  </span>
                  <small>{entry?.label ?? item.vendor}</small>
                </button>
              );
            })}
          </div>
        )}
      </Card>

      {open ? (
        <Modal
          presentation="panel"
          onClose={guard.requestClose}
          width={620}
          className="weq-provider-window"
        >
          <div className="weq-provider-modal">
            <header className="weq-provider-modal-head">
              <span className="weq-provider-modal-icon">
                <Volume2 size={16} strokeWidth={1.8} aria-hidden />
              </span>
              <strong>{selectedId ? '编辑 TTS 服务商' : '新建 TTS 服务商'}</strong>
              <button
                type="button"
                className="weq-set-iconbtn weq-provider-modal-close"
                onClick={guard.requestClose}
                aria-label="关闭"
              >
                <X size={16} />
              </button>
            </header>

            <div className="weq-provider-modal-body">
              {catalog.error ? (
                <QueryError
                  message={`服务商模板读取失败：${catalog.error.message}`}
                  retryLabel="重新读取服务商模板"
                  retrying={catalog.isFetching}
                  onRetry={() => void catalog.refetch()}
                />
              ) : null}
              <Row
                label="服务商模板"
                desc={vendorEntry?.note}
                control={
                  <select
                    className="weq-set-input"
                    aria-label="TTS 服务商模板"
                    value={form.vendor}
                    disabled={catalog.isLoading}
                    onChange={(e) => applyVendor(e.target.value)}
                  >
                    {!catalog.data?.some((item) => item.vendor === form.vendor) ? (
                      <option value={form.vendor}>{form.vendor}</option>
                    ) : null}
                    {(catalog.data ?? []).map((item) => (
                      <option key={item.vendor} value={item.vendor}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                }
              />
              <Row
                label="显示名称"
                control={
                  <input
                    className="weq-set-input"
                    value={form.name}
                    onChange={(e) => update('name', e.target.value)}
                    placeholder="CosyVoice"
                  />
                }
              />
              <Row
                label="服务地址 (Base URL)"
                desc={vendorEntry ? `模板默认：${vendorEntry.baseUrl}` : undefined}
                control={
                  <input
                    className="weq-set-input"
                    value={form.baseUrl}
                    onChange={(e) => update('baseUrl', e.target.value)}
                    placeholder="https://..."
                  />
                }
              />
              {has('apiKey') ? (
                <Row
                  label="API Key"
                  desc={vendorEntry?.apiKeyHint}
                  control={
                    <input
                      className="weq-set-input"
                      type="password"
                      value={form.apiKey}
                      onChange={(e) => update('apiKey', e.target.value)}
                      placeholder="sk-..."
                    />
                  }
                />
              ) : null}
              {has('appId') ? (
                <Row
                  label="App ID"
                  desc="豆包 X-Api-App-Id"
                  control={
                    <input
                      className="weq-set-input"
                      value={form.appId}
                      onChange={(e) => update('appId', e.target.value)}
                    />
                  }
                />
              ) : null}
              {has('resourceId') ? (
                <Row
                  label="Resource ID"
                  desc="豆包 X-Api-Resource-Id（如 seed-tts-2.0）"
                  control={
                    <input
                      className="weq-set-input"
                      value={form.resourceId}
                      onChange={(e) => update('resourceId', e.target.value)}
                      placeholder="seed-tts-2.0"
                    />
                  }
                />
              ) : null}
              {has('model') ? (
                <Row
                  label={has('cloneModel') ? '固定音色模型' : '模型'}
                  desc={
                    vendorEntry?.defaultModel
                      ? `留空自动用默认：${vendorEntry.defaultModel}`
                      : undefined
                  }
                  control={
                    <input
                      className="weq-set-input"
                      value={form.model}
                      onChange={(e) => update('model', e.target.value)}
                      placeholder={vendorEntry?.defaultModel ?? '服务商模型 id（可空用默认）'}
                    />
                  }
                />
              ) : null}
              {has('cloneModel') ? (
                <Row
                  label="复刻模型"
                  desc={
                    vendorEntry?.cloneModel
                      ? `语音克隆专用模型，与固定音色模型不同；留空自动用默认：${vendorEntry.cloneModel}`
                      : '语音克隆专用模型（可空用默认）'
                  }
                  control={
                    <input
                      className="weq-set-input"
                      value={form.cloneModel}
                      onChange={(e) => update('cloneModel', e.target.value)}
                      placeholder={vendorEntry?.cloneModel ?? '复刻模型 id（可空用默认）'}
                    />
                  }
                />
              ) : null}
              {has('voice') ? (
                <Row
                  label="默认音色"
                  desc={
                    vendorEntry?.presetVoices?.length
                      ? `如：${vendorEntry.presetVoices.map((v) => v.id).join('、')}`
                      : '预置音色 id（preset 模式用）'
                  }
                  control={
                    <input
                      className="weq-set-input"
                      value={form.voice}
                      onChange={(e) => update('voice', e.target.value)}
                      placeholder="voice id"
                    />
                  }
                />
              ) : null}
              {has('format') ? (
                <Row
                  label="音频格式"
                  control={
                    <SegmentedControl
                      label="TTS 音频格式"
                      value={form.format}
                      onChange={(value) => update('format', value)}
                      options={[
                        { value: '', label: '默认' },
                        { value: 'mp3', label: 'MP3' },
                        { value: 'wav', label: 'WAV' },
                      ]}
                    />
                  }
                />
              ) : null}
              {has('speed') ? (
                <Row
                  label="语速"
                  desc="1.0 为常态，留空用默认。"
                  control={
                    <input
                      className="weq-set-input"
                      value={form.speed}
                      onChange={(e) => update('speed', e.target.value)}
                      placeholder="1.0"
                    />
                  }
                />
              ) : null}
              {vendorEntry?.capabilities.clone ? (
                <p className="weq-set-note">
                  <Volume2 size={12} style={{ verticalAlign: '-2px', marginRight: 4 }} />
                  这是语音克隆型服务商：在克隆体的「语音」设置里开启语音克隆后，会自动用 TA
                  的真实语音作参考音频。此处「测试」仅校验连通性。
                </p>
              ) : null}
            </div>

            <div className="weq-provider-modal-actions">
              <button
                type="button"
                className="weq-set-btn"
                onClick={() => void onSave()}
                disabled={saveProvider.isLoading}
              >
                <Save size={14} />
                保存
              </button>
              <button
                type="button"
                className="weq-set-btn weq-set-btn-soft"
                onClick={() => void onTest()}
                disabled={testing}
              >
                {testing ? <Loader2 size={14} className="weq-spin" /> : <Play size={14} />}
                测试
              </button>
              <button
                type="button"
                className="weq-set-btn weq-set-btn-soft"
                onClick={() => void onDelete()}
                disabled={!selectedId || deleteProvider.isLoading}
              >
                <Trash2 size={14} />
                删除
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
import { SegmentedControl } from '../SegmentedControl';
