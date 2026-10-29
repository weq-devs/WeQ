import { useEffect, useState, type ReactElement } from 'react';
import { Copy, Eye, EyeOff, Plug, RotateCcw, Save } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { useTabActive } from '../RetainedTabs';
import { useDialog } from '../Dialog';
import { useToast } from '../Toast';
import { QueryError, Row, SectionHeader, Toggle } from './controls';
import '../../styles/settings-services.css';
import '../../styles/settings-onebot.css';

export function OneBotSection(): ReactElement {
  const active = useTabActive();
  const status = trpc.bootstrap.getOneBotStatus.useQuery(undefined, {
    enabled: active,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchInterval: active ? 5000 : false,
  });
  const mutation = trpc.bootstrap.setOneBotConfig.useMutation();
  const showError = useDialog((s) => s.showError);
  const toast = useToast((s) => s.push);
  const [port, setPort] = useState<string | null>(null);
  const [reveal, setReveal] = useState(false);
  useEffect(() => {
    if (!active) setReveal(false);
  }, [active]);
  const data = status.data;
  async function update(input: {
    enabled?: boolean;
    port?: number;
    regenerateToken?: boolean;
  }): Promise<void> {
    try {
      await mutation.mutateAsync(input);
      setPort(null);
    } catch (error) {
      showError('OneBot 配置失败', error instanceof Error ? error.message : String(error));
    } finally {
      await status.refetch();
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
  const config = data
    ? `[[projects.platforms]]\ntype = "qq"\n[projects.platforms.options]\nws_url = "${data.url}"\ntoken = "${data.token}"\nallow_from = "填写你的 QQ 号"\ngroup_require_mention = true\n`
    : '';
  return (
    <div className="weq-set-section weq-set-onebot">
      <SectionHeader title="OneBot / cc-connect" icon={<Plug size={18} />} />
      {status.error ? (
        <QueryError
          message={status.error.message}
          retryLabel="重新读取"
          retrying={status.isFetching}
          onRetry={() => void status.refetch()}
        />
      ) : null}
      <Row
        label="OneBot 服务"
        control={
          <Toggle
            label="启用 OneBot 服务"
            checked={data?.enabled ?? false}
            disabled={!data || mutation.isLoading}
            onChange={(enabled) => void update({ enabled })}
          />
        }
      />
      <Row
        label="状态"
        control={
          <span>
            {data?.running
              ? `运行中 · ${data.clients} 个连接`
              : data?.enabled
                ? data.accountOpen
                  ? '启动失败'
                  : '等待在线账号'
                : '已停止'}
          </span>
        }
      />
      <Row
        label="WebSocket 地址"
        control={
          <div className="weq-set-btn-group">
            <code>{data?.url ?? '...'}</code>
            <button
              type="button"
              className="weq-set-iconbtn"
              title="复制地址"
              aria-label="复制地址"
              disabled={!data}
              onClick={() => void copy(data?.url ?? '')}
            >
              <Copy size={15} />
            </button>
          </div>
        }
      />
      <Row
        label="端口"
        control={
          <div className="weq-set-btn-group">
            <input
              aria-label="OneBot 端口"
              type="number"
              min={1024}
              max={65535}
              className="weq-set-input weq-set-input-sm weq-number"
              value={port ?? data?.port ?? ''}
              disabled={mutation.isLoading}
              onChange={(e) => setPort(e.target.value)}
            />
            <button
              type="button"
              className="weq-set-iconbtn"
              title="保存端口"
              aria-label="保存端口"
              disabled={
                !data ||
                mutation.isLoading ||
                !Number.isInteger(Number(port ?? data.port)) ||
                Number(port ?? data.port) < 1024 ||
                Number(port ?? data.port) > 65535
              }
              onClick={() => void update({ port: Number(port ?? data?.port) })}
            >
              <Save size={15} />
            </button>
          </div>
        }
      />
      <Row
        label="访问令牌"
        control={
          <div className="weq-set-btn-group">
            <input
              className="weq-set-input"
              aria-label="OneBot 访问令牌"
              readOnly
              type={reveal && active ? 'text' : 'password'}
              value={data?.token ?? ''}
            />
            <button
              type="button"
              className="weq-set-iconbtn"
              title={reveal ? '隐藏令牌' : '显示令牌'}
              aria-label={reveal ? '隐藏令牌' : '显示令牌'}
              onClick={() => setReveal(!reveal)}
            >
              {reveal ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
            <button
              type="button"
              className="weq-set-iconbtn"
              title="复制令牌"
              aria-label="复制令牌"
              disabled={!data?.token}
              onClick={() => void copy(data?.token ?? '')}
            >
              <Copy size={15} />
            </button>
            <button
              type="button"
              className="weq-set-iconbtn"
              title="重新生成令牌"
              aria-label="重新生成令牌"
              disabled={!data || mutation.isLoading}
              onClick={() => void update({ regenerateToken: true })}
            >
              <RotateCcw size={15} />
            </button>
          </div>
        }
      />
      <div className="weq-set-actions">
        <button
          type="button"
          className="weq-set-btn"
          disabled={!data?.token}
          onClick={() => void copy(config)}
        >
          <Copy size={14} />
          复制 cc-connect 配置
        </button>
      </div>
    </div>
  );
}
