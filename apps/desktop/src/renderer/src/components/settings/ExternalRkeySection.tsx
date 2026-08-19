/**
 * 设置 → 外部 RKEY 服务器.
 *
 * 让没有在线 QQ 进程的机器也能补全聊天媒体：通过外部 rkey 服务器（目前支持
 * NapCat 的 `/get_rkey_server` 接口）拉取 QQ 的媒体下载凭证。
 *
 * 全局配置：rkey 与账号权限关系不大，一份配置所有账号通用。可导入多份配置但
 * 同时只能启用一条（或都不启用）。下载图片/表情时优先用本机在线 QQ 自己获取的
 * rkey，本地不可用才回退到启用的外部服务器（见 service 侧 external_rkey.ts）。
 *
 * 后端契约（bootstrap router）：
 *   - getSettings               — 返回完整设置，含 externalRkey.servers / enabledServerId
 *   - saveExternalRkeyServer    — 新增/编辑（编辑时地址/token 变化会作废缓存 rkey）
 *   - deleteExternalRkeyServer  — 删除
 *   - setExternalRkeyEnabled    — 启用/停用（同时只启用一条）
 *   - testExternalRkeyServer    — 只探测连通性，不写缓存
 */

import { useState, type FormEvent, type ReactElement } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  CloudDownload,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  Trash2,
  X,
} from 'lucide-react';
import { trpc } from '../../trpc/client';
import { useDialog } from '../Dialog';
import { useToast } from '../Toast';
import { Card, Row, SectionHeader, Toggle } from './controls';

interface ServerForm {
  id: string;
  name: string;
  baseUrl: string;
  accessToken: string;
}

const EMPTY_FORM: ServerForm = { id: '', name: '', baseUrl: '', accessToken: '' };

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** unix 秒 → 「x 小时/分钟后过期」或「已过期」。 */
function formatCacheExpiry(expiredTime: number | undefined): { text: string; expired: boolean } {
  if (expiredTime == null) return { text: '尚未拉取 rkey', expired: false };
  const leftMs = expiredTime * 1000 - Date.now();
  if (leftMs <= 0) return { text: '缓存 rkey 已过期，下次下载自动重拉', expired: true };
  const mins = Math.floor(leftMs / 60000);
  if (mins < 60) return { text: `缓存 rkey ${mins} 分钟后过期`, expired: false };
  const hours = Math.floor(mins / 60);
  if (hours < 24) return { text: `缓存 rkey ${hours} 小时后过期`, expired: false };
  return { text: `缓存 rkey ${Math.floor(hours / 24)} 天后过期`, expired: false };
}

