// @ts-nocheck
/**
 * 群聊分析 —— 单页合并版。
 *
 * 点进来就是全群画像，不用先过一层菜单；成员级的分析（某人在群里发了多少、爱说什么）
 * 挪到了资料卡（{@link ./MemberProfileCard}）底部的「聊天分析」按钮，点击弹出灯箱。
 *
 * 三路数据各拉各的，任一失败只标出那一路的错误，不把整页拖垮：
 *   - `getGroupStatsReport`  —— 排行 / 活跃时段 / 每日热力图 / 词云 **一次扫描**全算完；
 *   - `getGroupJoinBatches`  —— 入群批次：3 小时内挤进 ≥ max(3, 群人数÷20) 人算一批；
 *   - `getGroupConversationGraph` —— 真小团体：按 5 分钟间隔切会话、算两两拉力并画力图。
 *
 * 首屏加载时显示 skeleton + shimmer（见 {@link ./AnalyticsSkeleton}），数据一到原地替换。
 *
 * 「保存为图片」不在这张弹窗上动手：数据交给主进程，由它在一个**从不显示的窗口**里
 * 用同一个组件把卡片重新渲染（840px 长图口径）并拍下来 —— 屏幕上全程零变化。
 * 导出窗口里靠 `exportMode` + `initialData` 复用这里（见 ./export/main.tsx）。
 */
