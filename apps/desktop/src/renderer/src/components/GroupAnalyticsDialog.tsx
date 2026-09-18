// @ts-nocheck
/**
 * 群聊分析 —— 单页合并版。
 *
 * 原先把「发言排行 / 活跃时段 / 词云 / 成员逐个分析」做成四个入口的四屏导航，
 * 现在把前三者压成**一页纵向长卡片**：点进来就是全群画像，不用先过一层菜单。
 * 成员级的分析（某人在群里发了多少、爱说什么）挪到了资料卡
 * （{@link ./MemberProfileCard}）底部的「聊天分析」按钮，点击弹出灯箱。
 *
 * 数据只走两路：
 *   - `getGroupStatsReport` —— 排行 / 活跃时段 / 每日热力图 / 词云 **一次扫描**全算完
 *     （以前是并发拉四个接口，等于把同一张表扫四遍，群历史越长越亏）；
 *   - `getGroupJoinClusters` —— 小团体分析，只读成员表 + 一条按发送者聚合的 SQL。
 * 任一路失败只标出该路的错误，不把整页拖垮。
 *
 * 右上角「保存为图片」走 {@link ./analyticsShot}：逐屏抓真实窗口再拼成一张长图。
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
  TrendingUp,
  Users,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { client } from '../trpc/client';
import { Avatar } from '../im-template/template/primitives';
import { closeFromScrim, useEscapeToClose } from '../im-template/template/modalUtils';
import { useToast } from './Toast';
import { exportAnalyticsCard } from './analyticsShot';
import {
  ContributionHeatmap,
  HourlyBarChart,
  WordCloud,
  formatDate,
  formatNumber,
  type DailyActivityItem,
  type WordCloudItem,
} from './analyticsCharts';
import { GroupJoinClusters, type JoinClusterReport } from './GroupJoinClusters';

/** 排行榜只取前几名 —— 长榜单在这里没人看完，前 10 已经够用。 */
const RANKING_LIMIT = 10;
/** 词云取前 150 个词。 */
const WORD_LIMIT = 150;
/**
 * 小团体的时间窗口可选值（天）—— 默认 3 天。
 * 小团体的信号是「短时间」：「同一天涌进来 4 个人」比「两周陆续来 200 个人」像一伙得多。
 */
const JOIN_WINDOW_CHOICES = [1, 3, 7] as const;

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
}: {
  groupCode: string;
  groupName: string;
  /** 群总人数（来自会话详情），仅用于 hero 上的一枚小徽章。 */
  memberCount?: number;
  /** 群头像，用于 hero；拿不到就退回首字母占位。 */
  avatarUrl?: string | null;
  onClose: () => void;
}) {
  useEscapeToClose(onClose);

  const rootRef = useRef<HTMLElement | null>(null);
  const [exporting, setExporting] = useState(false);

  const [report, setReport] = useState<StatsReport | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);

  const [clusters, setClusters] = useState<JoinClusterReport | null>(null);
  const [clustersError, setClustersError] = useState<string | null>(null);
  const [clustersLoading, setClustersLoading] = useState(true);
  const [windowDays, setWindowDays] = useState<number>(JOIN_WINDOW_CHOICES[1]);

  const [loading, setLoading] = useState(true);

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

  // 小团体单独一路：切窗口只重拉这一路（它只读成员表 + 一条聚合 SQL，很快）。
  const loadClusters = useCallback(async () => {
    setClustersLoading(true);
    setClustersError(null);
    try {
      const r = await client.account.getGroupJoinClusters.query({ groupCode, windowDays });
      setClusters(r as JoinClusterReport);
    } catch (e) {
      setClustersError(e instanceof Error ? e.message : String(e));
      setClusters(null);
    } finally {
      setClustersLoading(false);
    }
  }, [groupCode, windowDays]);

  useEffect(() => {
    void loadReport();
  }, [loadReport]);

  useEffect(() => {
    void loadClusters();
  }, [loadClusters]);

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

  const handleExport = useCallback(async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const result = await exportAnalyticsCard({
        root: rootRef.current,
        title: groupName,
        label: '群聊分析',
      });
      const toast = useToast.getState();
      if (result.saved) {
        toast.push({ tone: 'success', title: '长图已保存', detail: result.path });
      } else if (!result.canceled) {
        toast.push({ tone: 'error', title: '保存图片失败', detail: result.error });
      }
    } finally {
      setExporting(false);
    }
  }, [exporting, groupName]);

  return (
    <div
      className="modal-scrim group-album-scrim"
      role="presentation"
      onMouseDown={closeFromScrim(onClose)}
    >
      <section
        className="group-album-dialog ga-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`${groupName} 的群聊分析`}
        ref={rootRef}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header>
          <div>
            <strong>群聊分析</strong>
            <span>{groupName}</span>
          </div>
          <div className="ga-head-actions" data-shot-hide>
            <button
              className="icon-button"
              type="button"
              title="保存为图片"
              onClick={() => void handleExport()}
              disabled={exporting}
            >
              {exporting ? <Loader2 size={18} className="weq-spin" /> : <ImageDown size={18} />}
            </button>
            <button className="icon-button" type="button" title="关闭" onClick={onClose}>
              <X size={18} />
            </button>
          </div>
        </header>

        <div className="group-album-body ga-body">
          {loading && !overview ? (
            <div className="ga-loading">
              <Loader2 size={28} className="weq-spin" />
            </div>
          ) : (
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

              {/* 小团体分析（按入群时间聚类） */}
              <section className="ga-ov-section">
                <h3>
                  <Users size={15} />
                  小团体分析
                  <span className="gc-window" data-shot-hide>
                    {JOIN_WINDOW_CHOICES.map((days) => (
                      <button
                        key={days}
                        type="button"
                        className={days === windowDays ? 'is-on' : undefined}
                        title={`把「${days} 天内一起进来的人」算作一波`}
                        onClick={() => setWindowDays(days)}
                      >
                        {days} 天
                      </button>
                    ))}
                    {clustersLoading && clusters ? (
                      <Loader2 size={12} className="weq-spin" />
                    ) : null}
                  </span>
                </h3>
                {clustersError ? (
                  <div className="ga-error">{clustersError}</div>
                ) : !clusters ? (
                  <div className="ga-loading">
                    <Loader2 size={22} className="weq-spin" />
                  </div>
                ) : (
                  <div className={clustersLoading ? 'gc-stale' : undefined}>
                    <GroupJoinClusters report={clusters} />
                  </div>
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
                        <Avatar
                          name={item.displayName}
                          avatarUrl={avatarUrlOf(item.uin)}
                          seed={item.uid}
                        />
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
          )}
        </div>
      </section>
    </div>
  );
}
