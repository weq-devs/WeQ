/**
 * 设置 → 语音转录.
 *
 * Account-independent: downloads & selects the offline transcription model used
 * by the chat 转文字 feature. The selected model id lives in the global config
 * (`bootstrap.getSettings().voiceTranscribe.modelId`); empty = feature off.
 *
 * Download progress arrives over the `onVoiceModelProgress` subscription (one
 * shared stream for all models, keyed by model id). The model registry +
 * on-disk status come from `bootstrap.voiceModels`.
 *
 * Freshness: like the other settings panels, queries use `staleTime: 0` +
 * `refetchOnMount: 'always'` so reopening the dialog always shows fresh state.
 */

import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { AudioLines, Check, Download, Loader2, Plus, Play, Save, Trash2, Volume2 } from 'lucide-react';
import { trpc, client } from '../../trpc/client';
import { useDialog } from '../Dialog';
import { useAppDialog } from '../../lib/dialogUtils';
import { Card, Row, SectionHeader } from './controls';

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Bytes → "x.x MB". */
function fmtBytes(bytes: number): string {
  if (!bytes) return '0 MB';
  const mb = bytes / 1024 / 1024;
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`;
}

/** Bytes/sec → "x.x MB/s". */
function fmtSpeed(bps: number): string {
  if (!bps || bps <= 0) return '';
  const mb = bps / 1024 / 1024;
  if (mb >= 1) return `${mb.toFixed(1)} MB/s`;
  return `${(bps / 1024).toFixed(0)} KB/s`;
}

/** Live progress for the model currently downloading (null when idle). */
interface LiveProgress {
  id: string;
  percent: number;
  downloadedBytes: number;
  totalBytes: number;
  speed: number;
}

export function VoiceTranscribeSection(): ReactElement {
  const showError = useDialog((s) => s.showError);

  const models = trpc.bootstrap.voiceModels.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const settings = trpc.bootstrap.getSettings.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });

  const download = trpc.bootstrap.downloadVoiceModel.useMutation();
  const remove = trpc.bootstrap.deleteVoiceModel.useMutation();
  const setModel = trpc.bootstrap.setVoiceModel.useMutation();

  const [progress, setProgress] = useState<LiveProgress | null>(null);

  // Subscribe to download progress (shared stream). On the terminal event
  // (done/error) clear the bar and refresh the model list.
  useEffect(() => {
    const sub = client.bootstrap.onVoiceModelProgress.subscribe(undefined, {
      onData: (p) => {
        if (p.error) {
          setProgress(null);
          void models.refetch();
          showError('模型下载失败', p.error);
          return;
        }
        if (p.done) {
          setProgress(null);
          void models.refetch();
          return;
        }
        setProgress({
          id: p.id,
          percent: p.percent,
          downloadedBytes: p.downloadedBytes,
          totalBytes: p.totalBytes,
          speed: p.speed,
        });
      },
      onError: (err) => console.error('[voice] progress subscription error', err),
    });
    return () => sub.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedId = settings.data?.voiceTranscribe.modelId ?? '';

  async function onDownload(id: string): Promise<void> {
    try {
      setProgress({ id, percent: 0, downloadedBytes: 0, totalBytes: 0, speed: 0 });
      await download.mutateAsync({ id });
    } catch (e) {
      setProgress(null);
      showError('启动下载失败', errMsg(e));
    }
  }

  async function onDelete(id: string): Promise<void> {
    try {
      await remove.mutateAsync({ id });
      // If the deleted model was selected, clear the selection too.
      if (selectedId === id) await setModel.mutateAsync({ modelId: '' });
      await models.refetch();
      await settings.refetch();
    } catch (e) {
      showError('删除模型失败', errMsg(e));
    }
  }

  async function onSelect(id: string): Promise<void> {
    try {
      // Toggle off if already selected.
      await setModel.mutateAsync({ modelId: selectedId === id ? '' : id });
      await settings.refetch();
    } catch (e) {
      showError('设置当前模型失败', errMsg(e));
    }
  }

  const modelList = models.data ?? [];

  return (
    <div className="weq-set">
      <SectionHeader
        icon={<AudioLines size={18} strokeWidth={1.8} />}
        title="语音转录"
        desc="下载并选择离线语音识别模型。选中后，聊天中的语音消息将出现「转文字」按钮。"
      />

      <Card title="转录模型">
        {modelList.length === 0 ? (
          <div className="weq-set-empty">{models.isLoading ? '加载中…' : '暂无可用模型'}</div>
        ) : (
          <div className="weq-voice-models">
            {modelList.map((m) => {
              const isSelected = selectedId === m.id;
              const isDownloading = progress?.id === m.id;
              const pct = isDownloading ? Math.round(progress!.percent) : 0;
              return (
                <div key={m.id} className={`weq-voice-model${isSelected ? ' is-selected' : ''}`}>
                  <div className="weq-voice-model-icon">
                    <AudioLines size={18} strokeWidth={1.8} aria-hidden />
                  </div>
                  <div className="weq-voice-model-main">
                    <div className="weq-voice-model-head">
                      <span className="weq-voice-model-name">{m.name}</span>
                      {m.recommended ? <span className="weq-set-badge weq-set-badge-ok">推荐</span> : null}
                      {m.downloaded ? <span className="weq-set-badge">已下载</span> : null}
                      {isSelected ? <span className="weq-set-badge weq-set-badge-ok">当前模型</span> : null}
                    </div>
                    <span className="weq-voice-model-desc">{m.desc}</span>
                    <span className="weq-voice-model-size weq-number">
                      {m.downloaded ? `占用 ${fmtBytes(m.sizeOnDisk)}` : `约 ${m.sizeLabel}`}
                    </span>

                    {isDownloading ? (
                      <div className="weq-set-progress">
                        <div className="weq-set-progress-track">
                          <div className="weq-set-progress-fill" style={{ width: `${pct}%` }} />
                        </div>
                        <div className="weq-set-progress-meta weq-number">
                          <span>{pct}%</span>
                          <span>
                            {fmtBytes(progress!.downloadedBytes)} / {fmtBytes(progress!.totalBytes)}
                            {progress!.speed > 0 ? ` · ${fmtSpeed(progress!.speed)}` : ''}
                          </span>
                        </div>
                      </div>
                    ) : null}
                  </div>

                  <div className="weq-voice-model-actions">
                    {m.downloaded ? (
                      <>
                        <button
                          type="button"
                          className={`weq-set-btn weq-set-btn-sm${isSelected ? ' weq-set-btn-soft' : ''}`}
                          onClick={() => void onSelect(m.id)}
                          disabled={setModel.isLoading}
                        >
                          <Check size={12} strokeWidth={2} aria-hidden />
                          {isSelected ? '取消选用' : '设为当前'}
                        </button>
                        <button
                          type="button"
                          className="weq-set-btn weq-set-btn-soft weq-set-btn-sm"
                          onClick={() => void onDelete(m.id)}
                          disabled={remove.isLoading || isDownloading}
                          title="删除模型"
                          aria-label="删除模型"
                        >
                          <Trash2 size={12} strokeWidth={1.8} aria-hidden />
                        </button>
                      </>
                    ) : isDownloading ? (
                      <button type="button" className="weq-set-btn weq-set-btn-sm" disabled>
                        <Loader2 size={12} strokeWidth={2} className="weq-spin" aria-hidden />
                        下载中
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="weq-set-btn weq-set-btn-sm"
                        onClick={() => void onDownload(m.id)}
                        disabled={Boolean(progress)}
                      >
                        <Download size={12} strokeWidth={1.8} aria-hidden />
                        下载
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <p className="weq-set-note">
          模型文件较大，请在网络良好时下载。模型保存在本地，删除「账号缓存」不会影响它。
        </p>
      </Card>

      <TtsProvidersCard />
    </div>
  );
}

// ── TTS 语音合成服务商（克隆体发语音 / 语音克隆用）──────────────────────────────

const TTS_VENDORS = ['openai-compatible', 'gsv2p', 'minimax', 'mimo', 'doubao', 'gpt-sovits', 'cosyvoice'] as const;
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
    id: '',
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

function normalizeId(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function TtsProvidersCard(): ReactElement {
  const dialog = useAppDialog();
  const utils = trpc.useUtils();
  const catalog = trpc.bootstrap.getTtsCatalog.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
  const providers = trpc.bootstrap.listTtsProviders.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const saveProvider = trpc.bootstrap.saveTtsProvider.useMutation();
  const deleteProvider = trpc.bootstrap.deleteTtsProvider.useMutation();
  const testProvider = trpc.bootstrap.testTtsProvider.useMutation();

  const [selectedId, setSelectedId] = useState<string>('');
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<TtsForm>(emptyTtsForm);
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
        appId: current.appId ?? '',
        resourceId: current.resourceId ?? '',
        model: current.model ?? '',
        cloneModel: current.cloneModel ?? '',
        voice: current.voice ?? '',
        format: current.format ?? '',
        speed: current.speed !== undefined ? String(current.speed) : '',
      });
    }
  }, [providers.data, selectedId]);

  const vendorEntry = useMemo(
    () => catalog.data?.find((item) => item.vendor === form.vendor),
    [catalog.data, form.vendor],
  );
  const has = (field: string): boolean => vendorEntry?.fields.includes(field as never) ?? false;

  function update<K extends keyof TtsForm>(key: K, value: TtsForm[K]): void {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function toggleCreate(): void {
    if (editing && !selectedId) {
      setEditing(false);
      return;
    }
    setSelectedId('');
    setForm(emptyTtsForm());
    setEditing(true);
  }

  function editProvider(id: string): void {
    if (editing && selectedId === id) {
      setEditing(false);
      return;
    }
    setSelectedId(id);
    setEditing(true);
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
    const id = normalizeId(form.id || form.name);
    if (!id) {
      dialog.error('保存失败', '请先填写服务商 id 或名称。');
      return;
    }
    if (!form.baseUrl.trim()) {
      dialog.error('保存失败', '请填写服务地址（Base URL）。');
      return;
    }
    try {
      await saveProvider.mutateAsync(toPayload(id));
      setSelectedId(id);
      setEditing(true);
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
      setEditing(false);
      await utils.bootstrap.listTtsProviders.invalidate();
      dialog.success('已删除', `TTS 服务商「${removed}」已移除`);
    } catch (error) {
      dialog.error('删除失败', error instanceof Error ? error.message : String(error));
    }
  }

  async function onTest(): Promise<void> {
    if (!form.baseUrl.trim()) {
      dialog.error('无法测试', '请先填写服务地址（Base URL）。');
      return;
    }
    setTesting(true);
    try {
      const res = await testProvider.mutateAsync(toPayload(normalizeId(form.id || form.name) || 'test'));
      if (!res.ok) {
        dialog.error('测试失败', res.error ?? '未知错误');
        return;
      }
      if (res.audioBase64) {
        const audio = new Audio(`data:audio/${res.format ?? 'mp3'};base64,${res.audioBase64}`);
        void audio.play().catch(() => {});
        dialog.success('测试成功', '已生成样例语音，正在播放。');
      } else {
        dialog.success('测试通过', res.error ?? '配置可用。');
      }
    } catch (error) {
      dialog.error('测试失败', error instanceof Error ? error.message : String(error));
    } finally {
      setTesting(false);
    }
  }

  return (
    <>
      <SectionHeader
        icon={<Volume2 size={18} strokeWidth={1.8} />}
        title="TTS 语音合成"
        desc="配置文字转语音服务商。配好后，克隆体（好友克隆）才能发语音；支持复刻的厂商（CosyVoice / GPT-SoVITS）可用 TA 本人的声音说话。"
      />
      <Card
        title="已保存的 TTS 服务商"
        action={
          <button type="button" className="weq-set-btn weq-set-btn-soft weq-set-btn-sm" onClick={toggleCreate}>
            <Plus size={12} />
            {editing && !selectedId ? '收起' : '新建'}
          </button>
        }
      >
        {(providers.data ?? []).length === 0 ? (
          <div className="weq-set-row-desc" style={{ padding: '4px 2px' }}>
            还没有 TTS 服务商，点右上角「新建」添加一个。推荐 CosyVoice（免费、可复刻）。
          </div>
        ) : (
          <div className="weq-agentlab-provider-list">
            {(providers.data ?? []).map((item) => {
              const entry = catalog.data?.find((c) => c.vendor === item.vendor);
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`weq-agentlab-provider-item${editing && selectedId === item.id ? ' is-active' : ''}`}
                  onClick={() => editProvider(item.id)}
                >
                  <span className="weq-agentlab-provider-name">
                    <Volume2 size={14} strokeWidth={1.8} aria-hidden style={{ marginRight: 6, verticalAlign: '-2px', opacity: 0.7 }} />
                    {item.name}
                    {entry?.capabilities.clone ? <span className="weq-set-badge weq-set-badge-ok"> 可复刻</span> : null}
                  </span>
                  <small>{entry?.label ?? item.vendor}</small>
                </button>
              );
            })}
          </div>
        )}
      </Card>

      {editing ? (
        <Card title={selectedId ? '编辑 TTS 服务商' : '新建 TTS 服务商'}>
          <Row
            label="厂商模板"
            desc={vendorEntry?.note}
            control={
              <select className="weq-set-input" value={form.vendor} onChange={(e) => applyVendor(e.target.value)}>
                {(catalog.data ?? []).map((item) => (
                  <option key={item.vendor} value={item.vendor}>
                    {item.label}
                  </option>
                ))}
              </select>
            }
          />
          <Row
            label="服务商 ID"
            desc="稳定标识，留空时按名称自动生成。"
            control={<input className="weq-set-input" value={form.id} onChange={(e) => update('id', e.target.value)} placeholder="cosyvoice-main" />}
          />
          <Row
            label="显示名称"
            control={<input className="weq-set-input" value={form.name} onChange={(e) => update('name', e.target.value)} placeholder="CosyVoice" />}
          />
          <Row
            label="服务地址 (Base URL)"
            desc={vendorEntry ? `模板默认：${vendorEntry.baseUrl}` : undefined}
            control={<input className="weq-set-input" value={form.baseUrl} onChange={(e) => update('baseUrl', e.target.value)} placeholder="https://..." />}
          />
          {has('apiKey') ? (
            <Row
              label="API Key"
              desc={vendorEntry?.apiKeyHint}
              control={<input className="weq-set-input" type="password" value={form.apiKey} onChange={(e) => update('apiKey', e.target.value)} placeholder="sk-..." />}
            />
          ) : null}
          {has('appId') ? (
            <Row
              label="App ID"
              desc="豆包 X-Api-App-Id"
              control={<input className="weq-set-input" value={form.appId} onChange={(e) => update('appId', e.target.value)} />}
            />
          ) : null}
          {has('resourceId') ? (
            <Row
              label="Resource ID"
              desc="豆包 X-Api-Resource-Id（如 seed-tts-2.0）"
              control={<input className="weq-set-input" value={form.resourceId} onChange={(e) => update('resourceId', e.target.value)} placeholder="seed-tts-2.0" />}
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
                  placeholder={vendorEntry?.defaultModel ?? '厂商模型 id（可空用默认）'}
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
              control={<input className="weq-set-input" value={form.voice} onChange={(e) => update('voice', e.target.value)} placeholder="voice id" />}
            />
          ) : null}
          {has('format') ? (
            <Row
              label="音频格式"
              control={
                <select className="weq-set-input" value={form.format} onChange={(e) => update('format', e.target.value)}>
                  <option value="">默认</option>
                  <option value="mp3">mp3</option>
                  <option value="wav">wav</option>
                </select>
              }
            />
          ) : null}
          {has('speed') ? (
            <Row
              label="语速"
              desc="1.0 为常态，留空用默认。"
              control={<input className="weq-set-input" value={form.speed} onChange={(e) => update('speed', e.target.value)} placeholder="1.0" />}
            />
          ) : null}

          <div className="weq-set-actions">
            <button type="button" className="weq-set-btn" onClick={() => void onSave()} disabled={saveProvider.isLoading}>
              <Save size={14} />
              保存
            </button>
            <button type="button" className="weq-set-btn weq-set-btn-soft" onClick={() => void onTest()} disabled={testing}>
              {testing ? <Loader2 size={14} className="weq-spin" /> : <Play size={14} />}
              测试
            </button>
            <button type="button" className="weq-set-btn weq-set-btn-soft" onClick={() => void onDelete()} disabled={!selectedId || deleteProvider.isLoading}>
              <Trash2 size={14} />
              删除
            </button>
          </div>
          {vendorEntry?.capabilities.clone ? (
            <p className="weq-set-note">
              <Volume2 size={12} style={{ verticalAlign: '-2px', marginRight: 4 }} />
              这是语音克隆型服务商：在克隆体的「语音」设置里开启语音克隆后，会自动用 TA 的真实语音作参考音频。此处「测试」仅校验连通性。
            </p>
          ) : null}
        </Card>
      ) : null}
    </>
  );
}
