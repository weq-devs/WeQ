/**
 * 整体资源分析 — a full-screen overlay that scans every local resource tree and
 * charts the totals. The scan is the slow part (each file is `stat`-ed for its
 * size), so it runs ONE tree at a time via `mediaResource.analyzeTree`, showing a
 * progress banner + per-category cards that fill in as each tree finishes. The
 * cross-category charts (the ranked category bars, the by-month bars, the
 * 源文件/缩略图 split) render once the whole sweep completes.
 *
 * Visuals are dependency-free inline bar charts whose colours all come from
 * {@link ACCENT_SERIES}, so everything follows 设置里的主题色.
 */

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import {
  X,
  Loader2,
  RefreshCw,
  Image as ImageIcon,
  Images,
  Smile,
  Film,
  AudioLines,
  Cloud,
  Folder,
  HardDrive,
  Layers,
  CalendarRange,
} from 'lucide-react';
import type { ResourceStat, ResourceTreeKey } from '@weq/service';
import { client } from '../../trpc/client';
import { ACCENT_MUTED, ACCENT_SERIES, formatNumber } from '../../components/analyticsCharts';
import { fmtBytes } from './FileResourceShared';

/**
 * The trees to scan, in a stable order (also fixes each category's colour).
 * Colours come from {@link ACCENT_SERIES} so every slice follows 设置里的主题色
 * — cohesive shades of the accent rather than a clashing rainbow.
 */
const TREES: Array<{ key: ResourceTreeKey; label: string; icon: ReactElement; color: string }> = [
  { key: 'pic', label: '图片', icon: <ImageIcon size={15} />, color: ACCENT_SERIES[0] },
  { key: 'video', label: '视频', icon: <Film size={15} />, color: ACCENT_SERIES[1] },
  { key: 'ptt', label: '语音', icon: <AudioLines size={15} />, color: ACCENT_SERIES[2] },
  { key: 'emoji', label: '表情', icon: <Smile size={15} />, color: ACCENT_SERIES[3] },
  { key: 'avatar', label: '头像', icon: <ImageIcon size={15} />, color: ACCENT_SERIES[4] },
  { key: 'photoWall', label: '图片墙', icon: <Images size={15} />, color: ACCENT_SERIES[5] },
  { key: 'qzone', label: 'QQ空间', icon: <Cloud size={15} />, color: ACCENT_SERIES[6] },
  { key: 'file', label: '文件', icon: <Folder size={15} />, color: ACCENT_SERIES[7] },
];

function labelOf(key: ResourceTreeKey): string {
  return TREES.find((t) => t.key === key)?.label ?? key;
}
function colorOf(key: ResourceTreeKey): string {
  return TREES.find((t) => t.key === key)?.color ?? 'var(--weq-accent-effective)';
}

interface Totals {
  files: number;
  bytes: number;
  byMonth: Record<string, { files: number; bytes: number }>;
  ori: { files: number; bytes: number };
  thumb: { files: number; bytes: number };
  other: { files: number; bytes: number };
}

function accumulate(stats: ResourceStat[]): Totals {
  const t: Totals = {
    files: 0,
    bytes: 0,
    byMonth: {},
    ori: { files: 0, bytes: 0 },
    thumb: { files: 0, bytes: 0 },
    other: { files: 0, bytes: 0 },
  };
  for (const s of stats) {
    t.files += s.files;
    t.bytes += s.bytes;
    t.ori.files += s.ori.files;
    t.ori.bytes += s.ori.bytes;
    t.thumb.files += s.thumb.files;
    t.thumb.bytes += s.thumb.bytes;
    t.other.files += s.other.files;
    t.other.bytes += s.other.bytes;
    for (const [m, v] of Object.entries(s.byMonth)) {
      let cur = t.byMonth[m];
      if (!cur) {
        cur = { files: 0, bytes: 0 };
        t.byMonth[m] = cur;
      }
      cur.files += v.files;
      cur.bytes += v.bytes;
    }
  }
  return t;
}

