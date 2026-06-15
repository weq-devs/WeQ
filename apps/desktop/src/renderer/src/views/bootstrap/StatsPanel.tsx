/**
 * Right-pane diagnostics + stats. Card-based layout:
 *
 *   - hero card: QQ logo + version + data-dir path (or pick button)
 *   - three stat cards: 本地账号 / 目录大小 / 在线实例
 *   - "数据库占用" card: GitHub-style language bar over the 8 largest databases
 *
 * The chart re-fetches on account switch and replays its entry animation.
 * (ColumnChart/ColumnSkeleton are kept for reuse but no longer rendered here.)
 */

import { type ReactElement } from 'react';
import { FolderOpen, Layers } from 'lucide-react';
import { trpc } from '../../trpc/client';
import type { GlobalInstallInfo } from '@weq/service';
import logoUrl from '@resources/img/QQ.png';

/** Vivid, GitHub-style language colors (TS, JS, HTML, CSS, Python, Java, C++, C#). */
const RAMP = [
  '#3178c6',
  '#f1e05a',
  '#e34c26',
  '#563d7c',
  '#3572a5',
  '#b07219',
  '#f34b7d',
  '#178600',
];

/** Slightly brighter versions for the top of the bar gradients. */
const RAMP_HI = [
  '#5491d1',
  '#f4e881',
  '#e97051',
  '#7654a3',
  '#5491c1',
  '#d1913d',
  '#f6709d',
  '#22ba00',
];

function shade(i: number): string {
  return RAMP[i % RAMP.length] ?? '#0090ff';
}

/** Vertical gradient (bright top → base bottom) for an animated column. */
function gradient(i: number): string {
  const base = RAMP[i % RAMP.length] ?? '#0090ff';
  const hi = RAMP_HI[i % RAMP_HI.length] ?? '#3db4ff';
  return `linear-gradient(180deg, ${hi} 0%, ${base} 100%)`;
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
  counts: { userData: number; online: number };
  onPickRoot: () => void;
}): ReactElement {
  const dbSizes = trpc.bootstrap.dbFileSizes.useQuery(
    { uin: selectedUin ?? '' },
    { enabled: !!selectedUin, refetchOnWindowFocus: false },
  );
  const dirSize = trpc.bootstrap.accountDirSize.useQuery(
    { uin: selectedUin ?? '' },
    { enabled: !!selectedUin, refetchOnWindowFocus: false },
  );

  return (
    <div className="weq-stats">
      {/* Hero: QQ identity + version + data dir */}
      <section className="weq-stats-head">
        <img src={logoUrl} alt="" className="weq-stats-logo" width={56} height={56} />
        <div className="weq-stats-head-info">
          <span className="weq-stats-title-label">QQ 版本</span>
          <span className="weq-stats-version">{install.version ?? '未知'}</span>
          {install.hasUserData ? (
            <span className="weq-stats-path" title={install.userDataPath ?? ''}>
              <FolderOpen size={12} strokeWidth={1.9} aria-hidden />
              <span className="weq-stats-path-txt">{install.userDataPath ?? '—'}</span>
            </span>
          ) : (
            <button className="weq-action-soft weq-stats-pick" onClick={onPickRoot}>
              <FolderOpen size={14} strokeWidth={1.8} aria-hidden />
              选择数据目录
            </button>
          )}
        </div>
      </section>

      {/* Stat cards */}
      <section className="weq-bignums">
        <BigNumber value={counts.userData} label="本地账号" />
        <BigNumber
          value={!selectedUin ? '—' : dirSize.isLoading ? '…' : formatBytes(dirSize.data ?? 0)}
          label="目录大小"
        />
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
    </div>
  );
}

function BigNumber({
  value,
  label,
  accent,
}: {
  value: number | string;
  label: string;
  accent?: boolean;
}): ReactElement {
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

function ColumnChart({ items }: { items: Array<{ name: string; bytes: number }> }): ReactElement {
  const top = items.slice(0, 8);
  const max = top.reduce((m, i) => Math.max(m, i.bytes), 0) || 1;
  return (
    <div className="weq-cols">
      {top.map((it, i) => (
        <div key={it.name} className="weq-col" title={`${it.name} · ${formatBytes(it.bytes)}`}>
          <span className="weq-col-size weq-number">{formatBytes(it.bytes)}</span>
          <span className="weq-col-track">
            <span
              className="weq-col-fill weq-anim-rise"
              style={{
                height: `${Math.max((it.bytes / max) * 100, 2)}%`,
                background: gradient(i),
                animationDelay: `${i * 55}ms`,
              }}
            />
          </span>
          <span className="weq-col-name" title={it.name}>{it.name}</span>
        </div>
      ))}
    </div>
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

function ColumnSkeleton(): ReactElement {
  const heights = [70, 52, 88, 40, 64, 30, 76, 46];
  return (
    <div className="weq-cols">
      {heights.map((h, i) => (
        <div key={i} className="weq-col">
          <span className="weq-col-track">
            <span className="weq-col-fill weq-skel" style={{ height: `${h}%` }} />
          </span>
          <span className="weq-skel-line" style={{ width: '70%' }} />
        </div>
      ))}
    </div>
  );
}
