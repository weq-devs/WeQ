/**
 * Right-pane diagnostics + stats.
 *
 *   - QQ logo + version + user-data path
 *   - three big numbers: 用户数据 / 历史登录账号 / 在线实例
 *   - GitHub-style language bar over the account's 8 largest databases
 *   - nt_data subdirectory space usage
 *
 * Both charts re-fetch on account switch and replay a left→right wipe. The
 * nt_data scan can be slow, so it shows a shimmer skeleton while pending.
 */

import { type ReactElement } from 'react';
import { FolderOpen, HardDrive, Layers } from 'lucide-react';
import { trpc } from '../../trpc/client';
import type { GlobalInstallInfo } from '@weq/service';
import logoUrl from '@resources/brand/logo.png';

/** Theme-cohesive blue→teal monochrome ramp (no rainbow). */
const RAMP = [
  '#0090ff',
  '#1f9ffb',
  '#37adf2',
  '#4fb9e8',
  '#54c2d6',
  '#4fc7b4',
  '#5bce97',
  '#86d9a4',
];

function shade(i: number): string {
  return RAMP[i % RAMP.length] ?? '#0090ff';
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, exp);
  return `${value >= 100 || exp === 0 ? Math.round(value) : value.toFixed(1)} ${units[exp]}`;
}

export function StatsPanel({
  install,
  selectedUin,
  counts,
  onPickRoot,
}: {
  install: GlobalInstallInfo;
  selectedUin: string | null;
  counts: { userData: number; history: number; online: number };
  onPickRoot: () => void;
}): ReactElement {
  const dbSizes = trpc.bootstrap.dbFileSizes.useQuery(
    { uin: selectedUin ?? '' },
    { enabled: !!selectedUin, refetchOnWindowFocus: false },
  );
  const ntData = trpc.bootstrap.ntDataSizes.useQuery(
    { uin: selectedUin ?? '' },
    { enabled: !!selectedUin, refetchOnWindowFocus: false },
  );

  return (
    <div className="weq-stats">
      {/* QQ identity + version */}
      <section className="weq-stats-head">
        <img src={logoUrl} alt="" className="weq-stats-logo" width={58} height={58} />
        <div className="weq-stats-head-info">
          <div className="weq-stats-kv">
            <span className="weq-stats-k">版本</span>
            <span className="weq-stats-v weq-number">{install.version ?? '未知'}</span>
          </div>
          <div className="weq-stats-kv">
            <span className="weq-stats-k">用户数据</span>
            {install.hasUserData ? (
              <span className="weq-stats-v weq-stats-path" title={install.userDataPath ?? ''}>
                {install.userDataPath ?? '—'}
              </span>
            ) : (
              <button className="weq-action-soft weq-stats-pick" onClick={onPickRoot}>
                <FolderOpen size={14} strokeWidth={1.8} aria-hidden />
                选择数据目录
              </button>
            )}
          </div>
        </div>
      </section>

      {/* Big numbers */}
      <section className="weq-bignums">
        <BigNumber value={counts.userData} label="用户数据" />
        <BigNumber value={counts.history} label="历史登录账号" />
        <BigNumber value={counts.online} label="在线实例" accent />
      </section>

      {/* Language-style database bar */}
      <section className="weq-chart">
        <ChartTitle icon={<Layers size={15} strokeWidth={1.8} aria-hidden />} title="数据库占用" />
        {!selectedUin ? (
          <ChartEmpty>选择账号后显示</ChartEmpty>
        ) : dbSizes.isLoading ? (
          <BarSkeleton />
        ) : (dbSizes.data?.length ?? 0) === 0 ? (
          <ChartEmpty>未发现数据库文件</ChartEmpty>
        ) : (
          <LanguageBar key={`db-${selectedUin}`} items={dbSizes.data ?? []} />
        )}
      </section>

      {/* nt_data space usage */}
      <section className="weq-chart">
        <ChartTitle icon={<HardDrive size={15} strokeWidth={1.8} aria-hidden />} title="nt_data 空间占用" />
        {!selectedUin ? (
          <ChartEmpty>选择账号后显示</ChartEmpty>
        ) : ntData.isLoading ? (
          <RowsSkeleton />
        ) : (ntData.data?.length ?? 0) === 0 ? (
          <ChartEmpty>未发现数据子目录</ChartEmpty>
        ) : (
          <SpaceRows key={`nt-${selectedUin}`} items={ntData.data ?? []} />
        )}
      </section>
    </div>
  );
}

