/**
 * 设置 → WeQ 服务 → 后台服务.
 *
 * 一个地方看清「关掉窗口之后还有什么在跑」。六个服务各一张卡片，只读展示状态与
 * 地址，开关仍留在各自的二级页 —— 这里不重复实现六套 mutation，也不会和那些页
 * 已有的联动确认（Web ↔ Remote、公众号 ↔ 登录自启）打架。
 *
 * 「关闭窗口时」的分段控件在这里和「常规 → 提醒与窗口」各有一份，读写的是同一个
 * `windowCloseBehavior`，不会出现两处不一致。
 */

import { useContext, useState, type ReactElement } from 'react';
import { ExternalLink, Plug, Radio, Server } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { useTabActive } from '../RetainedTabs';
import { useDialog } from '../Dialog';
import { Card, QueryError, Row, SectionHeader, SettingsNavigateContext } from './controls';
import { IS_WEB } from '../../lib/target';
import '../../styles/background-services.css';

type CloseBehavior = 'ask' | 'tray' | 'quit';

const CLOSE_BEHAVIOR_OPTIONS: ReadonlyArray<{ value: CloseBehavior; label: string }> = [
  { value: 'ask', label: '每次询问' },
  { value: 'tray', label: '最小化到托盘' },
  { value: 'quit', label: '直接退出' },
];

/** 服务状态点的三态文案，各卡片共用。 */
function State({
  running,
  enabled,
  waiting,
}: {
  running: boolean;
  enabled: boolean;
  waiting: boolean;
}) {
  const text = running
    ? '运行中'
    : enabled
      ? waiting
        ? '已启用（等待账号）'
        : '已启用（未在监听）'
      : '已停止';
  return (
    <span className="weq-set-mcp-state">
      <span className={`weq-set-mcp-dot${running ? ' is-on' : ''}`} aria-hidden />
      {text}
    </span>
  );
}