export function ExternalRkeySection(): ReactElement {
  const showError = useDialog((s) => s.showError);
  const pushToast = useToast((s) => s.push);

  const settings = trpc.bootstrap.getSettings.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const saveServer = trpc.bootstrap.saveExternalRkeyServer.useMutation();
  const deleteServer = trpc.bootstrap.deleteExternalRkeyServer.useMutation();
  const setEnabled = trpc.bootstrap.setExternalRkeyEnabled.useMutation();
  const testServer = trpc.bootstrap.testExternalRkeyServer.useMutation();

  const [form, setForm] = useState<ServerForm | null>(null);
  const [revealToken, setRevealToken] = useState(false);
  const [testing, setTesting] = useState(false);

  const external = settings.data?.externalRkey;
  const servers = external?.servers ?? [];
  const enabledServerId = external?.enabledServerId ?? null;
  const busy = saveServer.isLoading || deleteServer.isLoading || setEnabled.isLoading;

  async function refetch(): Promise<void> {
    await settings.refetch();
  }

  function updateField<K extends keyof ServerForm>(key: K, value: ServerForm[K]): void {
    setForm((current) => (current ? { ...current, [key]: value } : current));
  }

  function startCreate(): void {
    setForm(EMPTY_FORM);
    setRevealToken(false);
  }

  function startEdit(server: ServerForm): void {
    setForm({
      id: server.id,
      name: server.name,
      baseUrl: server.baseUrl,
      accessToken: server.accessToken,
    });
    setRevealToken(false);
  }

  async function onSave(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!form) return;
    const baseUrl = form.baseUrl.trim();
    const token = form.accessToken.trim();
    if (!baseUrl) {
      showError('缺少服务器地址', '请填写 NapCat HTTP 服务器地址。');
      return;
    }
    if (!token) {
      showError('缺少 access_token', '请填写 NapCat 的 access_token。');
      return;
    }
    try {
      await saveServer.mutateAsync({
        id: form.id || undefined,
        name: form.name,
        baseUrl,
        accessToken: token,
      });
      setForm(null);
      await refetch();
      pushToast({ tone: 'success', title: form.id ? '配置已更新' : '配置已导入' });
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

  async function onToggleServer(server: ServerForm, next: boolean): Promise<void> {
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

  async function onTestFromList(server: ServerForm): Promise<void> {
    try {
      const result = await testServer.mutateAsync({
        baseUrl: server.baseUrl,
        accessToken: server.accessToken,
      });
      pushToast({
        tone: 'success',
        title: '连接成功',
        message: result.name
          ? `${result.name} · ${formatCacheExpiry(result.expiredTime).text}`
          : '服务器正常响应',
      });
    } catch (err) {
      showError('连接失败', errMsg(err));
    }
  }

  async function onTestForm(): Promise<void> {
    if (!form) return;
    if (!form.baseUrl.trim() || !form.accessToken.trim()) {
      showError('信息不完整', '请先填写服务器地址与 access_token。');
      return;
    }
    setTesting(true);
    try {
      const result = await testServer.mutateAsync({
        baseUrl: form.baseUrl,
        accessToken: form.accessToken,
      });
      pushToast({
        tone: 'success',
        title: '连接成功',
        message: result.name
          ? `${result.name} · ${formatCacheExpiry(result.expiredTime).text}`
          : '服务器正常响应',
      });
    } catch (err) {
      showError('连接失败', errMsg(err));
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="weq-set">
      <SectionHeader
        title="外部 RKEY 服务器"
        desc="通过外部 rkey 服务器（目前支持 NapCat）为本机补全缺失的聊天图片/表情。全局配置，一次设置所有账号通用。"
      />

      <details className="weq-set-about">
        <summary>
          <span className="weq-set-about-summary">
            <CloudDownload size={15} strokeWidth={1.8} />
            了解 RKEY 与外部服务器
          </span>
          <ChevronDown size={15} strokeWidth={1.8} className="weq-set-about-caret" />
        </summary>
        <ul className="weq-set-about-list">
          <li>
            <b>RKEY 是做什么的：</b>RKEY 是 QQ 下发的媒体下载凭证。聊天里的图片/表情如果
            本地没有缓存，WeQ 可以用它从 QQ 的 CDN 拉取回来补全。
          </li>
          <li>
            <b>为什么需要外部服务器：</b>WeQ 本身可以从你正在登录的 QQ 进程里自动获取
            RKEY，但前提是本机有一个登录中的 QQ。QQ 不在线（比如看导入的数据）时，媒体
            补全就用不了。外部 RKEY 服务器可以在没有在线 QQ 的情况下提供凭证，提升补全 成功率。
          </li>
          <li>
            <b>全局生效：</b>RKEY 与账号权限关系不大，这里配置一次，所有账号通用，不用
            每个账号单独设置。
          </li>
          <li>
            <b>适用范围：</b>私聊/群聊的图片与表情。视频、文件、语音走的是另一套协议， 无法通过 RKEY
            补全。
          </li>
          <li>
            <b>下载顺序：</b>优先使用本机在线 QQ 自己获取的 RKEY；本地没有或已过期时，
            自动回退到启用的外部服务器（并缓存结果，过期前不重复请求）。
          </li>
        </ul>
      </details>

      <Card
        title="已导入的服务器"
        action={
          <button
            type="button"
            className="weq-set-btn weq-set-btn-sm"
            disabled={busy}
            onClick={() => (form ? setForm(null) : startCreate())}
          >
            {form ? <X size={13} /> : <Plus size={13} />}
            {form ? '取消' : '导入新配置'}
          </button>
        }
      >
        {servers.length === 0 ? (
          <div className="weq-set-empty">还没有导入任何外部 rkey 服务器。</div>
        ) : (
          <ul className="weq-set-server-list">
            {servers.map((server) => {
              const isEnabled = server.id === enabledServerId;
              const cache = formatCacheExpiry(server.expiredTime);
              return (
                <li
                  key={server.id}
                  className={`weq-set-server-item${isEnabled ? ' is-enabled' : ''}`}
                >
                  <div className="weq-set-server-main">
                    <div className="weq-set-server-title">
                      <Server size={14} strokeWidth={1.8} className="weq-set-server-ico" />
                      <span className="weq-set-server-name">{server.name}</span>
                      {isEnabled ? <span className="weq-set-server-badge">已启用</span> : null}
                    </div>
                    <div className="weq-set-server-sub">{server.baseUrl} · token 已设置</div>
                    <div className={`weq-set-server-cache${cache.expired ? ' is-expired' : ''}`}>
                      {cache.expired ? null : <CheckCircle2 size={12} strokeWidth={2} />}
                      {cache.text}
                    </div>
                  </div>
                  <div className="weq-set-server-actions">
                    <button
                      type="button"
                      className="weq-set-iconbtn"
                      title="测试连接"
                      aria-label="测试连接"
                      disabled={busy || testServer.isLoading}
                      onClick={() => void onTestFromList(server)}
                    >
                      {testServer.isLoading ? (
                        <Loader2 size={14} className="weq-set-spin" />
                      ) : (
                        <RefreshCw size={14} />
                      )}
                    </button>
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
      </Card>

      {form ? (
        <Card title={form.id ? '编辑配置' : '导入新配置'}>
          <form className="weq-set-server-form" onSubmit={(e) => void onSave(e)}>
            <Row
              label="名称"
              desc="可选，默认取服务器地址的主机名。"
              control={
                <input
                  className="weq-set-input"
                  value={form.name}
                  spellCheck={false}
                  placeholder="例如：家里的 NapCat"
                  onChange={(e) => updateField('name', e.target.value)}
                />
              }
            />
            <Row
              label="NapCat HTTP 服务器地址"
              desc="结尾若带 /get_rkey_server 会自动去掉。"
              control={
                <input
                  className="weq-set-input weq-set-input-wide"
                  value={form.baseUrl}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="http://127.0.0.1:3000"
                  onChange={(e) => updateField('baseUrl', e.target.value)}
                />
              }
            />
            <Row
              label="access_token"
              desc="NapCat 的访问令牌，仅本机使用。"
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
                    placeholder="NapCat access_token"
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
                onClick={() => void onTestForm()}
              >
                {testing ? <Loader2 size={13} className="weq-set-spin" /> : <RefreshCw size={13} />}
                测试连接
              </button>
              <button type="submit" className="weq-set-btn" disabled={busy}>
                保存
              </button>
            </div>
          </form>
        </Card>
      ) : null}
    </div>
  );
}
