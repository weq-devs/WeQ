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
 *
 * 查询用 staleTime:0 + refetchOnMount:'always'，避免重开弹窗看到旧值。
 */

import { useEffect, useState, type ReactElement } from 'react';
import { Check, ClipboardCopy, Copy, Eye, EyeOff, KeyRound, Plug, RotateCcw } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { useDialog } from '../Dialog';
import { Card, Row, SectionHeader, Toggle } from './controls';

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const TOOLS: Array<{ name: string; desc: string }> = [
  { name: 'search_messages', desc: '全文搜索聊天记录' },
  { name: 'list_conversations', desc: '最近会话列表' },
  { name: 'get_messages', desc: '读取某会话最新消息' },
  { name: 'list_groups', desc: '群聊列表' },
  { name: 'list_buddies', desc: '好友列表' },
  { name: 'get_self_profile', desc: '自己的资料' },
];

export function McpServerSection(): ReactElement {
  const showError = useDialog((s) => s.showError);

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
  const token = data?.token ?? '';
  const [reveal, setReveal] = useState(false);
  const [copiedToken, setCopiedToken] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [copiedConfig, setCopiedConfig] = useState(false);
  const [portDraft, setPortDraft] = useState('');

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
      await setEnabled.mutateAsync({ enabled: next });
      await status.refetch();
      await clientConfig.refetch();
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
      await setPort.mutateAsync({ port });
      await status.refetch();
      await clientConfig.refetch();
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
    } catch (e) {
      showError('重新生成令牌失败', errMsg(e));
    }
  }

  const enabled = data?.enabled ?? false;
  const running = data?.running ?? false;

  return (
    <div className="weq-set">
      <SectionHeader
        title="MCP 服务器"
        desc="开启后，Claude Desktop 等支持 MCP 的 AI 客户端可通过本地接口读取当前账号的聊天数据。"
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
              <span
                className={`weq-set-mcp-dot${running ? ' is-on' : ''}`}
                aria-hidden
              />
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

      {/* Available tools */}
      <Card title="可用工具">
        <ul className="weq-set-mcp-tools">
          {TOOLS.map((t) => (
            <li key={t.name} className="weq-set-mcp-tool">
              <Plug size={13} strokeWidth={1.8} aria-hidden />
              <code>{t.name}</code>
              <span className="weq-set-mcp-tool-desc">{t.desc}</span>
            </li>
          ))}
        </ul>
        <p className="weq-set-note">
          全部为只读工具，且仅监听本机 127.0.0.1。请勿把地址与令牌暴露到公网。
        </p>
      </Card>
    </div>
  );
}
