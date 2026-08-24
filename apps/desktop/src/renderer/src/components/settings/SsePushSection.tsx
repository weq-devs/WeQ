/**
 * 设置 → SSE 消息推送
 *
 * 把 QQ 新消息实时推送到用户配置的「推送地址」（HTTP POST + Bearer access_token）。
 * 实现参考 `pnpm --filter @weq/service tools:db-watch-listen` —— 同一套 nt_msg.db
 * 监听，外加防抖合并 + seq 跳变阈值：QQ 刚启动大量写表时，不再逐条推送，
 * 而是合并成一条 `mass` 事件并预览最新一条。
 *
 * 后端契约（bootstrap router）：
 *   - getSettings          返回完整设置（含 ssePush.servers / enabledServerId / 调优）
 *   - saveSsePushServer    新增 / 编辑推送目标（编辑保留启用状态）
 *   - deleteSsePushServer  删除
 *   - setSsePushEnabled    启用 / 停用（同时只能启用一条）
 *   - setSsePushTuning     防抖毫秒 / 大量消息阈值
 *   - testSsePushServer    发一条 ping 事件探测连通性
 */

import { useEffect, useState, type FormEvent, type ReactElement } from 'react';
import {
  Check,
  ChevronRight,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  Radio,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import { trpc } from '../../trpc/client';
import { useDialog } from '../Dialog';
import { useToast } from '../Toast';
import { Card, Row, SectionHeader, Toggle } from './controls';

interface PushForm {
  id: string;
  name: string;
  pushUrl: string;
  accessToken: string;
}

const EMPTY_FORM: PushForm = { id: '', name: '', pushUrl: '', accessToken: '' };

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function SsePushSection(): ReactElement {
  const showError = useDialog((s) => s.showError);
  const pushToast = useToast((s) => s.push);

  const settings = trpc.bootstrap.getSettings.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const saveServer = trpc.bootstrap.saveSsePushServer.useMutation();
  const deleteServer = trpc.bootstrap.deleteSsePushServer.useMutation();
  const setEnabled = trpc.bootstrap.setSsePushEnabled.useMutation();
  const setTuning = trpc.bootstrap.setSsePushTuning.useMutation();
  const testServer = trpc.bootstrap.testSsePushServer.useMutation();

  const [form, setForm] = useState<PushForm | null>(null);
  const [revealToken, setRevealToken] = useState(false);
  const [testing, setTesting] = useState(false);
  const [debounceDraft, setDebounceDraft] = useState('2000');
  const [thresholdDraft, setThresholdDraft] = useState('50');

  const sse = settings.data?.ssePush;
  const servers = sse?.servers ?? [];
  const enabledServerId = sse?.enabledServerId ?? null;
  const busy = saveServer.isLoading || deleteServer.isLoading || setEnabled.isLoading;

  useEffect(() => {
    if (!sse) return;
    setDebounceDraft(String(sse.debounceMs));
    setThresholdDraft(String(sse.massThreshold));
  }, [sse]);

  async function refetch(): Promise<void> {
    await settings.refetch();
  }

  function updateField<K extends keyof PushForm>(key: K, value: PushForm[K]): void {
    setForm((current) => (current ? { ...current, [key]: value } : current));
  }

  function startCreate(): void {
    setForm(EMPTY_FORM);
    setRevealToken(false);
  }

  function startEdit(server: PushForm): void {
    setForm({
      id: server.id,
      name: server.name,
      pushUrl: server.pushUrl,
      accessToken: server.accessToken,
    });
    setRevealToken(false);
  }

  async function onSave(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!form) return;
    const pushUrl = form.pushUrl.trim();
    const token = form.accessToken.trim();
    if (!pushUrl) {
      showError('缺少推送地址', '请填写接收端 HTTP 地址，例如 http://127.0.0.1:8899/push');
      return;
    }
    try {
      await saveServer.mutateAsync({
        id: form.id || undefined,
        name: form.name,
        pushUrl,
        accessToken: token,
      });
      setForm(null);
      await refetch();
      pushToast({ tone: 'success', title: form.id ? '推送目标已更新' : '推送目标已保存' });
    } catch (err) {
      showError('保存失败', errMsg(err));
    }
  }

  async function onDelete(id: string, name: string): Promise<void> {
    try {
      await deleteServer.mutateAsync({ id });
      await refetch();
      pushToast({ tone: 'success', title: '已删除', message: `${name} 已从列表移除` });
    } catch (err) {
      showError('删除失败', errMsg(err));
    }
  }

  async function onToggleServer(server: PushForm, next: boolean): Promise<void> {
    try {
      await setEnabled.mutateAsync({ serverId: next ? server.id : null });
      await refetch();
      pushToast({
        tone: next ? 'success' : 'info',
        title: next ? `已启用 ${server.name}` : `已停用 ${server.name}`,
      });
    } catch (err) {
      showError('切换失败', errMsg(err));
    }
  }

  async function onSaveTuning(): Promise<void> {
    const debounceMs = Number(debounceDraft);
    const massThreshold = Number(thresholdDraft);
    if (!Number.isFinite(debounceMs) || debounceMs < 100 || debounceMs > 60000) {
      showError('防抖值无效', '防抖毫秒需在 100 – 60000 之间。');
      return;
    }
    if (!Number.isFinite(massThreshold) || massThreshold < 1 || massThreshold > 10000) {
      showError('阈值无效', '大量消息阈值需在 1 – 10000 之间。');
      return;
    }
    try {
      await setTuning.mutateAsync({ debounceMs, massThreshold });
      await refetch();
      pushToast({ tone: 'success', title: '推送调优已保存' });
    } catch (err) {
      showError('保存失败', errMsg(err));
    }
  }

  async function onTest(): Promise<void> {
    const pushUrl = form?.pushUrl.trim() ?? '';
    if (!pushUrl) {
      showError('信息不完整', '请先填写推送地址。');
      return;
    }
    const accessToken = form?.accessToken.trim() ?? '';
    setTesting(true);
    try {
      const result = await testServer.mutateAsync({ pushUrl, accessToken });
      pushToast({
        tone: 'success',
        title: '连接成功',
        message: `已发送 ping 事件，耗时 ${result.latencyMs}ms`,
      });
    } catch (err) {
      showError('连接失败', errMsg(err));
    } finally {
      setTesting(false);
    }
  }

  const tuningChanged =
    sse !== undefined &&
    (debounceDraft !== String(sse.debounceMs) || thresholdDraft !== String(sse.massThreshold));

  return (
    <div className="weq-set">
      <SectionHeader
        title="SSE 消息推送"
        desc="把 QQ 新消息实时推送到你指定的地址（HTTP POST，可选 Bearer access_token）。监听实现与 tools:db-watch-listen 一致：防抖合并 + seq 跳变阈值，QQ 刚启动大量写表时只推一条 mass 事件预览最新一条。"
      />

      <Card
        title="已配置的推送目标"
        action={
          <button
            type="button"
            className="weq-set-btn weq-set-btn-sm"
            disabled={busy}
            onClick={() => (form ? setForm(null) : startCreate())}
          >
            {form ? <X size={13} /> : <Plus size={13} />}
            {form ? '取消' : '新增推送目标'}
          </button>
        }
      >
        {servers.length === 0 ? (
          <div className="weq-set-empty">还没有配置任何推送目标。启用后 WeQ 会把新消息 POST 到该地址。</div>
        ) : (
          <ul className="weq-set-server-list">
            {servers.map((server) => {
              const isEnabled = server.id === enabledServerId;
              return (
                <li
                  key={server.id}
                  className={`weq-set-server-item${isEnabled ? ' is-enabled' : ''}`}
                >
                  <div className="weq-set-server-main">
                    <div className="weq-set-server-title">
                      <Radio size={14} strokeWidth={1.8} className="weq-set-server-ico" />
                      <span className="weq-set-server-name">{server.name}</span>
                      {isEnabled ? <span className="weq-set-server-badge">推送中</span> : null}
                    </div>
                    <div className="weq-set-server-sub">
                      {server.pushUrl} ·{' '}
                      {server.accessToken ? 'access_token 已设置' : 'access_token 未设置'}
                    </div>
                  </div>
                  <div className="weq-set-server-actions">
                    <button
                      type="button"
                      className="weq-set-iconbtn"
                      title="编辑"
                      aria-label="编辑"
                      disabled={busy}
                      onClick={() => startEdit(server)}
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      type="button"
                      className="weq-set-iconbtn weq-set-iconbtn-danger"
                      title="删除"
                      aria-label="删除"
                      disabled={busy}
                      onClick={() => void onDelete(server.id, server.name)}
                    >
                      <Trash2 size={14} />
                    </button>
                    <Toggle
                      checked={isEnabled}
                      disabled={busy}
                      label={`启用 ${server.name}`}
                      onChange={(next) => void onToggleServer(server, next)}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {form ? (
          <div className="weq-set-server-form-wrap">
            <div className="weq-set-server-form-title">
              {form.id ? '编辑推送目标' : '新增推送目标'}
            </div>
            <form className="weq-set-server-form" onSubmit={(e) => void onSave(e)}>
              <Row
                label="名称"
                desc="可选，默认取推送地址的主机部分。"
                control={
                  <input
                    className="weq-set-input"
                    value={form.name}
                    spellCheck={false}
                    placeholder="例如：家里的接收端"
                    onChange={(e) => updateField('name', e.target.value)}
                  />
                }
              />
              <Row
                label="推送地址"
                desc="接收端 HTTP 接口。示例接收端见仓库 scripts/sse_receive.mjs。"
                control={
                  <input
                    className="weq-set-input weq-set-input-wide"
                    value={form.pushUrl}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="http://127.0.0.1:8899/push"
                    onChange={(e) => updateField('pushUrl', e.target.value)}
                  />
                }
              />
              <Row
                label="access_token"
                desc="可选。接收端要求鉴权时填写，推送时以 Bearer 方式发送；留空则不发送 Authorization 头。"
                control={
                  <div className="weq-set-keyfield weq-set-tokenfield">
                    <KeyRound
                      size={15}
                      strokeWidth={1.8}
                      className="weq-set-keyfield-icon"
                      aria-hidden
                    />
                    <input
                      className="weq-set-token-input"
                      type={revealToken ? 'text' : 'password'}
                      value={form.accessToken}
                      spellCheck={false}
                      autoComplete="off"
                      placeholder="可选，留空则无需鉴权"
                      onChange={(e) => updateField('accessToken', e.target.value)}
                    />
                    <button
                      type="button"
                      className="weq-set-iconbtn"
                      title={revealToken ? '隐藏' : '显示'}
                      aria-label={revealToken ? '隐藏 token' : '显示 token'}
                      onClick={() => setRevealToken((v) => !v)}
                    >
                      {revealToken ? <EyeOff size={15} /> : <Eye size={15} />}
                    </button>
                  </div>
                }
              />
              <div className="weq-set-server-form-actions">
                <button
                  type="button"
                  className="weq-set-btn weq-set-btn-soft"
                  disabled={testing}
                  onClick={() => void onTest()}
                >
                  {testing ? (
                    <Loader2 size={13} className="weq-set-spin" />
                  ) : (
                    <RefreshCw size={13} />
                  )}
                  测试连接
                </button>
                <button type="submit" className="weq-set-btn" disabled={busy}>
                  保存
                </button>
              </div>
            </form>
          </div>
        ) : null}
      </Card>

      <Card title="推送调优">
        <Row
          label="防抖毫秒"
          desc="收到新消息后等待这段空闲时间再合并推送，QQ 连续写表时能大幅减少推送次数。"
          control={
            <div className="weq-set-btn-group">
              <input
                className="weq-set-input weq-set-input-sm weq-number"
                value={debounceDraft}
                inputMode="numeric"
                spellCheck={false}
                disabled={setTuning.isLoading}
                onChange={(e) => setDebounceDraft(e.target.value.replace(/[^0-9]/g, ''))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void onSaveTuning();
                }}
                aria-label="防抖毫秒"
              />
            </div>
          }
        />
        <Row
          label="大量消息阈值"
          desc="某个会话的 seq 一次跳变超过该值时（如 2000 → 4000，典型是 QQ 刚启动写表），合并成一条 mass 事件并预览最新一条，不再逐条推送。"
          control={
            <div className="weq-set-btn-group">
              <input
                className="weq-set-input weq-set-input-sm weq-number"
                value={thresholdDraft}
                inputMode="numeric"
                spellCheck={false}
                disabled={setTuning.isLoading}
                onChange={(e) => setThresholdDraft(e.target.value.replace(/[^0-9]/g, ''))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void onSaveTuning();
                }}
                aria-label="大量消息阈值"
              />
            </div>
          }
        />
        <div className="weq-set-server-form-actions">
          <button
            type="button"
            className="weq-set-btn weq-set-btn-sm"
            disabled={setTuning.isLoading || !tuningChanged}
            onClick={() => void onSaveTuning()}
          >
            {setTuning.isLoading ? (
              <Loader2 size={13} className="weq-set-spin" />
            ) : (
              <Check size={13} />
            )}
            保存调优
          </button>
        </div>
      </Card>

      <p className="weq-set-note">
        <ChevronRight size={13} strokeWidth={2} />
        事件格式：普通消息为 <code>message</code>（含 text 摘要）；seq 跳变超过阈值时为 <code>mass</code>
        （fromSeq / toSeq / count + 最新一条 preview）。推送失败会按指数退避重试，不会丢消息。
      </p>
    </div>
  );
}
