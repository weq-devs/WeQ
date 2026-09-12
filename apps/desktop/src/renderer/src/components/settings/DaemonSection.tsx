/**
 * 设置 → 守护进程（weq-daemon）。
 *
 * 取代旧的「WeQ 助手」设置页 —— 助手的开关 / 端口保留在这里，并升级成更大的
 * 守护进程控制面板：
 *
 *   1. 健康性：探活 / 版本 / HTTP 服务 / docroot（getDaemonHealth 聚合快照）；
 *   2. 推送到 QQ 公众号（原 WeQ 助手）：开关 + 端口 + 更新推文说明；
 *   3. GitHub release 监控：守护进程 Rust 轮询器开关 + 最近发现 + 系统通知；
 *   4. 开机自动启动：**GUI 不注册任何原生自启** —— 只把意图交给守护进程
 *      （autostart_set），开机由守护进程拉起 WeQ。
 */

import { useEffect, useState, type ReactElement } from 'react';
import {
  Activity,
  Check,
  Copy,
  FolderSearch,
  Github,
  // MonitorUp,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
import { trpc } from '../../trpc/client';
import { useDialog } from '../Dialog';
import { useToast } from '../Toast';
import { Card, Row, SectionHeader, Toggle } from './controls';

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 状态小圆点 + 文案。 */
function StateDot({ on, label }: { on: boolean; label: string }): ReactElement {
  return (
    <span className="weq-set-mcp-state">
      <span className={`weq-set-mcp-dot${on ? ' is-on' : ''}`} aria-hidden />
      {label}
    </span>
  );
}

export function DaemonSection(): ReactElement {
  const showError = useDialog((s) => s.showError);
  const pushToast = useToast((s) => s.push);

  // ---- 健康快照（轮询 10s；设置页开着时保持新鲜） ----
  const health = trpc.bootstrap.getDaemonHealth.useQuery(undefined, {
    refetchOnWindowFocus: false,
    refetchInterval: 10_000,
  });
  const binary = trpc.bootstrap.getDaemonBinaryStatus.useQuery();
  const healthData = health.data;

  // ---- WeQ 助手（推送公众号）----
  const status = trpc.bootstrap.getWeqAssistantStatus.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const setEnabled = trpc.bootstrap.setWeqAssistantEnabled.useMutation();
  const setPort = trpc.bootstrap.setWeqAssistantPort.useMutation();
  const busy = setEnabled.isLoading || setPort.isLoading;

  // ---- release 监控 ----
  const releaseData = healthData?.release ?? null;
  const setReleaseWatch = trpc.bootstrap.setDaemonReleaseWatch.useMutation();

  // ---- 开机自启（由守护进程拉起）----
  const autostartData = healthData?.autostart ?? null;
  const setAutostart = trpc.bootstrap.setDaemonAutostart.useMutation();

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

  async function onToggleAssistant(next: boolean): Promise<void> {
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
      await health.refetch();
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
      await health.refetch();
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

  async function onToggleReleaseWatch(next: boolean): Promise<void> {
    try {
      await setReleaseWatch.mutateAsync({ enabled: next });
      pushToast({
        tone: 'success',
        title: next ? '已开始监控 Release' : '已停止监控 Release',
        message: next
          ? '守护进程每小时轮询一次 GitHub，新版本会弹系统通知并推送到 WeQ助手。'
          : undefined,
      });
      await health.refetch();
    } catch (e) {
      showError('切换 Release 监控失败', errMsg(e));
      await health.refetch();
    }
  }

  async function onToggleAutostart(next: boolean): Promise<void> {
    try {
      await setAutostart.mutateAsync({ enabled: next });
      pushToast({
        tone: 'success',
        title: next ? '已开启开机自启' : '已关闭开机自启',
        message: next ? '开机后由守护进程自动拉起 WeQ。' : undefined,
      });
      await health.refetch();
    } catch (e) {
      showError('设置开机自启失败', errMsg(e));
      await health.refetch();
    }
  }

  const enabled = data?.enabled ?? false;
  const running = data?.running ?? false;
  const watching = releaseData?.watching ?? false;
  const autostartEnabled = autostartData?.enabled ?? false;

  return (
    <div className="weq-set">
      <SectionHeader
        icon={<Activity size={16} strokeWidth={1.8} />}
        title="守护进程"
        desc="weq-daemon 是 WeQ 的伴生进程：WeQ 启动时自动运行，服务推文静态文件、监控 GitHub Release、开机时负责拉起 WeQ。它不碰 QQ 数据库，只听 WeQ 的指挥。"
      />

      {/* ── 1. 健康性 ─────────────────────────────────────────── */}
      <Card
        title="运行状态"
        action={
          <button
            type="button"
            className="weq-set-btn weq-set-btn-soft weq-set-btn-sm"
            onClick={() => void health.refetch()}
            disabled={health.isFetching}
          >
            <RefreshCw size={13} className={health.isFetching ? 'weq-spin' : undefined} />
            刷新
          </button>
        }
      >
        <Row
          label={
            <StateDot
              on={healthData?.alive ?? false}
              label={
                healthData?.alive ? `运行中 · v${healthData.version ?? '?'}` : '守护进程未运行'
              }
            />
          }
          desc={
            healthData?.alive
              ? '控制管道连通。守护进程随 WeQ 启动自动运行，无需手动开启。'
              : binary.data?.available === false
                ? '未找到守护进程二进制（resources/daemon/<platform>-<arch>/）。请先运行 pnpm build:daemon 或重新安装。'
                : '守护进程未运行。WeQ 启动时会自动拉起；若仍未恢复，请检查守护进程二进制或重启 WeQ。'
          }
          control={<Activity size={14} className="weq-set-ok" aria-hidden />}
        />
        <Row
          label="静态文件服务"
          desc={
            healthData?.http?.running
              ? `运行中 · 127.0.0.1:${healthData.http.port ?? '?'}`
              : '未运行（推文封面 / 跳转页由它服务）'
          }
          control={
            <button
              type="button"
              className="weq-set-btn weq-set-btn-soft weq-set-btn-sm"
              disabled={!healthData?.http?.docroot}
              onClick={() => {
                const docroot = healthData?.http?.docroot;
                if (docroot) void window.weq?.revealPath?.(docroot);
              }}
            >
              <FolderSearch size={13} />
              打开 docroot
            </button>
          }
        />
        {releaseData?.lastError ? (
          <p className="weq-set-note weq-set-note-warn">
            GitHub 轮询最近一次失败：{releaseData.lastError}（会自动重试，不影响其它功能）
          </p>
        ) : null}
      </Card>

      {/* ── 2. 推送到 QQ 公众号（原 WeQ 助手） ───────────────── */}
      <Card title="推送到 QQ 公众号（WeQ 助手）">
        <Row
          label="启用 WeQ 助手"
          desc="开启后在当前账号的 QQ 数据库里创建「WeQ助手」会话，用于推送每日推文、群数据周报与「更新可用」推文。需关闭 QQ 本体后再开启查看。"
          control={
            <Toggle
              checked={enabled}
              disabled={busy || status.isLoading}
              onChange={(next) => void onToggleAssistant(next)}
              label="启用 WeQ 助手"
            />
          }
        />
        <Row
          label={
            <StateDot
              on={running}
              label={running ? '运行中' : enabled ? '已启用（等待账号）' : '已停止'}
            />
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
          仅监听本机 127.0.0.1。打包版应用内更新检查发现新版本时，会追加一条
          「更新可用」推文（同版本只写一次），内容取仓库 CHANGELOG.md 对应章节。
        </p>
      </Card>

      {/* ── 3. GitHub Release 监控 ───────────────────────────── */}
      <Card title="GitHub Release 监控">
        <Row
          label="监控新版本发布"
          desc="守护进程（Rust）每小时轮询一次 GitHub Release；发现新版本时弹系统通知提醒更新。推文由打包版更新检查负责，这里不重复写入。"
          control={
            <Toggle
              checked={watching}
              disabled={setReleaseWatch.isLoading || !healthData?.alive}
              onChange={(next) => void onToggleReleaseWatch(next)}
              label="监控新版本发布"
            />
          }
        />
        <Row
          label={
            <StateDot
              on={watching}
              label={
                watching
                  ? releaseData?.pending
                    ? `发现新版本 v${releaseData.pending}`
                    : releaseData?.latestSeen
                      ? `最新 v${releaseData.latestSeen}`
                      : '等待首次轮询'
                  : '未监控'
              }
            />
          }
          desc={
            releaseData?.currentVersion
              ? `当前版本 v${releaseData.currentVersion} · 仓库 H3CoF6/WeQ`
              : '仓库 H3CoF6/WeQ'
          }
          control={
            <a
              className="weq-set-btn weq-set-btn-soft weq-set-btn-sm"
              href="https://github.com/H3CoF6/WeQ/releases"
              target="_blank"
              rel="noreferrer"
            >
              <Github size={13} />
              Release 页
            </a>
          }
        />
      </Card>

      {/* ── 4. 开机自动启动（守护进程拉起） ──────────────────── */}
      <Card title="开机自动启动">
        <Row
          label="开机自动启动 WeQ"
          desc={
            healthData?.autostartSupported === false
              ? '当前环境不支持开机自启：浏览器版的启动由部署方用 systemd / 计划任务管理；开发模式（pnpm dev）没有稳定的可执行路径。'
              : 'WeQ 不注册任何系统自启动：开关只把意图交给守护进程（weq-daemon）记住，开机后由它以独立进程拉起 WeQ。'
          }
          control={
            <Toggle
              checked={autostartEnabled}
              disabled={
                setAutostart.isLoading ||
                !healthData?.alive ||
                healthData?.autostartSupported === false
              }
              onChange={(next) => void onToggleAutostart(next)}
              label="开机自动启动 WeQ"
            />
          }
        />
        <Row
          label={
            <StateDot
              on={autostartData?.registered ?? false}
              label={
                healthData?.autostartSupported === false
                  ? '当前环境不支持'
                  : !healthData?.alive
                    ? '需要守护进程运行'
                    : autostartData?.registered
                      ? '守护进程已注册自启'
                      : '守护进程未注册自启'
              }
            />
          }
          desc="守护进程自身随系统自启动（全机唯一的原生注册），WeQ 只由它拉起。"
          control={<Sparkles size={14} className="weq-set-ok" aria-hidden />}
        />
      </Card>

      {/*<div className="weq-set-footnote" aria-hidden>*/}
      {/*  <MonitorUp size={12} />*/}
      {/*  守护进程协议与自启动注册详见 packages/daemon/README.md*/}
      {/*</div>*/}
    </div>
  );
}
