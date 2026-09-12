/**
 * 设置 → MCP 服务器.
 *
 * 让外部 AI 客户端（Claude Desktop 等）通过本地 HTTP 读取*当前账号*的聊天数据。
 * 服务与账号绑定：仅在账号登录时监听，切换/退出账号自动停止。只绑 127.0.0.1，
 * 每个请求需带 Bearer 令牌。
 *
 * 后端契约（bootstrap router）：
 *   - getMcpStatus        — { enabled, running, port, token(全量), host, url }
 *   - setMcpEnabled       — 开关（首次开启自动生成令牌）；可能因端口占用抛错
 *   - setMcpPort          — 改端口（运行中会重启）
 *   - regenerateMcpToken  — 重新生成令牌
 *   - getMcpClientConfig  — 可粘贴的客户端配置 JSON 片段
 *   - listMcpAgentTargets — 扫描本机已安装的 MCP 客户端（含安装状态）
 *   - installMcpToAgents  — 把 WeQ 写入选中的客户端（自动启用服务，不重复安装）
 *
 * 查询用 staleTime:0 + refetchOnMount:'always'，避免重开弹窗看到旧值。
 */

import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import {
  AlertCircle,
  Check,
  ClipboardCopy,
  Copy,
  Download,
  Eye,
  EyeOff,
  KeyRound,
  Plug,
  RefreshCw,
  RotateCcw,
} from 'lucide-react';
import { trpc } from '../../trpc/client';
import { useDialog } from '../Dialog';
import { useToast } from '../Toast';
import { Card, Row, SectionHeader, Toggle } from './controls';

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

interface AgentTarget {
  key: string;
  name: string;
  configPath: string;
  available: boolean;
  installed: boolean;
  upToDate: boolean;
  error?: string;
}

