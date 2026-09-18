// @ts-nocheck
/**
 * 群聊分析 —— 单页合并版。
 *
 * 原先把「发言排行 / 活跃时段 / 词云 / 成员逐个分析」做成四个入口的四屏导航，
 * 现在把前三者压成**一页纵向长卡片**：点进来就是全群画像，不用先过一层菜单。
 * 成员级的分析（某人在群里发了多少、爱说什么）挪到了资料卡
 * （{@link ./MemberProfileCard}）底部的「聊天分析」按钮，点击弹出灯箱。
 *
 * 三路数据相互独立（排行 / 活跃时段+每日热力图 / 词云），进来一次性并发拉取，
 * 任一路失败只标出该路的错误，不把整页拖垮。
 */
import {
  CalendarDays,
  Clock,
  Cloud,
  Flame,
  Loader2,
  Medal,
  MessageSquare,
  TrendingUp,
  Users,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { client } from '../trpc/client';
import { Avatar } from '../im-template/template/primitives';
import { closeFromScrim, useEscapeToClose } from '../im-template/template/modalUtils';
import {
  ContributionHeatmap,
  HourlyBarChart,
  WordCloud,
  formatNumber,
  type DailyActivityItem,
  type WordCloudItem,
} from './analyticsCharts';

/** 排行榜只取前几名 —— 长榜单在这里没人看完，前 10 已经够用。 */
const RANKING_LIMIT = 10;

interface RankingItem {
  uid: string;
  uin: string;
  displayName: string;
  messageCount: number;
}

function avatarUrlOf(uin: string | undefined | null): string | null {
  return uin && uin !== '0' ? `https://thirdqq.qlogo.cn/g?b=sdk&nk=${uin}&s=0` : null;
}

/** 「2026-09-18」→「2026/09/18」；拿不到就返回 null。 */
function shortDay(value: string | undefined | null): string | null {
  if (!value) return null;
  const [y, m, d] = value.split('-');
  return y && m && d ? `${y}/${m}/${d}` : value;
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

  const [ranking, setRanking] = useState<RankingItem[] | null>(null);
  const [rankingError, setRankingError] = useState<string | null>(null);

  const [activeHours, setActiveHours] = useState<Record<number, number> | null>(null);
  const [dailyActivity, setDailyActivity] = useState<DailyActivityItem[] | null>(null);
  const [hoursError, setHoursError] = useState<string | null>(null);

  const [wordCloud, setWordCloud] = useState<WordCloudItem[] | null>(null);
  const [wordCloudError, setWordCloudError] = useState<string | null>(null);

  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setRankingError(null);
    setHoursError(null);
    setWordCloudError(null);

    // 三路并发，各自 settle：一路挂了不影响另外两路的展示。
    await Promise.all([
      client.account.getGroupMessageRanking
        .query({ groupCode, limit: RANKING_LIMIT })
        .then((r) => setRanking(r as RankingItem[]))
        .catch((e) => setRankingError(e instanceof Error ? e.message : String(e))),
      Promise.all([
        client.account.getGroupActiveHours.query({ groupCode }),
        client.account.getGroupDailyActivity.query({ groupCode }),
      ])
        .then(([hours, daily]) => {
          setActiveHours(hours as Record<number, number>);
          setDailyActivity(daily as DailyActivityItem[]);
        })
        .catch((e) => setHoursError(e instanceof Error ? e.message : String(e))),
      client.account.getGroupWordCloud
        .query({ groupCode, limit: 150 })
        .then((r) => setWordCloud(r as WordCloudItem[]))
        .catch((e) => setWordCloudError(e instanceof Error ? e.message : String(e))),
    ]);

    setLoading(false);
  }, [groupCode]);

  useEffect(() => {
    void load();
  }, [load]);

  const overview = useMemo(() => {
    if (!activeHours) return null;
    const total = Object.values(activeHours).reduce((sum, n) => sum + (n ?? 0), 0);
    const activeDays = dailyActivity?.length ?? 0;
    return {
      total,
      activeDays,
      avgPerDay: activeDays > 0 ? Math.round(total / activeDays) : 0,
      peak: peakHour(activeHours),
    };
  }, [activeHours, dailyActivity]);

  const range = useMemo(() => {
    if (!dailyActivity || dailyActivity.length === 0) return null;
    const from = shortDay(dailyActivity[0]?.date);
    const to = shortDay(dailyActivity[dailyActivity.length - 1]?.date);
    return from && to ? { from, to } : null;
  }, [dailyActivity]);

  const maxRankCount = ranking?.[0]?.messageCount ?? 0;

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
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header>
          <div>
            <strong>群聊分析</strong>
            <span>{groupName}</span>
          </div>
          <button className="icon-button" type="button" title="关闭" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <div className="group-album-body ga-body">
          {loading && !overview && !ranking ? (
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

              {/* 发言排行（前 N） */}
              <section className="ga-ov-section">
                <h3>
                  <Medal size={15} />
                  发言排行
                  <small>按发言条数 · 前 {RANKING_LIMIT} 名</small>
                </h3>
                {rankingError ? (
                  <div className="ga-error">{rankingError}</div>
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
                        <Avatar name={item.displayName} avatarUrl={avatarUrlOf(item.uin)} />
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
                {hoursError ? (
                  <div className="ga-error">{hoursError}</div>
                ) : !activeHours ? (
                  <div className="ga-loading">
                    <Loader2 size={22} className="weq-spin" />
                  </div>
                ) : (
                  <>
                    <div className="ga-ov-card">
                      <HourlyBarChart data={activeHours} />
                    </div>
                    <div className="ga-ov-card">
                      <ContributionHeatmap data={dailyActivity ?? []} />
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
                {wordCloudError ? (
                  <div className="ga-error">{wordCloudError}</div>
                ) : !wordCloud ? (
                  <div className="ga-loading">
                    <Loader2 size={22} className="weq-spin" />
                  </div>
                ) : wordCloud.length > 0 ? (
                  <WordCloud words={wordCloud} />
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