import {
  CalendarDays,
  Clock,
  Cloud,
  Flame,
  ImageDown,
  Loader2,
  Medal,
  MessageSquare,
  Network,
  TrendingUp,
  Users,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { client } from '../trpc/client';
import { Avatar } from '../im-template/template/primitives';
import { OverlayLayer } from './OverlayLayer';
import { AnalyticsSkeleton } from './AnalyticsSkeleton';
import {
  ContributionHeatmap,
  HourlyBarChart,
  WordCloud,
  formatDate,
  formatNumber,
  type DailyActivityItem,
  type WordCloudItem,
} from './analyticsCharts';
import { GroupJoinBatches, type JoinBatchReport } from './GroupJoinBatches';
import { GroupConversationGraph, type ConversationGraphReport } from './GroupConversationGraph';
import { useAnalyticsExport } from './useAnalyticsExport';
import {
  GitHubTimeline,
  PersonWeekCard,
  RangeTimeline,
  type RangeSelection,
} from './conversationTimeline';
import '../styles/conversation-analytics.css';

/** 排行榜只取前几名 —— 长榜单在这里没人看完，前 10 已经够用。 */
const RANKING_LIMIT = 10;
/** 词云取前 150 个词。 */
const WORD_LIMIT = 150;
/** 导出图片的默认文件名前缀。 */
const EXPORT_LABEL = '群聊分析';

interface RankingItem {
  uid: string;
  uin: string;
  displayName: string;
  messageCount: number;
  /** 所选区间内每周发言数（与 StatsReport.weeks 对齐）。 */
  weekly?: number[];
}

interface StatsReport {
  totals: {
    totalMessages: number;
    speakerCount: number;
    activeDays: number;
    firstMessageTime: number | null;
    lastMessageTime: number | null;
  };
  ranking: RankingItem[];
  timeDistribution: Record<number, number>;
  daily: DailyActivityItem[];
  words: WordCloudItem[];
  range: { startTime: number | null; endTime: number | null; defaulted: boolean };
  timeline: {
    firstMessageTime: number | null;
    lastMessageTime: number | null;
    daily: DailyActivityItem[];
    weekly: Array<{ weekStart: string; count: number }>;
  };
  weeks: string[];
}

function avatarUrlOf(uin: string | undefined | null): string | null {
  return uin && uin !== '0' ? `https://thirdqq.qlogo.cn/g?b=sdk&nk=${uin}&s=0` : null;
}

/** 24 时段里最忙的那一格（返回小时数，全为 0 时返回 null）。 */
function peakHour(hours: Record<number, number>): { hour: number; count: number } | null {
  let best: { hour: number; count: number } | null = null;
  for (let hour = 0; hour < 24; hour++) {
    const count = hours[hour] ?? 0;
    if (count > 0 && (!best || count > best.count)) best = { hour, count };
  }
  return best;
}

export function GroupAnalyticsDialog({
  groupCode,
  groupName,
  memberCount,
  avatarUrl,
  onClose,
  exportMode = false,
  initialData,
}: {
  groupCode: string;
  groupName: string;
  /** 群总人数（来自会话详情），仅用于 hero 上的一枚小徽章。 */
  memberCount?: number;
  /** 群头像，用于 hero；拿不到就退回首字母占位。 */
  avatarUrl?: string | null;
  onClose: () => void;
  /**
   * 导出窗口里的渲染口径：不画遮罩、不带头部按钮（图里不需要它们），宽度按长图铺开。
   * 走 CSS 的 `.weq-export-root`。
   */
  exportMode?: boolean;
  /** 导出时由可见窗口递过来的数据，避免同一份分析再扫一遍群历史。 */
  initialData?: { report?: unknown; batches?: unknown; graph?: unknown };
}) {
  const [report, setReport] = useState<StatsReport | null>(
    (initialData?.report as StatsReport) ?? null,
  );
  /** 当前时间轴选择；后端首次返回的「最近一年」会回填到这里。 */
  const [range, setRange] = useState<RangeSelection | null>(() => {
    const seeded = initialData?.report as StatsReport | undefined;
    return seeded?.range?.startTime && seeded.range.endTime
      ? { start: seeded.range.startTime, end: seeded.range.endTime }
      : null;
  });
  /** 区间重算中：只压暗依赖区间的区块，时间轴 / 绿墙保持稳定。 */
  const [refreshing, setRefreshing] = useState(false);
  const lastFetchedRangeRef = useRef(
    (() => {
      const seeded = initialData?.report as StatsReport | undefined;
      return seeded?.range?.startTime && seeded.range.endTime
        ? `${seeded.range.startTime}:${seeded.range.endTime}`
        : '';
    })(),
  );
  const reportSeqRef = useRef(0);
  const loadedOnceRef = useRef(Boolean(initialData?.report));
  const [reportError, setReportError] = useState<string | null>(null);

  const [batches, setBatches] = useState<JoinBatchReport | null>(
    (initialData?.batches as JoinBatchReport) ?? null,
  );
  const [batchesError, setBatchesError] = useState<string | null>(null);

  const [graph, setGraph] = useState<ConversationGraphReport | null>(
    (initialData?.graph as ConversationGraphReport) ?? null,
  );
  const [graphError, setGraphError] = useState<string | null>(null);

  const [loading, setLoading] = useState(!initialData?.report);
  const [batchesLoading, setBatchesLoading] = useState(!initialData?.batches);
  const [graphLoading, setGraphLoading] = useState(!initialData?.graph);

  // 群画像（排行 / 时段 / 热力图 / 词云 / 时间轴）：一次扫描的聚合。
  // 不传区间时服务层默认「最近一年」，并把实际区间回传；之后拖动时间轴只传
  // 新区间重扫，时间轴本身（全历史）每次都会随响应回来，但不会改变。
  const loadReport = useCallback(
    async (nextRange: RangeSelection | null) => {
      const seq = ++reportSeqRef.current;
      if (!loadedOnceRef.current) setLoading(true);
      else setRefreshing(true);
      setReportError(null);
      try {
        const r = (await client.account.getGroupStatsReport.query({
          groupCode,
          rankingLimit: RANKING_LIMIT,
          wordLimit: WORD_LIMIT,
          ...(nextRange
            ? { startTime: nextRange.start, endTime: nextRange.end, skipTimeline: true }
            : { recentYear: true }),
        })) as StatsReport;
        if (seq !== reportSeqRef.current) return;
        loadedOnceRef.current = true;
        // 时间轴 / 绿墙是全历史口径，重算区间时保持**同一份引用**：
        // 既省一次重绘，也确保它们不会被区间选择带着闪一下。
        setReport((prev) => (prev ? { ...r, timeline: prev.timeline } : r));
        lastFetchedRangeRef.current =
          r.range.startTime && r.range.endTime ? `${r.range.startTime}:${r.range.endTime}` : '';
        if (!nextRange && r.range.startTime && r.range.endTime) {
          setRange({ start: r.range.startTime, end: r.range.endTime });
        }
      } catch (e) {
        if (seq !== reportSeqRef.current) return;
        setReportError(e instanceof Error ? e.message : String(e));
      } finally {
        if (seq === reportSeqRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [groupCode],
  );

  // 入群批次：只读成员表 + 一条聚合 SQL，很快。
  const loadBatches = useCallback(async () => {
    setBatchesLoading(true);
    setBatchesError(null);
    try {
      const r = await client.account.getGroupJoinBatches.query({ groupCode });
      setBatches(r as JoinBatchReport);
    } catch (e) {
      setBatchesError(e instanceof Error ? e.message : String(e));
      setBatches(null);
    } finally {
      setBatchesLoading(false);
    }
  }, [groupCode]);

  // 小团体：翻一遍消息时间线（只读发送者 + 时间），比正文扫描便宜。
  const loadGraph = useCallback(
    async (nextRange: RangeSelection | null) => {
      setGraphLoading(true);
      setGraphError(null);
      try {
        const r = await client.account.getGroupConversationGraph.query({
          groupCode,
          ...(nextRange ? { startTime: nextRange.start, endTime: nextRange.end } : {}),
        });
        setGraph(r as ConversationGraphReport);
      } catch (e) {
        setGraphError(e instanceof Error ? e.message : String(e));
        setGraph(null);
      } finally {
        setGraphLoading(false);
      }
    },
    [groupCode],
  );

  // 导出窗口里的数据是外面递进来的：已有初始数据就别再扫一遍群历史。
  const seeded = Boolean(initialData);
  useEffect(() => {
    if (seeded) return;
    void loadReport(null);
    void loadBatches();
  }, [seeded, loadReport, loadBatches]);

  // 小团体随区间重算；首次要等 stats 回来、知道默认「最近一年」的区间后再拉。
  // 空群（没有任何带时间的消息）拿不到区间，这时退回全历史，别让力图永远转圈。
  const graphRangeRef = useRef('');
  useEffect(() => {
    if (seeded) return;
    const key = range ? `${range.start}:${range.end}` : report ? 'all' : '';
    if (!key || key === graphRangeRef.current) return;
    graphRangeRef.current = key;
    void loadGraph(range);
  }, [seeded, range, report, loadGraph]);

  // 拖动结束后按新区间重算统计（热力图 / 时间轴不在其中，数据来自全历史）。
  useEffect(() => {
    if (seeded || !range) return;
    const key = `${range.start}:${range.end}`;
    if (key === lastFetchedRangeRef.current) return;
    void loadReport(range);
  }, [seeded, range, loadReport]);

  // 首屏：排行/批次先落地就替换骨架屏；会话力图要扫全群历史，单独再等它一会儿。
  const booting = loading || (batchesLoading && !batches);
  // 数据没齐时别导出 —— 舞台上会只剩骨架屏 / 转圈。
  const busy = booting || graphLoading || refreshing;

  const overview = useMemo(() => {
    if (!report) return null;
    const { totals } = report;
    return {
      total: totals.totalMessages,
      activeDays: totals.activeDays,
      avgPerDay: totals.activeDays > 0 ? Math.round(totals.totalMessages / totals.activeDays) : 0,
      peak: peakHour(report.timeDistribution),
      speakers: totals.speakerCount,
    };
  }, [report]);

  const dateRange = useMemo(() => {
    const span = report?.range;
    if (!span?.startTime || !span.endTime) return null;
    return { from: formatDate(span.startTime), to: formatDate(span.endTime) };
  }, [report]);

  const ranking = report?.ranking ?? null;
  const maxRankCount = ranking?.[0]?.messageCount ?? 0;

  const { exporting, start: startExport } = useAnalyticsExport({
    enabled: !busy && !exportMode,
    build: () =>
      report
        ? {
            kind: 'group',
            title: groupName,
            label: EXPORT_LABEL,
            groupCode,
            groupName,
            memberCount,
            avatarUrl: avatarUrl ?? null,
            data: { report, batches, graph },
          }
        : null,
  });

  /**
   * 卡片正文。`forExport` 用来切换细节：
   *   - 力导图在离屏舞台里要「一把算完」，不能等它慢慢降温（否则会拍到半路的图）。
   */
  const renderSections = (forExport: boolean) => (
    <div className="ga-overview">
      {/* Hero：群头像 + 名字 + 口径概览 */}
      <div className="ga-ov-hero">
        <Avatar name={groupName} avatarUrl={avatarUrl ?? null} seed={groupCode} />
        <div className="ga-ov-hero-info">
          <strong>{groupName}</strong>
          <span>
            {dateRange ? `${dateRange.from} — ${dateRange.to}` : '暂无聊天记录'}
            {overview ? ` · 共 ${formatNumber(overview.total)} 条消息` : ''}
          </span>
          <div className="ga-ov-hero-chips">
            {memberCount ? (
              <span className="ga-ov-chip">
                <Users size={11} />
                {memberCount.toLocaleString('en-US')} 位成员
              </span>
            ) : null}
            {overview ? (
              <span className="ga-ov-chip">
                <CalendarDays size={11} />
                活跃 {overview.activeDays} 天
              </span>
            ) : null}
            {overview && overview.speakers > 0 ? (
              <span className="ga-ov-chip">
                <MessageSquare size={11} />
                {overview.speakers} 人冒过泡
              </span>
            ) : null}
          </div>
        </div>
      </div>

      {/* 时间轴：全历史周柱状图 + 可拖动的消息曲线（默认最近一年） */}
      {report ? (
        <section className="ga-ov-section ca-block">
          <div className="ca-block-head">
            <h3>
              <CalendarDays size={15} />
              活跃时间轴
            </h3>
            <small>每周一根柱子 · 拖动下方曲线选择区间</small>
          </div>
          <GitHubTimeline weeks={report.timeline.weekly} range={range} />
          <RangeTimeline
            weeks={report.timeline.weekly}
            daily={report.timeline.daily}
            firstTime={report.timeline.firstMessageTime}
            lastTime={report.timeline.lastMessageTime}
            range={range}
            onChange={setRange}
          />
        </section>
      ) : null}

      {/* 概览四个数 */}
      {overview ? (
        <div className="ga-ov-stat-grid">
          <div className="ga-ov-stat">
            <MessageSquare size={16} />
            <strong>{formatNumber(overview.total)}</strong>
            <small>总消息</small>
          </div>
          <div className="ga-ov-stat">
            <CalendarDays size={16} />
            <strong>{overview.activeDays}</strong>
            <small>活跃天数</small>
          </div>
          <div className="ga-ov-stat is-peak">
            <Flame size={16} />
            <strong>{overview.peak ? `${overview.peak.hour} 点` : '—'}</strong>
            <small>最活跃时段</small>
          </div>
          <div className="ga-ov-stat">
            <TrendingUp size={16} />
            <strong>{formatNumber(overview.avgPerDay)}</strong>
            <small>日均消息</small>
          </div>
        </div>
      ) : null}

      {/* 入群批次（3 小时内挤够人算一批） */}
      <section className="ga-ov-section">
        <h3>
          <CalendarDays size={15} />
          入群批次
          <small>3 小时内 ≥ max(3, 群人数÷20) 人</small>
        </h3>
        {batchesError ? (
          <div className="ga-error">{batchesError}</div>
        ) : !batches ? (
          <div className="ga-loading">
            <Loader2 size={22} className="weq-spin" />
          </div>
        ) : (
          <div className={batchesLoading ? 'gc-stale' : undefined}>
            <GroupJoinBatches report={batches} />
          </div>
        )}
      </section>

      {/* 小团体：会话拉力力图（随所选区间重算） */}
      <section className={`ga-ov-section${refreshing || graphLoading ? ' ca-refreshing' : ''}`}>
        <h3>
          <Network size={15} />
          小团体
          <small>5 分钟一段对话 · 拉力 = 发言条数乘积之和</small>
        </h3>
        {graphError ? (
          <div className="ga-error">{graphError}</div>
        ) : !graph ? (
          <span className="weq-skeleton cg-skeleton" aria-label="正在计算会话拉力…" />
        ) : (
          <GroupConversationGraph report={graph} instant={forExport} />
        )}
      </section>

      {/* 发言排行：前 10 名，每人一张周卡（头像 / 昵称 / 每周发言） */}
      <section className={`ga-ov-section${refreshing ? ' ca-refreshing' : ''}`}>
        <h3>
          <Medal size={15} />
          发言排行
          <small>所选区间 · 前 {RANKING_LIMIT} 名 · 每周发言</small>
        </h3>
        {reportError ? (
          <div className="ga-error">{reportError}</div>
        ) : !ranking ? (
          <div className="ga-loading">
            <Loader2 size={22} className="weq-spin" />
          </div>
        ) : ranking.length === 0 ? (
          <p className="ga-placeholder">暂无发言数据</p>
        ) : (
          <div className="ca-people">
            {ranking.map((item, idx) => (
              <PersonWeekCard
                key={item.uid}
                name={item.displayName}
                avatarUrl={avatarUrlOf(item.uin)}
                count={item.messageCount}
                weekly={item.weekly ?? []}
                rank={idx + 1}
                subtitle={
                  maxRankCount > 0
                    ? `占最高 ${Math.round((item.messageCount / maxRankCount) * 100)}%`
                    : undefined
                }
              />
            ))}
          </div>
        )}
      </section>

      {/* 活跃时段（随区间）+ 每日热力图（全历史，不随区间） */}
      <section className="ga-ov-section">
        <h3>
          <Clock size={15} />
          活跃时段
          {overview?.peak ? (
            <small>
              高峰 {overview.peak.hour}:00 · {formatNumber(overview.peak.count)} 条
            </small>
          ) : null}
        </h3>
        {reportError ? (
          <div className="ga-error">{reportError}</div>
        ) : !report ? (
          <div className="ga-loading">
            <Loader2 size={22} className="weq-spin" />
          </div>
        ) : (
          <>
            <div className={`ga-ov-card${refreshing ? ' ca-refreshing' : ''}`}>
              <HourlyBarChart data={report.timeDistribution} />
            </div>
            {/* 绿墙（每日热力图）用**全历史**数据：它不随区间选择变，保持稳定。 */}
            <div className="ga-ov-card">
              <ContributionHeatmap data={report.timeline.daily ?? []} />
            </div>
          </>
        )}
      </section>

      {/* 群词云 */}
      <section className={`ga-ov-section${refreshing ? ' ca-refreshing' : ''}`}>
        <h3>
          <Cloud size={15} />
          群词云
          <small>全群高频词</small>
        </h3>
        {reportError ? (
          <div className="ga-error">{reportError}</div>
        ) : !report ? (
          <div className="ga-loading">
            <Loader2 size={22} className="weq-spin" />
          </div>
        ) : report.words.length > 0 ? (
          <WordCloud words={report.words} />
        ) : (
          <p className="ga-placeholder">暂无足够的文本数据生成词云</p>
        )}
      </section>
    </div>
  );

  /** 卡片本体：可见弹窗与导出窗口共用（导出窗口里不要头部按钮）。 */
  const card = (
    <section
      className="group-album-dialog ga-dialog"
      role="dialog"
      aria-modal={exportMode ? undefined : 'true'}
      aria-label={`${groupName} 的群聊分析`}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <header>
        <div>
          <strong>群聊分析</strong>
          <span>{groupName}</span>
        </div>
        {exportMode ? null : (
          <div className="ga-head-actions">
            <button
              className="icon-button"
              type="button"
              title="保存为图片"
              onClick={startExport}
              disabled={exporting || busy}
            >
              {exporting ? <Loader2 size={18} className="weq-spin" /> : <ImageDown size={18} />}
            </button>
            <button className="icon-button" type="button" title="关闭" onClick={onClose}>
              <X size={18} />
            </button>
          </div>
        )}
      </header>

      <div className="group-album-body ga-body">
        {booting ? <AnalyticsSkeleton variant="group" /> : renderSections(exportMode)}
      </div>
    </section>
  );

  // 导出窗口里整页就是这张卡片：不需要遮挡层。
  if (exportMode) return card;

  return (
    <OverlayLayer className="modal-scrim group-album-scrim" onClose={onClose}>
      {card}
    </OverlayLayer>
  );
}
