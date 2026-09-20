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
import { useCallback, useEffect, useMemo, useState } from 'react';
import { client } from '../trpc/client';
import { Avatar } from '../im-template/template/primitives';
import { closeFromScrim, useEscapeToClose } from '../im-template/template/modalUtils';
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
  useEscapeToClose(onClose);

  const [report, setReport] = useState<StatsReport | null>(
    (initialData?.report as StatsReport) ?? null,
  );
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

  // 群画像（排行 / 时段 / 热力图 / 词云）：一次扫描的聚合，进卡片只拉这一次。
  const loadReport = useCallback(async () => {
    setLoading(true);
    setReportError(null);
    try {
      const r = await client.account.getGroupStatsReport.query({
        groupCode,
        rankingLimit: RANKING_LIMIT,
        wordLimit: WORD_LIMIT,
      });
      setReport(r as StatsReport);
    } catch (e) {
      setReportError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [groupCode]);

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
  const loadGraph = useCallback(async () => {
    setGraphLoading(true);
    setGraphError(null);
    try {
      const r = await client.account.getGroupConversationGraph.query({ groupCode });
      setGraph(r as ConversationGraphReport);
    } catch (e) {
      setGraphError(e instanceof Error ? e.message : String(e));
      setGraph(null);
    } finally {
      setGraphLoading(false);
    }
  }, [groupCode]);

  // 导出窗口里的数据是外面递进来的：已有初始数据就别再扫一遍群历史。
  const seeded = Boolean(initialData);
  useEffect(() => {
    if (seeded) return;
    void loadReport();
    void loadBatches();
    void loadGraph();
  }, [seeded, loadReport, loadBatches, loadGraph]);

  // 首屏：排行/批次先落地就替换骨架屏；会话力图要扫全群历史，单独再等它一会儿。
  const booting = loading || (batchesLoading && !batches);
  // 数据没齐时别导出 —— 舞台上会只剩骨架屏 / 转圈。
  const busy = booting || graphLoading;

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

  const range = useMemo(() => {
    const totals = report?.totals;
    if (!totals?.firstMessageTime || !totals.lastMessageTime) return null;
    return { from: formatDate(totals.firstMessageTime), to: formatDate(totals.lastMessageTime) };
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
            {range ? `${range.from} — ${range.to}` : '暂无聊天记录'}
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

      {/* 小团体：会话拉力力图 */}
      <section className="ga-ov-section">
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

      {/* 发言排行（前 N） */}
      <section className="ga-ov-section">
        <h3>
          <Medal size={15} />
          发言排行
          <small>按发言条数 · 前 {RANKING_LIMIT} 名</small>
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
          <div className="ga-ranking-list">
            {ranking.map((item, idx) => (
              <div
                className={`ga-ranking-item${idx === 0 ? ' rank-1' : idx === 1 ? ' rank-2' : idx === 2 ? ' rank-3' : ''}`}
                key={item.uid}
              >
                <span className={`ga-rank-num${idx < 3 ? ' top' : ''}`}>
                  {idx < 3 ? <Medal size={14} /> : idx + 1}
                </span>
                <Avatar name={item.displayName} avatarUrl={avatarUrlOf(item.uin)} seed={item.uid} />
                <div className="ga-rank-body">
                  <span className="ga-rank-name" title={item.displayName}>
                    {item.displayName}
                  </span>
                  <span className="ga-rank-track" aria-hidden="true">
                    <span
                      className="ga-rank-fill"
                      style={{
                        width: `${maxRankCount > 0 ? Math.max((item.messageCount / maxRankCount) * 100, 3) : 0}%`,
                      }}
                    />
                  </span>
                </div>
                <span className="ga-rank-count">{formatNumber(item.messageCount)} 条</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 活跃时段 + 每日热力图 */}
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
            <div className="ga-ov-card">
              <HourlyBarChart data={report.timeDistribution} />
            </div>
            <div className="ga-ov-card">
              <ContributionHeatmap data={report.daily ?? []} />
            </div>
          </>
        )}
      </section>

      {/* 群词云 */}
      <section className="ga-ov-section">
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
    <div
      className="modal-scrim group-album-scrim"
      role="presentation"
      onMouseDown={closeFromScrim(onClose)}
    >
      {card}
    </div>
  );
}
