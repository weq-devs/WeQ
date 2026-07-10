/**
 * 设置 → WeQ 助手.
 *
 * 与 MCP 不同，这个功能是往*真实的 QQ 数据库*里注入一个内置「WeQ助手」公众号会话，
 * 让它显示在 **QQ 本体** 里（WeQ 自身会过滤掉这类会话，不显示）。同时在本机
 * 20000+ 端口起一个 HTTP 服务，QQ 会请求它来渲染卡片封面、打开跳转网页。
 *
 * 后端契约（bootstrap router）：
 *   - getWeqAssistantStatus   — { enabled, running, port, host, url }
 *   - setWeqAssistantEnabled  — 开关（开启时在库里建会话 + 起服务；可能因端口占用抛错）
 *   - setWeqAssistantPort     — 改端口（重启服务并重写卡片里的端口）
 *
 * 目前只有「手动设置端口」一个设置项。查询用 staleTime:0 + refetchOnMount:'always'。
 */

import { useEffect, useState, type ReactElement } from 'react';
import { Check, Copy } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { useDialog } from '../Dialog';
import { useToast } from '../Toast';
import { Card, Row, SectionHeader, Toggle } from './controls';

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function WeqAssistantSection(): ReactElement {
  const showError = useDialog((s) => s.showError);
  const pushToast = useToast((s) => s.push);

  const status = trpc.bootstrap.getWeqAssistantStatus.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });

  const setEnabled = trpc.bootstrap.setWeqAssistantEnabled.useMutation();
  const setPort = trpc.bootstrap.setWeqAssistantPort.useMutation();
  const busy = setEnabled.isLoading || setPort.isLoading;

  const data = status.data;
  const [portDraft, setPortDraft] = useState('');
  const [copiedUrl, setCopiedUrl] = useState(false);

  useEffect(() => {
    if (data?.port != null) setPortDraft(String(data.port));
  }, [data?.port]);

  async function copyUrl(): Promise<void> {
    if (!data?.url) return;
    try {
      await navigator.clipboard.writeText(data.url);
      setCopiedUrl(true);
      pushToast({ tone: 'success', title: '已复制到剪贴板' });
      window.setTimeout(() => setCopiedUrl(false), 1500);
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
          message: `${requested} 被占用，WeQ 助手现监听 ${result.port}`,
        });
      }
      if (next) {
        pushToast({
          tone: 'info',
          title: '已在 QQ 数据库中创建会话',
          message: '请关闭并重新打开 QQ 本体查看「WeQ助手」会话。',
        });
      }
      await status.refetch();
    } catch (e) {
      showError(next ? '启用 WeQ 助手失败' : '停用 WeQ 助手失败', errMsg(e));
      await status.refetch();
    }
  }

  async function onSavePort(): Promise<void> {
    const port = Number(portDraft);
    if (!Number.isInteger(port) || port < 20000 || port > 65535) {
      showError('端口无效', '请输入 20000–65535 之间的端口号。');
      return;
    }
    if (data && port === data.port) return;
    try {
      const result = await setPort.mutateAsync({ port });
      await status.refetch();
      if (result.port !== port) {
        pushToast({
          tone: 'info',
          title: '端口已自动调整',
          message: `${port} 被占用，WeQ 助手现监听 ${result.port}`,
        });
      } else {
        pushToast({ tone: 'success', title: '端口已更新', message: `WeQ 助手现监听 ${port}` });
      }
    } catch (e) {
      showError('修改端口失败', errMsg(e));
      await status.refetch();
    }
  }

  const enabled = data?.enabled ?? false;
  const running = data?.running ?? false;

  return (
    <div className="weq-set">
      <SectionHeader
        title="WeQ 助手"
        desc="在你的 QQ 本体里注入一个内置「WeQ助手」公众号会话，用来推送每日推文、日报等内容。卡片封面与跳转页由本机服务生成，完全离线。"
      />

      <Card title="服务开关">
        <Row
          label="启用 WeQ 助手"
          desc="开启后会在当前账号的 QQ 数据库里创建会话，并启动本地服务。需关闭 QQ 本体后再开启查看。"
          control={
            <Toggle
              checked={enabled}
              disabled={busy || status.isLoading}
              onChange={(next) => void onToggle(next)}
              label="启用 WeQ 助手"
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
              onClick={() => void copyUrl()}
            >
              {copiedUrl ? <Check size={13} className="weq-set-ok" /> : <Copy size={13} />}
              复制地址
            </button>
          }
        />
      </Card>

      <Card title="连接信息">
        <Row
          label="端口"
          desc="20000–65535。修改后会重启服务，并同步重写 QQ 里卡片的封面 / 跳转地址。"
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
                aria-label="WeQ 助手端口"
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
        <p className="weq-set-note">
          仅监听本机 127.0.0.1。若卡片封面在 QQ 里加载不出来，可能是 QQ 不加载 http
          图片——届时再评估自签 https。
        </p>
      </Card>
    </div>
  );
}