function BigNumber({ value, label, accent }: { value: number; label: string; accent?: boolean }): ReactElement {
  return (
    <div className="weq-bignum">
      <div className={`weq-bignum-v weq-number ${accent ? 'is-accent' : ''}`}>{value}</div>
      <div className="weq-bignum-l">{label}</div>
    </div>
  );
}

function ChartTitle({ icon, title }: { icon: ReactElement; title: string }): ReactElement {
  return (
    <div className="weq-chart-title">
      <span className="weq-line-icon">{icon}</span>
      {title}
    </div>
  );
}

function ChartEmpty({ children }: { children: React.ReactNode }): ReactElement {
  return <div className="weq-chart-empty">{children}</div>;
}

function LanguageBar({ items }: { items: Array<{ name: string; bytes: number }> }): ReactElement {
  const total = items.reduce((s, i) => s + i.bytes, 0) || 1;
  return (
    <div className="weq-langbar-wrap">
      <div className="weq-langbar weq-anim-wipe">
        {items.map((it, i) => (
          <span
            key={it.name}
            className="weq-langbar-seg"
            style={{ width: `${(it.bytes / total) * 100}%`, background: shade(i) }}
            title={`${it.name} · ${formatBytes(it.bytes)}`}
          />
        ))}
      </div>
      <ul className="weq-legend">
        {items.map((it, i) => (
          <li key={it.name} className="weq-legend-item">
            <span className="weq-legend-dot" style={{ background: shade(i) }} />
            <span className="weq-legend-name" title={it.name}>{it.name}</span>
            <span className="weq-legend-size weq-number">{formatBytes(it.bytes)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SpaceRows({ items }: { items: Array<{ name: string; bytes: number }> }): ReactElement {
  const max = items.reduce((m, i) => Math.max(m, i.bytes), 0) || 1;
  return (
    <ul className="weq-spacerows">
      {items.slice(0, 8).map((it, i) => (
        <li key={it.name} className="weq-spacerow">
          <span className="weq-spacerow-name" title={it.name}>{it.name}</span>
          <span className="weq-spacerow-track">
            <span
              className="weq-spacerow-fill weq-anim-grow"
              style={{ width: `${(it.bytes / max) * 100}%`, background: shade(i) }}
            />
          </span>
          <span className="weq-spacerow-size weq-number">{formatBytes(it.bytes)}</span>
        </li>
      ))}
    </ul>
  );
}

function BarSkeleton(): ReactElement {
  return (
    <div className="weq-langbar-wrap">
      <div className="weq-langbar weq-skel" />
      <ul className="weq-legend">
        {Array.from({ length: 4 }).map((_, i) => (
          <li key={i} className="weq-legend-item">
            <span className="weq-legend-dot weq-skel" />
            <span className="weq-skel-line" style={{ width: '5rem' }} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function RowsSkeleton(): ReactElement {
  return (
    <ul className="weq-spacerows">
      {Array.from({ length: 5 }).map((_, i) => (
        <li key={i} className="weq-spacerow">
          <span className="weq-skel-line" style={{ width: '4rem' }} />
          <span className="weq-spacerow-track">
            <span className="weq-spacerow-fill weq-skel" style={{ width: `${70 - i * 12}%` }} />
          </span>
          <span className="weq-skel-line" style={{ width: '3rem' }} />
        </li>
      ))}
    </ul>
  );
}