export function ResourceAnalyticsDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): ReactElement | null {
  const [stats, setStats] = useState<ResourceStat[]>([]);
  const [scanningKey, setScanningKey] = useState<ResourceTreeKey | null>(null);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Guards against a stale scan (dialog closed + reopened) writing late results.
  const runRef = useRef(0);

  const runScan = useCallback(async (): Promise<void> => {
    const run = ++runRef.current;
    setStats([]);
    setDone(false);
    setError(null);
    try {
      for (const tree of TREES) {
        if (run !== runRef.current) return;
        setScanningKey(tree.key);
        const stat = await client.account.mediaResource.analyzeTree.query({ key: tree.key });
        if (run !== runRef.current) return;
        setStats((prev) => [...prev, stat]);
      }
      if (run === runRef.current) setDone(true);
    } catch (e) {
      if (run === runRef.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (run === runRef.current) setScanningKey(null);
    }
  }, []);

  // Kick the scan the first time the dialog opens; stop tracking when it closes.
  useEffect(() => {
    if (open && stats.length === 0 && !done && scanningKey === null && !error) {
      void runScan();
    }
    if (!open) runRef.current += 1; // invalidate any in-flight scan
  }, [open, stats.length, done, scanningKey, error, runScan]);

  // ESC to close.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open || typeof document === 'undefined') return null;

  const present = stats.filter((s) => s.present && s.files > 0);
  const totals = accumulate(stats);
  const progress = scanningKey ? stats.length : done ? TREES.length : stats.length;

  return createPortal(
    <div className="weq-ra-layer weq-anim-fade" onMouseDown={onClose}>
      <div className="weq-ra-dialog weq-anim-pop" onMouseDown={(e) => e.stopPropagation()}>
        <header className="weq-ra-head">
          <div className="weq-ra-head-title">
            <Layers size={18} />
            <div>
              <strong>本地资源整体分析</strong>
              <small>遍历全部缓存目录，统计数量、大小与分布</small>
            </div>
          </div>
          <div className="weq-ra-head-actions">
            <button
              type="button"
              className="weq-ra-rescan"
              onClick={() => void runScan()}
              disabled={scanningKey !== null}
              title="重新扫描"
            >
              <RefreshCw size={14} className={scanningKey !== null ? 'is-spin' : ''} />
              <span>重新扫描</span>
            </button>
            <button type="button" className="weq-ra-close" onClick={onClose} aria-label="关闭">
              <X size={18} />
            </button>
          </div>
        </header>

        {/* Progress banner while scanning. */}
        {scanningKey !== null ? (
          <div className="weq-ra-progress">
            <div className="weq-ra-progress-row">
              <Loader2 size={15} className="weq-spin" />
              <span>
                正在扫描 <strong>{labelOf(scanningKey)}</strong>… 计算大小可能较慢，请稍候
              </span>
              <span className="weq-ra-progress-count">
                {progress} / {TREES.length}
              </span>
            </div>
            <div className="weq-ra-progress-track">
              <div
                className="weq-ra-progress-fill"
                style={{ width: `${(progress / TREES.length) * 100}%` }}
              />
            </div>
          </div>
        ) : null}

        {error ? <div className="weq-ra-error">扫描失败：{error}</div> : null}

        <div className="weq-ra-body">
          {/* Overview stat tiles. */}
          <div className="weq-ra-tiles">
            <StatTile
              icon={<HardDrive size={18} />}
              value={fmtBytes(totals.bytes)}
              label="总占用空间"
            />
            <StatTile
              icon={<Layers size={18} />}
              value={formatNumber(totals.files)}
              label="资源文件总数"
            />
            <StatTile
              icon={<ImageIcon size={18} />}
              value={String(present.length)}
              label="有内容的分类"
            />
            <StatTile
              icon={<CalendarRange size={18} />}
              value={String(Object.keys(totals.byMonth).length)}
              label="覆盖月份数"
            />
          </div>

          {/* Cross-category ranking — one bar chart covers both 大小 and 数量
              (toggle), so every category name shows in full without the cramped
              legend the old donuts had. */}
          <ChartCard title="各分类分布" wide>
            {done && present.length > 0 ? (
              <CategoryBars stats={present} totals={totals} />
            ) : (
              <ChartWaiting scanning={scanningKey !== null} />
            )}
          </ChartCard>

          {/* 源文件 / 缩略图 占比 as a slim 100% stacked bar. */}
          <ChartCard title="源文件 / 缩略图 占比" wide>
            {done && totals.files > 0 ? (
              <ShareBar
                segments={[
                  { label: '源文件', bytes: totals.ori.bytes, files: totals.ori.files, color: ACCENT_SERIES[0] },
                  { label: '缩略图', bytes: totals.thumb.bytes, files: totals.thumb.files, color: ACCENT_SERIES[3] },
                  { label: '其它', bytes: totals.other.bytes, files: totals.other.files, color: ACCENT_MUTED },
                ]}
              />
            ) : (
              <ChartWaiting scanning={scanningKey !== null} />
            )}
          </ChartCard>

          {/* By-month bars. */}
          <ChartCard title="按时间分布（文件修改月份）" wide>
            {done && Object.keys(totals.byMonth).length > 0 ? (
              <MonthlyBars data={totals.byMonth} />
            ) : (
              <ChartWaiting scanning={scanningKey !== null} />
            )}
          </ChartCard>

          {/* Per-category detail table — fills in live as each tree finishes. */}
          <ChartCard title="分类明细" wide>
            <div className="weq-ra-table">
              <div className="weq-ra-tr weq-ra-th">
                <span>分类</span>
                <span>文件数</span>
                <span>占用大小</span>
                <span>平均大小</span>
                <span>源/缩略图</span>
              </div>
              {TREES.map((tree) => {
                const s = stats.find((x) => x.key === tree.key);
                const scanning = scanningKey === tree.key;
                return (
                  <div className="weq-ra-tr" key={tree.key}>
                    <span className="weq-ra-cat">
                      <i style={{ background: tree.color }} />
                      {tree.icon}
                      {tree.label}
                    </span>
                    {s ? (
                      <>
                        <span>{s.files > 0 ? formatNumber(s.files) : s.present ? '0' : '—'}</span>
                        <span>{s.files > 0 ? fmtBytes(s.bytes) : '—'}</span>
                        <span>{s.files > 0 ? fmtBytes(Math.round(s.bytes / s.files)) : '—'}</span>
                        <span className="weq-ra-oritm">
                          {s.ori.files || s.thumb.files
                            ? `${s.ori.files} / ${s.thumb.files}`
                            : '—'}
                        </span>
                      </>
                    ) : (
                      <span className="weq-ra-pending" style={{ gridColumn: 'span 4' }}>
                        {scanning ? (
                          <>
                            <Loader2 size={12} className="weq-spin" /> 扫描中…
                          </>
                        ) : (
                          '等待扫描'
                        )}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </ChartCard>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── small building blocks ────────────────────────────────────────────────────

function StatTile({
  icon,
  value,
  label,
}: {
  icon: ReactElement;
  value: string;
  label: string;
}): ReactElement {
  return (
    <div className="weq-ra-tile">
      <span className="weq-ra-tile-icon">{icon}</span>
      <span className="weq-ra-tile-value">{value}</span>
      <span className="weq-ra-tile-label">{label}</span>
    </div>
  );
}

function ChartCard({
  title,
  children,
  wide,
}: {
  title: string;
  children: ReactElement;
  wide?: boolean;
}): ReactElement {
  return (
    <section className={`weq-ra-card${wide ? ' is-wide' : ''}`}>
      <h4 className="weq-ra-card-title">{title}</h4>
      <div className="weq-ra-card-body">{children}</div>
    </section>
  );
}

function ChartWaiting({ scanning }: { scanning: boolean }): ReactElement {
  return (
    <div className="weq-ra-waiting">
      {scanning ? (
        <>
          <Loader2 size={20} className="weq-spin" />
          <span>统计中…</span>
        </>
      ) : (
        <span>暂无数据</span>
      )}
    </div>
  );
}

/**
 * Ranked horizontal bars over the scanned categories. A 大小/数量 toggle switches
 * which metric drives the bar length + sort order, while BOTH values stay on
 * every row — one chart replacing the two cramped donuts, and no truncated
 * labels.
 */
function CategoryBars({ stats, totals }: { stats: ResourceStat[]; totals: Totals }): ReactElement {
  const [metric, setMetric] = useState<'bytes' | 'files'>('bytes');
  const rows = stats
    .slice()
    .sort((a, b) => (metric === 'bytes' ? b.bytes - a.bytes : b.files - a.files));
  const totalMetric = metric === 'bytes' ? totals.bytes : totals.files;
  const max = Math.max(...rows.map((s) => (metric === 'bytes' ? s.bytes : s.files)), 1);

  return (
    <div className="weq-ra-barwrap">
      <div className="weq-ra-metric">
        <button
          type="button"
          className={metric === 'bytes' ? 'is-on' : ''}
          onClick={() => setMetric('bytes')}
        >
          大小
        </button>
        <button
          type="button"
          className={metric === 'files' ? 'is-on' : ''}
          onClick={() => setMetric('files')}
        >
          数量
        </button>
      </div>
      <div className="weq-ra-bars">
        {rows.map((s) => {
          const value = metric === 'bytes' ? s.bytes : s.files;
          const pct = totalMetric > 0 ? (value / totalMetric) * 100 : 0;
          const width = max > 0 ? (value / max) * 100 : 0;
          const primary = metric === 'bytes' ? fmtBytes(s.bytes) : `${formatNumber(s.files)} 个`;
          const secondary = metric === 'bytes' ? `${formatNumber(s.files)} 个` : fmtBytes(s.bytes);
          return (
            <div className="weq-ra-bar-row" key={s.key}>
              <span className="weq-ra-bar-label">
                <i style={{ background: colorOf(s.key) }} />
                {labelOf(s.key)}
              </span>
              <span className="weq-ra-bar-track">
                <span
                  className="weq-ra-bar-fill"
                  style={{
                    width: `${Math.max(width, value > 0 ? 2 : 0)}%`,
                    background: colorOf(s.key),
                  }}
                />
              </span>
              <span className="weq-ra-bar-val">
                <b>{primary}</b>
                <small>
                  {pct >= 10 ? pct.toFixed(0) : pct.toFixed(1)}% · {secondary}
                </small>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Slim 100% stacked bar (by bytes) for the 源文件 / 缩略图 / 其它 split. */
function ShareBar({
  segments,
}: {
  segments: Array<{ label: string; bytes: number; files: number; color: string }>;
}): ReactElement {
  const total = segments.reduce((s, x) => s + Math.max(0, x.bytes), 0);
  return (
    <div className="weq-ra-sharewrap">
      <div className="weq-ra-sharebar">
        {segments.map((s) =>
          s.bytes > 0 ? (
            <span
              key={s.label}
              className="weq-ra-shareseg"
              style={{ width: `${(s.bytes / total) * 100}%`, background: s.color }}
              title={`${s.label} · ${fmtBytes(s.bytes)} · ${s.files} 个`}
            />
          ) : null,
        )}
      </div>
      <div className="weq-ra-sharelegend">
        {segments.map((s) => {
          const pct = total > 0 ? (s.bytes / total) * 100 : 0;
          return (
            <span className="weq-ra-shareitem" key={s.label}>
              <i style={{ background: s.color }} />
              <span className="weq-ra-share-lbl">{s.label}</span>
              <span className="weq-ra-share-val">
                {fmtBytes(s.bytes)} · {pct >= 10 ? pct.toFixed(0) : pct.toFixed(1)}%
              </span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

/** Compact monthly bar chart over the accumulated by-month buckets. */
function MonthlyBars({ data }: { data: Record<string, { files: number; bytes: number }> }): ReactElement {
  const [metric, setMetric] = useState<'bytes' | 'files'>('bytes');
  const months = Object.keys(data).sort();
  const max = Math.max(...months.map((m) => (metric === 'bytes' ? data[m]!.bytes : data[m]!.files)), 1);

  return (
    <div className="weq-ra-monthwrap">
      <div className="weq-ra-metric">
        <button
          type="button"
          className={metric === 'bytes' ? 'is-on' : ''}
          onClick={() => setMetric('bytes')}
        >
          大小
        </button>
        <button
          type="button"
          className={metric === 'files' ? 'is-on' : ''}
          onClick={() => setMetric('files')}
        >
          数量
        </button>
      </div>
      <div className="weq-ra-months">
        {months.map((m) => {
          const bucket = data[m]!;
          const v = metric === 'bytes' ? bucket.bytes : bucket.files;
          const pct = max > 0 ? (v / max) * 100 : 0;
          const title = `${m} · ${bucket.files} 个文件 · ${fmtBytes(bucket.bytes)}`;
          return (
            <div className="weq-ra-mcol" key={m} title={title}>
              <div className="weq-ra-mtrack">
                <div
                  className="weq-ra-mfill"
                  style={{ height: `${Math.max(pct, v > 0 ? 3 : 0)}%` }}
                />
              </div>
              <span className="weq-ra-mlabel">{m.slice(2)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
