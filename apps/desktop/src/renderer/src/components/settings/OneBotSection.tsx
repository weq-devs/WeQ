import { useEffect, useState, type FormEvent, type ReactElement } from 'react';
import {
  Copy,
  Eye,
  EyeOff,
  Globe2,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  Power,
  RadioTower,
  RefreshCw,
  Save,
  Server,
  Trash2,
  X,
} from 'lucide-react';
import { trpc } from '../../trpc/client';
import { useTabActive } from '../RetainedTabs';
import { useDialog } from '../Dialog';
import { useToast } from '../Toast';
import { Card, QueryError, Row, SectionHeader, Toggle } from './controls';
import '../../styles/settings-onebot.css';

type ServerType = 'ws' | 'http';

interface ServerDraft {
  id: string;
  type: ServerType;
  name: string;
  port: string;
  token: string;
  enabled: boolean;
  enableCors: boolean;
}

function generatedToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

function nextPort(servers: readonly { port: number }[], type: ServerType): string {
  const used = new Set(servers.map((server) => server.port));
  let port = type === 'ws' ? 48766 : 48767;
  while (used.has(port)) port += 1;
  return String(port);
}

export function OneBotSection(): ReactElement {
  const active = useTabActive();
  const status = trpc.bootstrap.getOneBotStatus.useQuery(undefined, {
    enabled: active,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchInterval: active ? 5000 : false,
  });
  const setMaster = trpc.bootstrap.setOneBotEnabled.useMutation();
  const saveServer = trpc.bootstrap.saveOneBotServer.useMutation();
  const deleteServer = trpc.bootstrap.deleteOneBotServer.useMutation();
  const setServerEnabled = trpc.bootstrap.setOneBotServerEnabled.useMutation();
  const regenerateToken = trpc.bootstrap.regenerateOneBotServerToken.useMutation();
  const showError = useDialog((s) => s.showError);
  const toast = useToast((s) => s.push);
  const [draft, setDraft] = useState<ServerDraft | null>(null);
  const [revealToken, setRevealToken] = useState(false);
  useEffect(() => {
    if (!active) setRevealToken(false);
  }, [active]);

  const data = status.data;
  const servers = data?.servers ?? [];
  const busy =
    setMaster.isLoading ||
    saveServer.isLoading ||
    deleteServer.isLoading ||
    setServerEnabled.isLoading ||
    regenerateToken.isLoading;

  async function refetch(): Promise<void> {
    await status.refetch();
  }

  async function run(
    action: () => Promise<unknown>,
    success: { title: string; message?: string },
  ): Promise<boolean> {
    try {
      await action();
      toast({ tone: 'success', ...success });
      return true;
    } catch (error) {
      showError('OneBot 配置失败', error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      await refetch();
    }
  }

  async function copy(value: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      toast({ tone: 'success', title: '已复制' });
    } catch (error) {
      showError('复制失败', error instanceof Error ? error.message : String(error));
    }
  }

  function startCreate(type: ServerType): void {
    const sameType = servers.filter((server) => server.type === type);
    setDraft({
      id: '',
      type,
      name: `${type === 'ws' ? 'WebSocket' : 'HTTP'} 服务器 ${sameType.length + 1}`,
      port: nextPort(servers, type),
      token: generatedToken(),
      enabled: true,
      enableCors: true,
    });
    setRevealToken(false);
  }

  function startEdit(server: {
    id: string;
    type: ServerType;
    name: string;
    port: number;
    token: string;
    enabled: boolean;
    enableCors?: boolean;
  }): void {
    setDraft({
      id: server.id,
      type: server.type,
      name: server.name,
      port: String(server.port),
      token: server.token,
      enabled: server.enabled,
      enableCors: server.enableCors ?? true,
    });
    setRevealToken(false);
  }

  async function onSave(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!draft) return;
    const port = Number(draft.port);
    if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
      showError('端口无效', '端口需为 1024 – 65535 之间的整数。');
      return;
    }
    const saved = await run(
      () =>
        saveServer.mutateAsync({
          id: draft.id || undefined,
          type: draft.type,
          name: draft.name.trim(),
          enabled: draft.enabled,
          port,
          token: draft.token.trim(),
          enableCors: draft.type === 'http' ? draft.enableCors : undefined,
        }),
      {
        title: draft.id
          ? '服务器配置已更新'
          : `${draft.type === 'ws' ? 'WebSocket' : 'HTTP'} 服务器已创建`,
      },
    );
    if (saved) setDraft(null);
  }

  const wsServer = data?.servers.find((server) => server.type === 'ws' && server.enabled) ?? null;
  const ccConnectConfig = wsServer
    ? `[[projects.platforms]]\ntype = "qq"\n[projects.platforms.options]\nws_url = "${wsServer.url}"\ntoken = "${wsServer.token}"\nallow_from = "填写你的 QQ 号"\ngroup_require_mention = true\n`
    : '';

  return (
    <div className="weq-set weq-set-onebot">
      <SectionHeader
        title="OneBot / cc-connect"
        icon={<RadioTower size={16} strokeWidth={1.8} />}
        desc="可同时运行多个 OneBot v11 WebSocket 与 HTTP API 服务器；每张卡片独立启停、端口和令牌。端口被占用时会自动顺延到附近空闲端口。"
      />

      <Card title="总开关" icon={<Power size={15} strokeWidth={1.8} />}>
        {status.error ? (
          <QueryError
            message={status.error.message}
            retryLabel="重新读取"
            retrying={status.isFetching}
            onRetry={() => void refetch()}
          />
        ) : null}
        <Row
          label="OneBot 服务"
          desc="关闭后所有 WS / HTTP 服务器都会停止，但各自的启用配置会保留。"
          control={
            <Toggle
              label="启用 OneBot 服务"
              checked={data?.enabled ?? false}
              disabled={!data || busy}
              onChange={(enabled) =>
                void run(() => setMaster.mutateAsync({ enabled }), {
                  title: enabled ? 'OneBot 服务已启用' : 'OneBot 服务已停止',
                })
              }
            />
          }
        />
        <Row
          label="运行状态"
          control={
            <span>
              {data?.running
                ? `${data.servers.filter((server) => server.running).length} 个服务器运行中 · ${data.clients} 个连接`
                : data?.enabled
                  ? data.accountOpen
                    ? '等待可用服务器'
                    : '等待在线账号'
                  : '已停止'}
            </span>
          }
        />
      </Card>

      <Card
        title="网络服务器"
        icon={<Server size={15} strokeWidth={1.8} />}
        action={
          <div className="weq-onebot-add-actions">
            <button
              type="button"
              className="weq-set-btn weq-set-btn-sm"
              disabled={busy || Boolean(draft)}
              onClick={() => startCreate('ws')}
            >
              <Plus size={13} />
              WebSocket
            </button>
            <button
              type="button"
              className="weq-set-btn weq-set-btn-sm weq-set-btn-soft"
              disabled={busy || Boolean(draft)}
              onClick={() => startCreate('http')}
            >
              <Plus size={13} />
              HTTP
            </button>
          </div>
        }
      >
        {servers.length === 0 && !draft ? (
          <div className="weq-set-empty">
            还没有配置网络服务器。WebSocket 适合正向连接客户端，HTTP 提供标准 OneBot v11 action
            API。
          </div>
        ) : null}
        <ul className="weq-onebot-server-grid">
          {servers.map((server) => {
            const label = !data?.enabled
              ? '总开关已关闭'
              : !server.enabled
                ? '未启用'
                : !data.accountOpen
                  ? '等待在线账号'
                  : server.running
                    ? server.type === 'ws'
                      ? `运行中 · ${server.clients} 个连接`
                      : '监听中'
                    : server.error
                      ? '启动失败'
                      : '未在监听';
            return (
              <li
                key={`${server.type}:${server.id}`}
                className={`weq-onebot-server-card${server.running ? ' is-running' : ''}${server.enabled ? ' is-enabled' : ''}`}
              >
                <div className="weq-onebot-server-head">
                  <span className="weq-onebot-server-icon" aria-hidden>
                    {server.type === 'ws' ? (
                      <RadioTower size={17} strokeWidth={1.8} />
                    ) : (
                      <Globe2 size={17} strokeWidth={1.8} />
                    )}
                  </span>
                  <div className="weq-onebot-server-title">
                    <strong title={server.name}>{server.name}</strong>
                    <span>{server.type === 'ws' ? 'WebSocket' : 'HTTP API'}</span>
                  </div>
                  <Toggle
                    checked={server.enabled}
                    disabled={busy}
                    label={`启用 ${server.name}`}
                    onChange={(enabled) =>
                      void run(
                        () =>
                          setServerEnabled.mutateAsync({
                            id: server.id,
                            type: server.type,
                            enabled,
                          }),
                        {
                          title: enabled ? `${server.name} 已启用` : `${server.name} 已停用`,
                        },
                      )
                    }
                  />
                </div>
                <div className="weq-onebot-server-fields">
                  <div>
                    <span>监听地址</span>
                    <code title={server.url}>{server.url}</code>
                  </div>
                  <div>
                    <span>令牌</span>
                    <code>{server.token ? '已设置访问令牌' : '无需鉴权'}</code>
                  </div>
                </div>
                <div className="weq-onebot-server-status">
                  <span className={`weq-onebot-status-dot${server.running ? ' is-live' : ''}`} />
                  <span>{label}</span>
                  {server.port !== server.requestedPort ? (
                    <span className="weq-onebot-port-shift">
                      原端口 {server.requestedPort} 被占用，已顺延
                    </span>
                  ) : null}
                </div>
                {server.error ? <p className="weq-onebot-server-error">{server.error}</p> : null}
                <div className="weq-onebot-server-actions">
                  <button
                    type="button"
                    className="weq-set-iconbtn"
                    title="复制地址"
                    aria-label={`复制 ${server.name} 地址`}
                    onClick={() => void copy(server.url)}
                  >
                    <Copy size={14} />
                  </button>
                  <button
                    type="button"
                    className="weq-set-iconbtn"
                    title="编辑"
                    aria-label={`编辑 ${server.name}`}
                    disabled={busy}
                    onClick={() => startEdit(server)}
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    type="button"
                    className="weq-set-iconbtn"
                    title="复制令牌"
                    aria-label={`复制 ${server.name} 令牌`}
                    disabled={!server.token}
                    onClick={() => void copy(server.token)}
                  >
                    <KeyRound size={14} />
                  </button>
                  <button
                    type="button"
                    className="weq-set-iconbtn"
                    title="重新生成令牌"
                    aria-label={`重新生成 ${server.name} 令牌`}
                    disabled={busy}
                    onClick={() =>
                      void run(
                        () => regenerateToken.mutateAsync({ id: server.id, type: server.type }),
                        { title: `${server.name} 的令牌已更新` },
                      )
                    }
                  >
                    <RefreshCw size={14} />
                  </button>
                  <button
                    type="button"
                    className="weq-set-iconbtn weq-set-iconbtn-danger"
                    title="删除"
                    aria-label={`删除 ${server.name}`}
                    disabled={busy}
                    onClick={() =>
                      void run(
                        () => deleteServer.mutateAsync({ id: server.id, type: server.type }),
                        { title: `${server.name} 已删除` },
                      )
                    }
                  >
                    <Trash2 size={14} />
                  </button>
                  {server.type === 'ws' && server.enabled ? (
                    <button
                      type="button"
                      className="weq-onebot-card-link"
                      onClick={() => {
                        setDraft(null);
                        void copy(
                          `[[projects.platforms]]\ntype = "qq"\n[projects.platforms.options]\nws_url = "${server.url}"\ntoken = "${server.token}"\nallow_from = "填写你的 QQ 号"\ngroup_require_mention = true\n`,
                        );
                      }}
                    >
                      cc-connect 配置
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}

          {draft ? (
            <li className="weq-onebot-server-card weq-onebot-server-editor">
              <div className="weq-onebot-server-head">
                <span className="weq-onebot-server-icon" aria-hidden>
                  {draft.type === 'ws' ? (
                    <RadioTower size={17} strokeWidth={1.8} />
                  ) : (
                    <Globe2 size={17} strokeWidth={1.8} />
                  )}
                </span>
                <div className="weq-onebot-server-title">
                  <strong>{draft.id ? '编辑服务器' : '新建服务器'}</strong>
                  <span>{draft.type === 'ws' ? 'WebSocket' : 'HTTP API'}</span>
                </div>
                <button
                  type="button"
                  className="weq-set-iconbtn"
                  title="取消"
                  aria-label="取消编辑 OneBot 服务器"
                  onClick={() => setDraft(null)}
                >
                  <X size={14} />
                </button>
              </div>
              <form className="weq-onebot-server-form" onSubmit={(event) => void onSave(event)}>
                <label>
                  <span>名称</span>
                  <input
                    className="weq-set-input"
                    aria-label="OneBot 服务器名称"
                    value={draft.name}
                    maxLength={80}
                    onChange={(event) =>
                      setDraft((current) => current && { ...current, name: event.target.value })
                    }
                  />
                </label>
                <div className="weq-onebot-form-pair">
                  <label>
                    <span>端口</span>
                    <input
                      className="weq-set-input weq-number"
                      aria-label="OneBot 服务器端口"
                      type="number"
                      min={1024}
                      max={65535}
                      value={draft.port}
                      onChange={(event) =>
                        setDraft((current) => current && { ...current, port: event.target.value })
                      }
                    />
                  </label>
                  <div className="weq-onebot-toggle-field">
                    <span>保存后启用</span>
                    <Toggle
                      checked={draft.enabled}
                      label="保存后启用服务器"
                      onChange={(enabled) =>
                        setDraft((current) => current && { ...current, enabled })
                      }
                    />
                  </div>
                </div>
                <label>
                  <span>访问令牌</span>
                  <div className="weq-onebot-token-input">
                    <input
                      className="weq-set-input"
                      aria-label="OneBot 服务器访问令牌"
                      type={revealToken ? 'text' : 'password'}
                      value={draft.token}
                      spellCheck={false}
                      onChange={(event) =>
                        setDraft((current) => current && { ...current, token: event.target.value })
                      }
                    />
                    <button
                      type="button"
                      className="weq-set-iconbtn"
                      title={revealToken ? '隐藏令牌' : '显示令牌'}
                      aria-label={revealToken ? '隐藏服务器令牌' : '显示服务器令牌'}
                      onClick={() => setRevealToken((value) => !value)}
                    >
                      {revealToken ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                    <button
                      type="button"
                      className="weq-set-iconbtn"
                      title="生成新令牌"
                      aria-label="为服务器生成新令牌"
                      onClick={() =>
                        setDraft((current) => current && { ...current, token: generatedToken() })
                      }
                    >
                      <RefreshCw size={14} />
                    </button>
                  </div>
                </label>
                {draft.type === 'http' ? (
                  <div className="weq-onebot-inline-toggle">
                    <span>
                      <strong>允许跨域</strong>
                      <small>供浏览器中的 OneBot 客户端直接调用</small>
                    </span>
                    <Toggle
                      checked={draft.enableCors}
                      label="允许 HTTP 跨域"
                      onChange={(enableCors) =>
                        setDraft((current) => current && { ...current, enableCors })
                      }
                    />
                  </div>
                ) : null}
                <div className="weq-onebot-server-form-actions">
                  <button
                    type="button"
                    className="weq-set-btn weq-set-btn-soft"
                    onClick={() => setDraft(null)}
                  >
                    <X size={13} />
                    取消
                  </button>
                  <button type="submit" className="weq-set-btn" disabled={busy}>
                    {saveServer.isLoading ? (
                      <Loader2 size={13} className="weq-set-spin" />
                    ) : (
                      <Save size={13} />
                    )}
                    保存
                  </button>
                </div>
              </form>
            </li>
          ) : null}
        </ul>
      </Card>

      <Card title="cc-connect 配置" icon={<Server size={15} strokeWidth={1.8} />}>
        <Row
          label="正向 WebSocket"
          desc={
            wsServer
              ? `使用「${wsServer.name}」生成，地址为 ${wsServer.url}。`
              : '启用任意一个 WebSocket 服务器后即可生成。'
          }
          control={
            <button
              type="button"
              className="weq-set-btn"
              disabled={!wsServer}
              onClick={() => void copy(ccConnectConfig)}
            >
              <Copy size={14} />
              复制配置
            </button>
          }
        />
      </Card>
    </div>
  );
}