export function BackgroundServicesSection(): ReactElement {
  const active = useTabActive();
  // 由 SettingsDialog 注入；单测里直接渲染本组件时没有，按钮就是 no-op。
  const navigate = useContext(SettingsNavigateContext) ?? (() => {});
  const queryOptions = {
    enabled: active,
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always' as const,
    refetchInterval: active ? 3000 : (false as const),
  };
  const mcp = trpc.bootstrap.getMcpStatus.useQuery(undefined, queryOptions);
  const onebot = trpc.bootstrap.getOneBotStatus.useQuery(undefined, queryOptions);
  const assistant = trpc.bootstrap.getWeqAssistantStatus.useQuery(undefined, queryOptions);
  const sse = trpc.bootstrap.getSsePushStatus.useQuery(undefined, queryOptions);
  // remote.* 在 Web 构建下是 FORBIDDEN 的 local procedure，必须关掉。
  const web = trpc.remote.webStatus.useQuery(undefined, {
    ...queryOptions,
    enabled: active && !IS_WEB,
  });
  const remote = trpc.remote.status.useQuery(undefined, {
    ...queryOptions,
    enabled: active && !IS_WEB,
  });

  const settings = trpc.bootstrap.getSettings.useQuery(undefined, {
    enabled: active,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const setCloseBehavior = trpc.bootstrap.setWindowCloseBehavior.useMutation();
  const utils = trpc.useUtils();
  const showError = useDialog((s) => s.showError);
  const [pending, setPending] = useState<CloseBehavior | null>(null);

  async function onSetCloseBehavior(behavior: CloseBehavior): Promise<void> {
    setPending(behavior);
    try {
      await setCloseBehavior.mutateAsync({ behavior });
      await utils.bootstrap.getSettings.invalidate();
    } catch (error) {
      showError('保存关闭行为设置失败', error instanceof Error ? error.message : String(error));
    } finally {
      setPending(null);
    }
  }

  const closeBehavior = pending ?? settings.data?.windowCloseBehavior ?? 'tray';

  return (
    <div className="weq-set weq-set-background-services">
      <SectionHeader
        title="后台服务"
        icon={<Server size={16} strokeWidth={1.8} />}
        desc="这些服务在关闭窗口后继续运行，直到完全退出 WeQ。开关与端口在各自的页面里。"
      />

      <Card title="关闭窗口时" settingId="window-close-behavior">
        <Row
          label="点击关闭按钮"
          desc={
            closeBehavior === 'tray'
              ? '最小化到系统托盘，进程与后台服务继续运行，可从托盘图标恢复。'
              : closeBehavior === 'quit'
                ? '直接完全退出应用，后台服务一并停止。'
                : '每次点击关闭按钮时弹窗询问。'
          }
          control={
            IS_WEB ? (
              <span className="weq-set-note">浏览器模式下由浏览器管理</span>
            ) : (
              <div className="weq-set-seg" role="radiogroup" aria-label="关闭按钮行为">
                {CLOSE_BEHAVIOR_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={closeBehavior === option.value}
                    className={`weq-set-seg-item${closeBehavior === option.value ? ' is-on' : ''}`}
                    disabled={settings.isLoading || setCloseBehavior.isLoading}
                    onClick={() => void onSetCloseBehavior(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            )
          }
        />
      </Card>

      <Card
        title="MCP 服务器"
        icon={<Plug size={15} strokeWidth={1.8} />}
        settingId="background-mcp"
        action={
          <button
            type="button"
            className="weq-set-btn weq-set-btn-soft weq-set-btn-sm"
            onClick={() => navigate('mcp')}
          >
            管理
            <ExternalLink size={13} aria-hidden />
          </button>
        }
      >
        {mcp.error ? (
          <QueryError
            message={mcp.error.message}
            retryLabel="重新读取"
            retrying={mcp.isFetching}
            onRetry={() => void mcp.refetch()}
          />
        ) : null}
        <Row
          label="状态"
          control={
            <State
              running={mcp.data?.running ?? false}
              enabled={mcp.data?.enabled ?? false}
              waiting={mcp.data?.accountOpen === false}
            />
          }
        />
        <Row label="监听地址" control={<code>{mcp.data?.url ?? '...'}</code>} />
      </Card>

      <Card
        title="OneBot 服务"
        icon={<Plug size={15} strokeWidth={1.8} />}
        settingId="background-onebot"
        action={
          <button
            type="button"
            className="weq-set-btn weq-set-btn-soft weq-set-btn-sm"
            onClick={() => navigate('onebot')}
          >
            管理
            <ExternalLink size={13} aria-hidden />
          </button>
        }
      >
        {onebot.error ? (
          <QueryError
            message={onebot.error.message}
            retryLabel="重新读取"
            retrying={onebot.isFetching}
            onRetry={() => void onebot.refetch()}
          />
        ) : null}
        <Row
          label="状态"
          control={
            <State
              running={onebot.data?.running ?? false}
              enabled={onebot.data?.enabled ?? false}
              waiting={onebot.data?.accountOpen === false}
            />
          }
        />
        <Row
          label="连接"
          control={
            <span>
              {onebot.data?.running ? `${onebot.data.clients} 个连接` : (onebot.data?.url ?? '...')}
            </span>
          }
        />
      </Card>

      <Card
        title="QQ 公众号推送"
        icon={<Radio size={15} strokeWidth={1.8} />}
        settingId="background-assistant"
        action={
          <button
            type="button"
            className="weq-set-btn weq-set-btn-soft weq-set-btn-sm"
            onClick={() => navigate('assistant')}
          >
            管理
            <ExternalLink size={13} aria-hidden />
          </button>
        }
      >
        {assistant.error ? (
          <QueryError
            message={assistant.error.message}
            retryLabel="重新读取"
            retrying={assistant.isFetching}
            onRetry={() => void assistant.refetch()}
          />
        ) : null}
        <Row
          label="状态"
          control={
            <State
              running={assistant.data?.running ?? false}
              enabled={assistant.data?.enabled ?? false}
              waiting={false}
            />
          }
        />
        <Row label="资源地址" control={<code>{assistant.data?.url ?? '...'}</code>} />
      </Card>

      {IS_WEB ? null : (
        <>
          <Card
            title="WeQ Web 服务"
            settingId="background-web"
            action={
              <button
                type="button"
                className="weq-set-btn weq-set-btn-soft weq-set-btn-sm"
                onClick={() => navigate('remote')}
              >
                管理
                <ExternalLink size={13} aria-hidden />
              </button>
            }
          >
            {web.error ? (
              <QueryError
                message={web.error.message}
                retryLabel="重新读取"
                retrying={web.isFetching}
                onRetry={() => void web.refetch()}
              />
            ) : null}
            <Row
              label="状态"
              control={
                <State
                  running={web.data?.enabled ?? false}
                  enabled={web.data?.autoStart ?? false}
                  waiting={false}
                />
              }
            />
            <Row label="地址" control={<code>{web.data?.url ?? '未启动'}</code>} />
          </Card>

          <Card
            title="WeQ Remote"
            settingId="background-remote"
            action={
              <button
                type="button"
                className="weq-set-btn weq-set-btn-soft weq-set-btn-sm"
                onClick={() => navigate('remote')}
              >
                管理
                <ExternalLink size={13} aria-hidden />
              </button>
            }
          >
            {remote.error ? (
              <QueryError
                message={remote.error.message}
                retryLabel="重新读取"
                retrying={remote.isFetching}
                onRetry={() => void remote.refetch()}
              />
            ) : null}
            <Row
              label="状态"
              control={
                <State
                  running={remote.data?.enabled ?? false}
                  enabled={remote.data?.enabled ?? false}
                  waiting={false}
                />
              }
            />
          </Card>
        </>
      )}

      <Card
        title="SSE 消息推送"
        icon={<Radio size={15} strokeWidth={1.8} />}
        settingId="background-sse"
        action={
          <button
            type="button"
            className="weq-set-btn weq-set-btn-soft weq-set-btn-sm"
            onClick={() => navigate('sse')}
          >
            管理
            <ExternalLink size={13} aria-hidden />
          </button>
        }
      >
        {sse.error ? (
          <QueryError
            message={sse.error.message}
            retryLabel="重新读取"
            retrying={sse.isFetching}
            onRetry={() => void sse.refetch()}
          />
        ) : null}
        <Row
          label="状态"
          control={
            <State
              running={sse.data?.running ?? false}
              enabled={sse.data?.configured ?? false}
              waiting={sse.data?.accountOpen === false}
            />
          }
        />
        <Row label="推送地址" control={<code>{sse.data?.pushUrl ?? '未配置'}</code>} />
      </Card>
    </div>
  );
}