export function McpServerSection(): ReactElement {
  const showError = useDialog((s) => s.showError);
  const pushToast = useToast((s) => s.push);

  const status = trpc.bootstrap.getMcpStatus.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const clientConfig = trpc.bootstrap.getMcpClientConfig.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });

  const setEnabled = trpc.bootstrap.setMcpEnabled.useMutation();
  const setPort = trpc.bootstrap.setMcpPort.useMutation();
  const regen = trpc.bootstrap.regenerateMcpToken.useMutation();
  const busy = setEnabled.isLoading || setPort.isLoading || regen.isLoading;

  const data = status.data;
  const agentTargets = trpc.bootstrap.listMcpAgentTargets.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const installToAgents = trpc.bootstrap.installMcpToAgents.useMutation();
  const token = data?.token ?? '';
  const [reveal, setReveal] = useState(false);
  const [copiedToken, setCopiedToken] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [copiedConfig, setCopiedConfig] = useState(false);
  const [portDraft, setPortDraft] = useState('');
  const [selectedAgents, setSelectedAgents] = useState<Set<string>>(new Set());
  const hydratedAgents = useRef(false);

  /** 只展示本机确实存在的客户端，并按安装状态分组。 */
  const visibleTargets = useMemo(
    () => (agentTargets.data ?? []).filter((t) => t.available),
    [agentTargets.data],
  );
  const actionableTargets = useMemo(
    () => visibleTargets.filter((t) => !t.installed || !t.upToDate),
    [visibleTargets],
  );

  // 首次扫描完成时默认勾选所有可安装 / 可更新的客户端；之后用户手动改选不覆盖。
  useEffect(() => {
    if (!agentTargets.data || hydratedAgents.current) return;
    hydratedAgents.current = true;
    setSelectedAgents(
      new Set(
        agentTargets.data
          .filter((t) => t.available && (!t.installed || !t.upToDate))
          .map((t) => t.key),
      ),
    );
  }, [agentTargets.data]);

  // 扫描结果变化后，把已不存在的勾选清掉（例如刚安装完已变成「已是最新」）。
  useEffect(() => {
    const actionableKeys = new Set(actionableTargets.map((t) => t.key));
    setSelectedAgents((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const key of prev) {
        if (actionableKeys.has(key)) {
          next.add(key);
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [actionableTargets]);

  // Sync the port input whenever the server reports a (possibly changed) port.
  useEffect(() => {
    if (data?.port != null) setPortDraft(String(data.port));
  }, [data?.port]);

  const maskedToken = token ? '•'.repeat(Math.min(token.length, 48)) : '';

  async function copyText(text: string, onOk?: () => void): Promise<void> {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      onOk?.();
      pushToast({ tone: 'success', title: '已复制到剪贴板' });
      window.setTimeout(() => {
        setCopiedToken(false);
        setCopiedUrl(false);
        setCopiedConfig(false);
      }, 1500);
    } catch (e) {
      showError('复制失败', errMsg(e));
    }
  }

  async function onToggle(next: boolean): Promise<void> {
    try {
      const requested = data?.port;
      const result = await setEnabled.mutateAsync({ enabled: next });
      if (next && requested != null && result.port !== requested) {
        pushToast({
          tone: 'info',
          title: '端口已自动调整',
          message: `${requested} 被占用，MCP 服务器现监听 ${result.port}`,
        });
      }
      await status.refetch();
      await clientConfig.refetch();
      await agentTargets.refetch();
    } catch (e) {
      showError(next ? '启动 MCP 服务器失败' : '停止 MCP 服务器失败', errMsg(e));
      await status.refetch();
    }
  }

  async function onSavePort(): Promise<void> {
    const port = Number(portDraft);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      showError('端口无效', '请输入 1–65535 之间的端口号。');
      return;
    }
    if (data && port === data.port) return;
    try {
      const result = await setPort.mutateAsync({ port });
      await status.refetch();
      await clientConfig.refetch();
      await agentTargets.refetch();
      if (result.port !== port) {
        pushToast({
          tone: 'info',
          title: '端口已自动调整',
          message: `${port} 被占用，MCP 服务器现监听 ${result.port}`,
        });
      } else {
        pushToast({ tone: 'success', title: '端口已更新', message: `MCP 服务器现监听 ${port}` });
      }
    } catch (e) {
      showError('修改端口失败', errMsg(e));
      await status.refetch();
    }
  }

  async function onRegen(): Promise<void> {
    try {
      await regen.mutateAsync();
      await status.refetch();
      await clientConfig.refetch();
      await agentTargets.refetch();
      pushToast({ tone: 'success', title: '令牌已重新生成' });
    } catch (e) {
      showError('重新生成令牌失败', errMsg(e));
    }
  }

  async function onRescan(): Promise<void> {
    hydratedAgents.current = false;
    await agentTargets.refetch();
  }

  function toggleAgent(key: string): void {
    setSelectedAgents((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  function agentStatus(t: AgentTarget): { tone: 'ok' | 'stale' | 'new'; text: string } {
    if (t.installed && t.upToDate) return { tone: 'ok', text: '已是最新' };
    if (t.installed) return { tone: 'stale', text: '需更新' };
    return { tone: 'new', text: '可安装' };
  }

  async function onInstallAgents(): Promise<void> {
    const targets = [...selectedAgents];
    if (!targets.length) return;
    try {
      const result = await installToAgents.mutateAsync({ targets });
      await status.refetch();
      await clientConfig.refetch();
      await agentTargets.refetch();

      const ok = result.results.filter((r) =>
        ['installed', 'updated', 'up-to-date'].includes(r.status),
      ).length;
      const errors = result.results.filter((r) => r.status === 'error');
      const skipped = result.results.filter((r) => r.status === 'skipped').length;
      if (errors.length) {
        showError(
          '部分客户端安装失败',
          errors.map((e) => `${e.name}：${e.message ?? '未知错误'}`).join('\n'),
        );
      } else if (result.results.length === 0) {
        pushToast({ tone: 'info', title: '没有可安装的客户端' });
      } else {
        const parts: string[] = [];
        if (ok) parts.push(`${ok} 个成功`);
        if (skipped) parts.push(`${skipped} 个跳过`);
        pushToast({
          tone: errors.length ? 'error' : 'success',
          title: parts.length ? `安装完成（${parts.join('，')}）` : '安装完成',
          message: '重启 AI 客户端后即可在对话中调用 WeQ 工具。',
        });
      }
    } catch (e) {
      showError('安装到客户端失败', errMsg(e));
    }
  }

  const enabled = data?.enabled ?? false;
  const running = data?.running ?? false;

  return (
    <div className="weq-set">
      <SectionHeader
        icon={<Plug size={16} strokeWidth={1.8} />}
        title="MCP 服务器"
        desc="开启后，支持 MCP 的 AI 客户端可通过本地接口读取当前账号的聊天数据；也可以一键安装到本机已有的 AI 客户端。"
      />

      {/* Switch + live state */}
      <Card title="服务开关">
        <Row
          label="启用 MCP 服务器"
          desc="仅在已登录账号时监听；切换或退出账号会自动停止。"
          control={
            <Toggle
              checked={enabled}
              disabled={busy || status.isLoading}
              onChange={(next) => void onToggle(next)}
              label="启用 MCP 服务器"
            />
          }
        />
        <Row
          label={
            <span className="weq-set-mcp-state">
              <span className={`weq-set-mcp-dot${running ? ' is-on' : ''}`} aria-hidden />
              {running ? '运行中' : enabled ? '已启用（等待账号）' : '已停止'}
            </span>
          }
          desc={data ? data.url : '—'}
          control={
            <button
              type="button"
              className="weq-set-btn weq-set-btn-soft weq-set-btn-sm"
              disabled={!data?.url}
              onClick={() => void copyText(data?.url ?? '', () => setCopiedUrl(true))}
            >
              {copiedUrl ? <Check size={13} className="weq-set-ok" /> : <Copy size={13} />}
              复制地址
            </button>
          }
        />
      </Card>

      {/* Connection details */}
      <Card title="连接信息">
        <Row
          label="端口"
          desc="修改后会立即重启服务（若正在运行）。"
          control={
            <div className="weq-set-btn-group">
              <input
                className="weq-set-input weq-set-input-sm weq-number"
                value={portDraft}
                inputMode="numeric"
                spellCheck={false}
                disabled={busy}
                onChange={(e) => setPortDraft(e.target.value.replace(/[^0-9]/g, ''))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void onSavePort();
                }}
                aria-label="MCP 端口"
              />
              <button
                type="button"
                className="weq-set-btn weq-set-btn-sm"
                disabled={busy || portDraft === String(data?.port ?? '')}
                onClick={() => void onSavePort()}
              >
                保存
              </button>
            </div>
          }
        />

        <div className="weq-set-keyfield">
          <KeyRound size={15} strokeWidth={1.8} className="weq-set-keyfield-icon" aria-hidden />
          <code className="weq-set-keyval">
            {token ? (reveal ? token : maskedToken) : status.isLoading ? '读取中…' : '未生成'}
          </code>
          <div className="weq-set-keyfield-actions">
            <button
              type="button"
              className="weq-set-iconbtn"
              title={reveal ? '隐藏' : '显示'}
              aria-label={reveal ? '隐藏令牌' : '显示令牌'}
              disabled={!token}
              onClick={() => setReveal((v) => !v)}
            >
              {reveal ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
            <button
              type="button"
              className="weq-set-iconbtn"
              title="复制"
              aria-label="复制令牌"
              disabled={!token}
              onClick={() => void copyText(token, () => setCopiedToken(true))}
            >
              {copiedToken ? <Check size={15} className="weq-set-ok" /> : <Copy size={15} />}
            </button>
            <button
              type="button"
              className="weq-set-iconbtn"
              title="重新生成"
              aria-label="重新生成令牌"
              disabled={busy}
              onClick={() => void onRegen()}
            >
              <RotateCcw size={15} />
            </button>
          </div>
        </div>
        <p className="weq-set-note">
          访问令牌（Bearer Token）。客户端每次请求需在 <code>Authorization</code> 头携带它。
        </p>

        <div className="weq-set-actions">
          <button
            type="button"
            className="weq-set-btn"
            disabled={!clientConfig.data}
            onClick={() => void copyText(clientConfig.data ?? '', () => setCopiedConfig(true))}
          >
            {copiedConfig ? (
              <Check size={14} className="weq-set-ok" />
            ) : (
              <ClipboardCopy size={14} strokeWidth={1.8} />
            )}
            复制客户端配置
          </button>
        </div>
      </Card>

      {/* Install into local agents */}
      <Card
        title="安装到本机 AI 客户端"
        action={
          <button
            type="button"
            className="weq-set-btn weq-set-btn-soft weq-set-btn-sm"
            disabled={agentTargets.isFetching}
            onClick={() => void onRescan()}
          >
            <RefreshCw size={13} className={agentTargets.isFetching ? 'is-spin' : ''} />
            重新扫描
          </button>
        }
      >
        <p className="weq-set-note">
          自动把当前地址与访问令牌写入所选客户端的 MCP 配置；若服务尚未启用会先自动开启。
          同一客户端只保留一个 <code>weq</code> 条目，不会重复安装。
        </p>

        {agentTargets.isLoading ? (
          <p className="weq-set-empty">正在扫描本机客户端…</p>
        ) : visibleTargets.length === 0 ? (
          <div className="weq-set-empty">
            <AlertCircle size={15} aria-hidden />
            没找到本机已安装的 MCP 客户端。请先安装 Claude Code / Codex / Cursor / VS Code
            等，再回来扫描。
          </div>
        ) : (
          <div className="weq-set-agent-list">
            {visibleTargets.map((t) => {
              const actionable = !t.installed || !t.upToDate;
              const status = agentStatus(t);
              const checked = selectedAgents.has(t.key);
              return (
                <div
                  key={t.key}
                  className={`weq-set-agent-item${actionable ? ' is-actionable' : ''}${
                    checked ? ' is-on' : ''
                  }`}
                  role="checkbox"
                  aria-checked={actionable && checked}
                  aria-disabled={!actionable}
                  onClick={() => {
                    if (actionable) toggleAgent(t.key);
                  }}
                >
                  <span className={`weq-set-agent-chk${checked ? ' is-on' : ''}`} aria-hidden>
                    {checked ? <Check size={12} /> : null}
                  </span>
                  <span className="weq-set-agent-main">
                    <span className="weq-set-agent-name">{t.name}</span>
                    <code className="weq-set-agent-path">{t.configPath}</code>
                  </span>
                  <span
                    className={`weq-set-agent-tag is-${status.tone}`}
                    title={
                      status.tone === 'stale' ? '地址或令牌已变化，可勾选后重新写入' : undefined
                    }
                  >
                    {status.text}
                  </span>
                  {t.error ? (
                    <span className="weq-set-agent-tag is-error" title={t.error}>
                      读取失败
                    </span>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}

        {actionableTargets.length > 1 ? (
          <button
            type="button"
            className="weq-set-linkbtn"
            disabled={installToAgents.isLoading}
            onClick={() =>
              setSelectedAgents((prev) =>
                prev.size === actionableTargets.length
                  ? new Set()
                  : new Set(actionableTargets.map((t) => t.key)),
              )
            }
          >
            {selectedAgents.size === actionableTargets.length ? '清空选择' : '全选'}
          </button>
        ) : null}

        <div className="weq-set-actions">
          <button
            type="button"
            className="weq-set-btn"
            disabled={!selectedAgents.size || installToAgents.isLoading}
            onClick={() => void onInstallAgents()}
          >
            <Download size={14} strokeWidth={1.8} />
            {installToAgents.isLoading ? '正在安装…' : `安装到已选客户端（${selectedAgents.size}）`}
          </button>
        </div>
      </Card>
    </div>
  );
}
