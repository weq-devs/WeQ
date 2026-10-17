/**
 * 设置 → 版本.
 *
 * 从「全局设置」里独立出来的一屏，集中放**与版本有关**的东西：
 *   - WeQ 版本 + Electron / Chrome / Node 运行时版本
 *   - 内置 native 组件（`nt_helper.node`）的构建时间 / 过期时间 / 剩余时间
 *   - 软件更新（检查 / 下载 / 安装）
 *
 * native 构建信息直接来自二进制自报的 `getBuildInfo()`（`bootstrap.getNativeBuildInfo`），
 * 不经过 native 加载校验 —— 构建过期时设置页仍要能显示出那个过期时间。
 * **有效期天数不在前端定义**：这里只展示后端报出的时间戳并算剩余天数。
 */

import { useState, type ReactElement } from 'react';
import { Boxes, Info, Package, RefreshCw } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { Card, SectionHeader } from './controls';
import { UpdateCard } from './UpdateCard';
import { DesktopOnly } from '../../lib/target';
import logoUrl from '@resources/brand/logo.png';

/** ISO → 「2026-10-16 08:39」本地时间；无效返回 null。 */
function fmtDateTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}`
  );
}

/** 剩余时间文案（天 / 小时）；已过期为负。 */
function fmtRemaining(expireMs: number): string {
  const days = (expireMs - Date.now()) / 86_400_000;
  if (days <= 0) return `已过期 ${Math.abs(days).toFixed(1)} 天`;
  if (days < 1) return `不足 1 天（${(days * 24).toFixed(1)} 小时）`;
  return `${days.toFixed(1)} 天`;
}

export function VersionSection(): ReactElement {
  const version = trpc.bootstrap.getVersionInfo.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
  const native = trpc.bootstrap.getNativeBuildInfo.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });

  const [refreshing, setRefreshing] = useState(false);
  const v = version.data;
  const n = native.data ?? null;

  const buildText = fmtDateTime(n?.buildTime ? new Date(n.buildTime * 1000).toISOString() : null);
  const expireText = fmtDateTime(
    n?.expireTime ? new Date(n.expireTime * 1000).toISOString() : null,
  );
  const remaining = n?.expireTime ? fmtRemaining(n.expireTime * 1000) : null;
  const expired = Boolean(n?.expireTime && n.expireTime * 1000 <= Date.now());

  async function onRefresh(): Promise<void> {
    setRefreshing(true);
    try {
      await Promise.all([version.refetch(), native.refetch()]);
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="weq-set">
      <SectionHeader
        icon={<Package size={16} strokeWidth={1.8} />}
        title="版本"
        desc="WeQ 版本、内置组件时间与软件更新。"
      />

      {/* WeQ versions */}
      <Card>
        <div className="weq-set-hero">
          <img src={logoUrl} alt="" width={52} height={52} className="weq-set-hero-logo" />
          <div className="weq-set-hero-info">
            <span className="weq-set-hero-name">WeQ</span>
            <span className="weq-set-hero-sub weq-number">
              版本 {v?.app ?? (version.isLoading ? '…' : '未知')}
            </span>
            {v ? (
              <span className="weq-set-hero-sig">
                Electron {v.electron} · Chrome {v.chrome} · Node {v.node}
              </span>
            ) : null}
          </div>
          <button
            type="button"
            className="weq-set-btn weq-set-btn-soft"
            disabled={refreshing}
            onClick={() => void onRefresh()}
            title="重新读取版本与内置组件信息"
          >
            <RefreshCw
              size={14}
              strokeWidth={1.8}
              aria-hidden
              className={refreshing ? 'weq-spin' : undefined}
            />
            刷新
          </button>
        </div>
        <p className="weq-set-note">
          <Info size={12} strokeWidth={1.9} aria-hidden /> WeQ 完全自主解密解析 QQ
          本地数据库读取聊天记录
        </p>
      </Card>

      {/* Built-in native component */}
      <Card title="内置组件">
        <div className="weq-set-hero">
          <Boxes size={28} strokeWidth={1.6} aria-hidden style={{ flexShrink: 0 }} />
          <div className="weq-set-hero-info">
            <span className="weq-set-hero-name weq-number">nt_helper.node</span>
            <span className="weq-set-hero-sub weq-number">
              {native.isLoading
                ? '读取中…'
                : n?.isDev
                  ? '开发构建，无有效期限制'
                  : buildText
                    ? `构建于 ${buildText}`
                    : '构建时间未知'}
            </span>
            {!n?.isDev && expireText ? (
              <span className={`weq-set-hero-sig weq-number${expired ? ' weq-set-note-warn' : ''}`}>
                有效期至 {expireText}（{remaining}）
              </span>
            ) : null}
          </div>
        </div>
        {!native.isLoading && !n ? (
          <p className="weq-set-note">
            <Info size={12} strokeWidth={1.9} aria-hidden /> 当前内置组件不提供构建信息（较早的
            native 构建）；跑一次 <code>pnpm native:fetch</code> 更新即可看到。
          </p>
        ) : null}
        {expired ? (
          <p className="weq-set-note weq-set-note-warn">
            <Info size={12} strokeWidth={1.9} aria-hidden /> 内置组件已超过有效期，WeQ
            会拒绝进入主界面，请更新到最新版本。
          </p>
        ) : null}
      </Card>

      {/* Software update — the web build can't replace its own binary. */}
      <DesktopOnly>
        <UpdateCard />
      </DesktopOnly>
    </div>
  );
}
