import { useEffect, useState, type ReactElement } from 'react';
import type {
  ControlHttpClient,
  ControlHttpServer,
  ControlOneBotConfig,
  ControlOneBotListener,
  ControlWsClient,
  ControlWsServer,
} from '@weqbot/control';
import {
  ArrowLeftRight,
  Copy,
  Eye,
  EyeOff,
  Globe2,
  Loader2,
  Pencil,
  Plus,
  Power,
  RadioTower,
  RefreshCw,
  Save,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { trpc } from '../../trpc/client';
import { useTabActive } from '../RetainedTabs.shared';
import { useDialog } from '../Dialog.shared';
import { useToast } from '../Toast.shared';
import { EditorDialog } from '../EditorDialog';
import { useDraftClose } from '../../lib/draftClose';
import { z } from 'zod';
import { usePageDraftConfirmation, usePageState } from '../PageSnapshots.shared';
import { Card, QueryError, Row, SectionHeader, Toggle } from './controls';
import { SETTINGS_PAGE_LABELS } from './navigation';
import '../../styles/settings-onebot.css';

/**
 * OneBot 网络配置。
 *
 * 四类网络与 weqbot kernel 一一对应：
 *
 *   - **正向 WS**（`wsServers`）：WeQ 监听，客户端连进来（NapCat / Koishi 常用）；
 *   - **反向 WS**（`wsClients`）：WeQ 主动连客户端（NoneBot 的 `ws_reverse`）；
 *   - **HTTP 服务端**（`httpServers`）：标准 OneBot v11 HTTP API；
 *   - **HTTP 上报**（`httpClients`）：把事件 POST 到客户端。
 *
 * 配置存在 WeQ 的设置里（按账号），执行在 weqbot daemon —— 页面上的「运行中」
 * 来自 daemon 的实际监听，不是配置里的期望值。
 *
 * ⚠️ **QQ 在线时（mode 1）只发不收**：action 全部可用，但不会有任何事件。
 * 需要事件的用户应当让 QQ 离线后以 bot 方式上线（mode 2），或自己接 SSE 推送。
 */

type NetworkKey = 'wsServers' | 'wsClients' | 'httpServers' | 'httpClients';

interface NetworkMeta {
  key: NetworkKey;
  title: string;
  kind: string;
  icon: ReactElement;
  /** 服务端要端口，客户端要 URL。 */
  mode: 'listen' | 'connect';
  desc: string;
}

const NETWORKS: NetworkMeta[] = [
  {
    key: 'wsServers',
    title: '正向 WebSocket',
    kind: 'ws-server',
    icon: <RadioTower size={15} strokeWidth={1.8} />,
    mode: 'listen',
    desc: 'WeQ 监听端口，客户端连进来。',
  },
  {
    key: 'wsClients',
    title: '反向 WebSocket',
    kind: 'ws-client',
    icon: <ArrowLeftRight size={15} strokeWidth={1.8} />,
    mode: 'connect',
    desc: 'WeQ 主动连接客户端的 WS 地址（NoneBot 的 ws_reverse）。',
  },
  {
    key: 'httpServers',
    title: 'HTTP 服务端',
    kind: 'http-server',
    icon: <Globe2 size={15} strokeWidth={1.8} />,
    mode: 'listen',
    desc: '标准 OneBot v11 HTTP API，可选在同一端口接受 WS。',
  },
  {
    key: 'httpClients',
    title: 'HTTP 上报',
    kind: 'http-client',
    icon: <Upload size={15} strokeWidth={1.8} />,
    mode: 'connect',
    desc: '把事件 POST 到客户端的 HTTP 地址。',
  },
];

/** 编辑抽屉里的草稿：统一成字符串，保存时再解析。 */
interface NetworkDraft {
  key: NetworkKey;
  /** 编辑已有条目时是原名字；新建时是空串。 */
  original: string;
  name: string;
  enabled: boolean;
  host: string;
  port: string;
  path: string;
  url: string;
  role: 'Api' | 'Event' | 'Universal';
  messageFormat: 'array' | 'string';
  accessToken: string;
  reportSelfMessage: boolean;
  enableWebSocket: boolean;
  reconnectIntervalMs: string;
  timeoutMs: string;
}

const networkDraftSchema = z
  .object({
    key: z.enum(['wsServers', 'wsClients', 'httpServers', 'httpClients']),
    original: z.string(),
    name: z.string(),
    enabled: z.boolean(),
    host: z.string(),
    port: z.string(),
    path: z.string(),
    url: z.string(),
    role: z.enum(['Api', 'Event', 'Universal']),
    messageFormat: z.enum(['array', 'string']),
    accessToken: z.string(),
    reportSelfMessage: z.boolean(),
    enableWebSocket: z.boolean(),
    reconnectIntervalMs: z.string(),
    timeoutMs: z.string(),
  })
  .nullable();

function generatedToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

function emptyConfig(): ControlOneBotConfig {
  return { networks: { wsServers: [], wsClients: [], httpServers: [], httpClients: [] } };
}

function draftOf(key: NetworkKey, entry: Record<string, unknown> | null): NetworkDraft {
  const server = (entry ?? {}) as Record<string, unknown>;
  return {
    key,
    original: typeof server.name === 'string' ? server.name : '',
    name: typeof server.name === 'string' ? server.name : '',
    enabled: server.enabled !== false,
    host: typeof server.host === 'string' ? server.host : '',
    port: typeof server.port === 'number' ? String(server.port) : '',
    path: typeof server.path === 'string' ? server.path : '',
    url: typeof server.url === 'string' ? server.url : '',
    role: (server.role as NetworkDraft['role']) ?? 'Universal',
    messageFormat: server.messageFormat === 'string' ? 'string' : 'array',
    accessToken: typeof server.accessToken === 'string' ? server.accessToken : '',
    reportSelfMessage: server.reportSelfMessage !== false,
    enableWebSocket: server.enableWebSocket === true,
    reconnectIntervalMs:
      typeof server.reconnectIntervalMs === 'number' ? String(server.reconnectIntervalMs) : '',
    timeoutMs: typeof server.timeoutMs === 'number' ? String(server.timeoutMs) : '',
  };
}

/** 草稿 → 配置里的一行。空的可选字段直接不写，别让配置里堆 `""`。 */
function entryOf(draft: NetworkDraft): Record<string, unknown> {
  const base: Record<string, unknown> = {
    name: draft.name.trim(),
    enabled: draft.enabled,
    messageFormat: draft.messageFormat,
    reportSelfMessage: draft.reportSelfMessage,
    ...(draft.accessToken.trim() ? { accessToken: draft.accessToken.trim() } : {}),
  };
  if (draft.key === 'wsClients' || draft.key === 'httpClients') {
    base.url = draft.url.trim();
    if (draft.key === 'wsClients') {
      base.role = draft.role;
      if (draft.reconnectIntervalMs.trim()) {
        base.reconnectIntervalMs = Number(draft.reconnectIntervalMs);
      }
    } else if (draft.timeoutMs.trim()) {
      base.timeoutMs = Number(draft.timeoutMs);
    }
    return base;
  }
  base.port = Number(draft.port);
  if (draft.host.trim()) base.host = draft.host.trim();
  if (draft.path.trim()) base.path = draft.path.trim();
  if (draft.key === 'wsServers') base.role = draft.role;
  if (draft.key === 'httpServers') base.enableWebSocket = draft.enableWebSocket;
  return base;
}

function endpointOf(key: NetworkKey, entry: Record<string, unknown>): string {
  if (key === 'wsClients' || key === 'httpClients') return String(entry.url ?? '');
  const host = typeof entry.host === 'string' && entry.host ? entry.host : '127.0.0.1';
  const scheme = key === 'wsServers' ? 'ws' : 'http';
  const path = typeof entry.path === 'string' ? entry.path : '';
  return `${scheme}://${host}:${String(entry.port ?? '?')}${path}`;
}

export function OneBotSection(): ReactElement {
  const active = useTabActive();
  const status = trpc.bootstrap.getOneBotStatus.useQuery(undefined, {
    enabled: active,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchInterval: active ? 5000 : false,
  });
  const save = trpc.bootstrap.saveOneBotConfig.useMutation();
  const showError = useDialog((s) => s.showError);
  const toast = useToast((s) => s.push);

  const [draft, setDraft] = usePageState<NetworkDraft | null>(
    'onebot:draft',
    null,
    networkDraftSchema,
    true,
  );
  usePageDraftConfirmation('onebot:draft', null);
  const [revealToken, setRevealToken] = useState(false);
  useEffect(() => {
    if (!active) setRevealToken(false);
  }, [active]);

  const data = status.data;
  const config = data?.config ?? null;
  const busy = save.isLoading;
  // 关闭抽屉时要问一句「放弃未保存的修改？」—— 网络配置改错一个端口就会让
  // bot 连不上，静默丢弃比多问一句更糟。
  const protection = useDraftClose(() => setDraft(null), draft, busy);
  // 从页面现场恢复的草稿同样算未保存：关闭前仍要确认一次。
  useEffect(() => protection.reset(null), [protection.reset]);

  async function refetch(): Promise<void> {
    await status.refetch();
  }

  /**
   * 保存整份配置。
   *
   * 一次提交全部：daemon 的 `onebot.set` 会先停旧再起新，逐条保存会让正在用的
   * 网络反复重启。失败时 daemon 会回滚旧配置，页面重新拉一次就能看到实际情况。
   */
  async function persist(next: ControlOneBotConfig, success: string): Promise<boolean> {
    try {
      const result = await save.mutateAsync({ config: next });
      if (result.daemonCheck) {
        // 配置已保存，但 daemon 起不来 —— 这不是「保存失败」，要说清楚。
        showError('配置已保存，但 OneBot 没能启动', result.daemonCheck);
      } else {
        toast({ tone: 'success', title: success });
      }
      return true;
    } catch (error) {
      showError('OneBot 配置失败', error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      await refetch();
    }
  }

  async function writeNetwork(key: NetworkKey, rows: Record<string, unknown>[]): Promise<boolean> {
    const base = config ?? emptyConfig();
    return persist(
      {
        ...base,
        networks: { ...base.networks, [key]: rows } as ControlOneBotConfig['networks'],
      },
      'OneBot 网络配置已更新',
    );
  }

  function startCreate(meta: NetworkMeta): void {
    const rows = (config?.networks[meta.key] ?? []) as unknown as Array<Record<string, unknown>>;
    setDraft({
      ...draftOf(meta.key, null),
      name: `${meta.title} ${rows.length + 1}`,
      accessToken: generatedToken(),
      enabled: true,
    });
    setRevealToken(false);
  }

  function startEdit(meta: NetworkMeta, entry: Record<string, unknown>): void {
    setDraft(draftOf(meta.key, entry));
    setRevealToken(false);
  }

  async function remove(meta: NetworkMeta, entry: Record<string, unknown>): Promise<void> {
    const rows = (config?.networks[meta.key] ?? []) as unknown as Array<Record<string, unknown>>;
    await writeNetwork(
      meta.key,
      rows.filter((row) => row.name !== entry.name),
    );
  }

  async function toggle(
    meta: NetworkMeta,
    entry: Record<string, unknown>,
    enabled: boolean,
  ): Promise<void> {
    const rows = (config?.networks[meta.key] ?? []) as unknown as Array<Record<string, unknown>>;
    await writeNetwork(
      meta.key,
      rows.map((row) => (row.name === entry.name ? { ...row, enabled } : row)),
    );
  }

  async function onSave(): Promise<void> {
    if (!draft) return;
    if (!draft.name.trim()) {
      showError('名称不能为空', '同一个网络里名称必须唯一，页面靠它区分卡片。');
      return;
    }
    if (draft.key === 'wsClients' || draft.key === 'httpClients') {
      if (!draft.url.trim()) {
        showError('地址不能为空', '反向连接需要填写完整地址，例如 ws://127.0.0.1:6700/。');
        return;
      }
    } else {
      const port = Number(draft.port);
      if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
        showError('端口无效', '端口需为 1 – 65535 之间的整数。');
        return;
      }
    }

    const rows = (config?.networks[draft.key] ?? []) as unknown as Array<Record<string, unknown>>;
    const entry = entryOf(draft);
    const exists = rows.some((row) => row.name === draft.original);
    const next = exists
      ? rows.map((row) => (row.name === draft.original ? entry : row))
      : [...rows, entry];

    if (await writeNetwork(draft.key, next)) setDraft(null);
  }

  async function copy(value: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      toast({ tone: 'success', title: '已复制' });
    } catch (error) {
      showError('复制失败', error instanceof Error ? error.message : String(error));
    }
  }

  /** 监听状态按名字匹配：配置里有、daemon 里没有 = 没起来。 */
  const listenerByName = new Map<string, ControlOneBotListener>(
    (data?.listeners ?? []).map((listener) => [`${listener.kind}:${listener.name}`, listener]),
  );

  const draftMeta = draft ? NETWORKS.find((meta) => meta.key === draft.key) : null;

  return (
    <div className="weq-set weq-set-onebot">
      <SectionHeader
        title={SETTINGS_PAGE_LABELS.onebot}
        page="onebot"
        desc="网络配置按账号保存，由 weqbot daemon 执行。端口被占用时直接报错、不会自动顺延 —— 客户端里写死的就是这个端口。"
      />

      <Card title="状态" icon={<Power size={15} strokeWidth={1.8} />}>
        {status.error ? (
          <QueryError
            message={status.error.message}
            retryLabel="重新读取"
            retrying={status.isFetching}
            onRetry={() => void refetch()}
          />
        ) : null}
        <Row
          label="账号"
          desc={data?.uin ? `配置属于 ${data.uin}，切换账号会换成另一份。` : '没有打开的账号。'}
          control={<span>{data?.uin ?? '—'}</span>}
        />
        <Row
          label="运行状态"
          desc={
            data?.daemonCheck
              ? '配置已保存，但 daemon 没能启动，详见错误提示。'
              : '实时监听来自 weqbot daemon；「未在监听」表示端口没起来。'
          }
          control={
            <span className="weq-set-row-status">
              {data?.daemonCheck
                ? 'daemon 未就绪'
                : (data?.listeners.length ?? 0) > 0
                  ? `${data?.listeners.filter((listener) => listener.state === 'listening' || listener.state === 'connected').length ?? 0} 个在网络中运行 · ${data?.listeners.reduce((sum, listener) => sum + (listener.clients ?? 0), 0) ?? 0} 个连接`
                  : data?.enabled
                    ? '尚未监听'
                    : '未配置'}
            </span>
          }
        />
        <Row
          label="事件推送"
          desc="QQ 在线时 WeQ 借 QQ 的会话（mode 1），这条链路只发不收：action 全部可用，但不会有消息事件。需要事件请让 QQ 离线后以 bot 方式上线（mode 2），或使用 SSE 推送。"
          control={<span>mode 1 无事件</span>}
        />
      </Card>

      {NETWORKS.map((meta) => {
        const rows = (config?.networks[meta.key] ?? []) as unknown as Array<
          Record<string, unknown>
        >;
        return (
          <Card
            key={meta.key}
            title={meta.title}
            icon={meta.icon}
            action={
              <button
                type="button"
                className="weq-set-btn weq-set-btn-sm"
                disabled={busy || !data?.uin}
                onClick={() => startCreate(meta)}
              >
                <Plus size={13} />
                新建
              </button>
            }
          >
            <p className="weq-onebot-network-desc">{meta.desc}</p>
            {rows.length === 0 ? (
              <div className="weq-set-empty">还没有配置。</div>
            ) : (
              <ul className="weq-onebot-server-grid">
                {rows.map((entry) => {
                  const name = String(entry.name ?? '');
                  const listener = listenerByName.get(`${meta.kind}:${name}`);
                  const enabled = entry.enabled !== false;
                  const live = listener?.state === 'listening' || listener?.state === 'connected';
                  const label = !enabled
                    ? '未启用'
                    : live
                      ? meta.mode === 'listen'
                        ? `运行中 · ${listener?.clients ?? 0} 个连接`
                        : '已连接'
                      : listener?.state === 'error'
                        ? '启动失败'
                        : data?.daemonCheck
                          ? 'daemon 未就绪'
                          : '未在监听';
                  return (
                    <li
                      key={`${meta.key}:${name}`}
                      className={`weq-onebot-server-card${live ? ' is-running' : ''}${enabled ? ' is-enabled' : ''}`}
                    >
                      <div className="weq-onebot-server-head">
                        <span className="weq-onebot-server-icon" aria-hidden>
                          {meta.icon}
                        </span>
                        <div className="weq-onebot-server-title">
                          <strong title={name}>{name}</strong>
                          <span>{meta.title}</span>
                        </div>
                        <Toggle
                          checked={enabled}
                          disabled={busy}
                          label={`启用 ${name}`}
                          onChange={(next) => void toggle(meta, entry, next)}
                        />
                      </div>
                      <div className="weq-onebot-server-fields">
                        <div>
                          <span>{meta.mode === 'listen' ? '监听地址' : '目标地址'}</span>
                          <code title={endpointOf(meta.key, entry)}>
                            {endpointOf(meta.key, entry)}
                          </code>
                        </div>
                        <div>
                          <span>令牌</span>
                          <code>{entry.accessToken ? '已设置访问令牌' : '无需鉴权'}</code>
                        </div>
                      </div>
                      <div className="weq-onebot-server-status">
                        <span className={`weq-onebot-status-dot${live ? ' is-live' : ''}`} />
                        <span>{label}</span>
                      </div>
                      {listener?.error ? (
                        <p className="weq-onebot-server-error">{listener.error}</p>
                      ) : null}
                      <div className="weq-onebot-server-actions">
                        <button
                          type="button"
                          className="weq-set-iconbtn"
                          title="复制地址"
                          aria-label={`复制 ${name} 地址`}
                          onClick={() => void copy(endpointOf(meta.key, entry))}
                        >
                          <Copy size={14} />
                        </button>
                        <button
                          type="button"
                          className="weq-set-iconbtn"
                          title="编辑"
                          aria-label={`编辑 ${name}`}
                          disabled={busy}
                          onClick={() => startEdit(meta, entry)}
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          type="button"
                          className="weq-set-iconbtn"
                          title="删除"
                          aria-label={`删除 ${name}`}
                          disabled={busy}
                          onClick={() => void remove(meta, entry)}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        );
      })}

      {draft && draftMeta ? (
        <EditorDialog
          title={`${draft.original ? '编辑' : '新建'}${draftMeta.title}`}
          onClose={protection.requestClose}
          draft={draft}
          busy={busy}
        >
          <form
            className="weq-onebot-server-form"
            onSubmit={(event) => {
              event.preventDefault();
              void onSave();
            }}
          >
            <label>
              <span>名称</span>
              <input
                className="weq-set-input"
                aria-label="网络名称"
                value={draft.name}
                onChange={(event) =>
                  setDraft((current) => current && { ...current, name: event.target.value })
                }
              />
            </label>

            {draftMeta.mode === 'listen' ? (
              <div className="weq-onebot-form-pair">
                <label>
                  <span>端口</span>
                  <input
                    className="weq-set-input weq-number"
                    aria-label="端口"
                    type="number"
                    min={1}
                    max={65535}
                    value={draft.port}
                    onChange={(event) =>
                      setDraft((current) => current && { ...current, port: event.target.value })
                    }
                  />
                </label>
                <label>
                  <span>监听地址</span>
                  <input
                    className="weq-set-input"
                    aria-label="监听地址"
                    placeholder="127.0.0.1"
                    value={draft.host}
                    onChange={(event) =>
                      setDraft((current) => current && { ...current, host: event.target.value })
                    }
                  />
                </label>
              </div>
            ) : (
              <label>
                <span>目标地址</span>
                <input
                  className="weq-set-input"
                  aria-label="目标地址"
                  placeholder={
                    draft.key === 'wsClients' ? 'ws://127.0.0.1:6700/' : 'http://127.0.0.1:6700/'
                  }
                  value={draft.url}
                  onChange={(event) =>
                    setDraft((current) => current && { ...current, url: event.target.value })
                  }
                />
              </label>
            )}

            <div className="weq-onebot-form-pair">
              <label>
                <span>消息格式</span>
                <select
                  className="weq-set-input"
                  aria-label="消息格式"
                  value={draft.messageFormat}
                  onChange={(event) =>
                    setDraft(
                      (current) =>
                        current && {
                          ...current,
                          messageFormat: event.target.value as NetworkDraft['messageFormat'],
                        },
                    )
                  }
                >
                  <option value="array">array（消息段数组）</option>
                  <option value="string">string（CQ 码）</option>
                </select>
              </label>
              {draft.key !== 'httpClients' ? (
                <label>
                  <span>角色</span>
                  <select
                    className="weq-set-input"
                    aria-label="角色"
                    value={draft.role}
                    onChange={(event) =>
                      setDraft(
                        (current) =>
                          current && {
                            ...current,
                            role: event.target.value as NetworkDraft['role'],
                          },
                      )
                    }
                  >
                    <option value="Universal">Universal（action + 事件）</option>
                    <option value="Api">Api（只收 action）</option>
                    <option value="Event">Event（只收事件）</option>
                  </select>
                </label>
              ) : null}
            </div>

            <div className="weq-onebot-inline-toggle">
              <span>
                <strong>回报自己发出的消息</strong>
                <small>关闭后不推送 message_sent 事件</small>
              </span>
              <Toggle
                checked={draft.reportSelfMessage}
                label="回报自己发出的消息"
                onChange={(reportSelfMessage) =>
                  setDraft((current) => current && { ...current, reportSelfMessage })
                }
              />
            </div>

            <label>
              <span>访问令牌</span>
              <div className="weq-onebot-token-input">
                <input
                  className="weq-set-input"
                  aria-label="访问令牌"
                  type={revealToken ? 'text' : 'password'}
                  value={draft.accessToken}
                  spellCheck={false}
                  onChange={(event) =>
                    setDraft(
                      (current) => current && { ...current, accessToken: event.target.value },
                    )
                  }
                />
                <button
                  type="button"
                  className="weq-set-iconbtn"
                  title={revealToken ? '隐藏令牌' : '显示令牌'}
                  aria-label={revealToken ? '隐藏令牌' : '显示令牌'}
                  onClick={() => setRevealToken((value) => !value)}
                >
                  {revealToken ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
                <button
                  type="button"
                  className="weq-set-iconbtn"
                  title="生成新令牌"
                  aria-label="生成新令牌"
                  onClick={() =>
                    setDraft((current) => current && { ...current, accessToken: generatedToken() })
                  }
                >
                  <RefreshCw size={14} />
                </button>
              </div>
            </label>

            {draft.key === 'httpServers' ? (
              <div className="weq-onebot-inline-toggle">
                <span>
                  <strong>同一端口接受 WebSocket</strong>
                  <small>省一个端口，客户端可以走 ws:// 连进来</small>
                </span>
                <Toggle
                  checked={draft.enableWebSocket}
                  label="同一端口接受 WebSocket"
                  onChange={(enableWebSocket) =>
                    setDraft((current) => current && { ...current, enableWebSocket })
                  }
                />
              </div>
            ) : null}

            {draft.key === 'wsClients' ? (
              <label>
                <span>重连间隔（毫秒）</span>
                <input
                  className="weq-set-input weq-number"
                  aria-label="重连间隔"
                  type="number"
                  min={1000}
                  placeholder="5000"
                  value={draft.reconnectIntervalMs}
                  onChange={(event) =>
                    setDraft(
                      (current) =>
                        current && { ...current, reconnectIntervalMs: event.target.value },
                    )
                  }
                />
              </label>
            ) : null}

            {draft.key === 'httpClients' ? (
              <label>
                <span>上报超时（毫秒）</span>
                <input
                  className="weq-set-input weq-number"
                  aria-label="上报超时"
                  type="number"
                  min={1000}
                  placeholder="10000"
                  value={draft.timeoutMs}
                  onChange={(event) =>
                    setDraft((current) => current && { ...current, timeoutMs: event.target.value })
                  }
                />
              </label>
            ) : null}

            <div className="weq-onebot-inline-toggle">
              <span>
                <strong>保存后启用</strong>
                <small>关闭时只保存配置，不会启动这个网络</small>
              </span>
              <Toggle
                checked={draft.enabled}
                label="保存后启用"
                onChange={(enabled) => setDraft((current) => current && { ...current, enabled })}
              />
            </div>

            <div className="weq-onebot-server-form-actions">
              <button
                type="button"
                className="weq-set-btn weq-set-btn-soft"
                onClick={protection.requestClose}
              >
                <X size={13} />
                取消
              </button>
              <button type="submit" className="weq-set-btn weq-set-btn-primary" disabled={busy}>
                {save.isLoading ? (
                  <Loader2 size={13} className="weq-set-spin" />
                ) : (
                  <Save size={13} />
                )}
                保存
              </button>
            </div>
          </form>
        </EditorDialog>
      ) : null}
    </div>
  );
}

export type { ControlHttpClient, ControlHttpServer, ControlWsClient, ControlWsServer };
