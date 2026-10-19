// @ts-nocheck
import {
  Clock,
  Cloud,
  Flame,
  ImageDown,
  Loader2,
  MessageSquare,
  Send,
  Smile,
  Type as TypeIcon,
  X,
  Zap,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { client } from '../trpc/client';
import { Avatar } from '../im-template/template/primitives';
import { OverlayLayer } from './OverlayLayer';
import { FaceEmoji } from './FaceEmoji';
import { AnalyticsSkeleton } from './AnalyticsSkeleton';
import {
  ContributionHeatmap,
  DonutChart,
  HourlyBarChart,
  WordCloud,
  formatDate,
  formatDuration,
  formatNumber,
} from './analyticsCharts';
import { useAnalyticsExport } from './useAnalyticsExport';
import type { AnalysisScope } from '../views/analysis/model';
import { AnalyticsRetry } from './AnalyticsRetry';
import {
  GitHubTimeline,
  PersonWeekCard,
  RangeTimeline,
  type RangeSelection,
} from './conversationTimeline';
import '../styles/conversation-analytics.css';

const SELF_COLOR = 'var(--weq-accent-effective)';
const PEER_COLOR = '#8b5cf6';
/** 导出图片的默认文件名前缀。 */
const EXPORT_LABEL = '私聊分析';

const TYPE_META: Array<{ key: string; label: string; color: string }> = [
  { key: 'text', label: '文本', color: '#3b82f6' },
  { key: 'image', label: '图片', color: '#22c55e' },
  { key: 'voice', label: '语音', color: '#f97316' },
  { key: 'video', label: '视频', color: '#a855f7' },
  { key: 'emoji', label: '表情', color: '#ec4899' },
  { key: 'other', label: '其他', color: '#6b7280' },
];

type BuddyAnalyticsData = Awaited<ReturnType<typeof client.account.getBuddyAnalytics.query>>;

function avatarUrl(uin: string | undefined | null): string | null {
  return uin && uin !== '0' ? `https://thirdqq.qlogo.cn/g?b=sdk&nk=${uin}&s=0` : null;
}

/** Reply-speed card for one side. */
function ReplyCard({
  who,
  stats,
  color,
}: {
  who: string;
  stats: { fastestSec: number; slowestSec: number; avgSec: number; count: number } | null;
  color: string;
}) {
  return (
    <div className="ba-reply-card">
      <div className="ba-reply-who" style={{ color }}>
        <Zap size={14} />
        {who}
      </div>
      {stats ? (
        <div className="ba-reply-rows">
          <div>
            <small>最快</small>
            <strong>{formatDuration(stats.fastestSec)}</strong>
          </div>
          <div>
            <small>平均</small>
            <strong>{formatDuration(stats.avgSec)}</strong>
          </div>
          <div>
            <small>最慢</small>
            <strong>{formatDuration(stats.slowestSec)}</strong>
          </div>
        </div>
      ) : (
        <span className="ga-chip-empty">暂无回复数据</span>
      )}
    </div>
  );
}

function PhraseChips({ items }: { items: Array<{ phrase: string; count: number }> }) {
  if (!items || items.length === 0) return <span className="ga-chip-empty">暂无常用语</span>;
  return (
    <div className="ga-chips">
      {items.map((item) => (
        <span className="ga-chip" key={item.phrase}>
          <span>{item.phrase}</span>
          <small>{item.count}</small>
        </span>
      ))}
    </div>
  );
}

function EmojiChips({
  items,
}: {
  items: Array<{ faceId: number; faceText: string; count: number }>;
}) {
  if (!items || items.length === 0) return <span className="ga-chip-empty">暂无表情数据</span>;
  return (
    <div className="ga-chips">
      {items.map((item) => (
        <span className="ga-chip ga-emoji-chip" key={item.faceId} title={item.faceText}>
          <FaceEmoji element={{ faceId: item.faceId, faceText: item.faceText }} size={22} />
          <small>{item.count}</small>
        </span>
      ))}
    </div>
  );
}

export function BuddyAnalyticsDialog({
  peerUid,
  peerName,
  onClose,
  exportMode = false,
  initialData,
  embedded = false,
  scope,
  periodLabel,
}: {
  peerUid: string;
  peerName: string;
  onClose: () => void;
  /** 导出窗口里的渲染口径：不画遮罩、不带头部按钮，宽度按长图铺开。 */
  exportMode?: boolean;
  /** 导出时由可见窗口递过来的数据，避免同一份分析再扫一遍。 */
  initialData?: unknown;
  embedded?: boolean;
  scope?: AnalysisScope;
  periodLabel?: string;
}) {
  const [data, setData] = useState<BuddyAnalyticsData | null>(
    (initialData as BuddyAnalyticsData) ?? null,
  );
  const [loading, setLoading] = useState(!initialData);
  const [error, setError] = useState<string | null>(null);
  /** 时间轴选择；首次响应会把服务端的「最近一年」回填进来。 */
  const [range, setRange] = useState<RangeSelection | null>(() => {
    const seeded = initialData as BuddyAnalyticsData | undefined;
    return seeded?.range?.startTime && seeded.range.endTime
      ? { start: seeded.range.startTime, end: seeded.range.endTime }
      : null;
  });
  const [refreshing, setRefreshing] = useState(false);
  const loadedOnceRef = useRef(Boolean(initialData));
  const seqRef = useRef(0);
  const lastFetchedRangeRef = useRef(
    (() => {
      const seeded = initialData as BuddyAnalyticsData | undefined;
      return seeded?.range?.startTime && seeded.range.endTime
        ? `${seeded.range.startTime}:${seeded.range.endTime}`
        : '';
    })(),
  );

  const load = useCallback(
    async (nextRange: RangeSelection | null = null) => {
      const seq = ++seqRef.current;
      if (!loadedOnceRef.current) setLoading(true);
      else setRefreshing(true);
      setError(null);
      try {
        const result = await client.account.getBuddyAnalytics.query({
          peerUid,
          ...scope,
          ...(nextRange
            ? { startTime: nextRange.start, endTime: nextRange.end }
            : scope
              ? {}
              : { recentYear: true }),
        });
        if (seq !== seqRef.current) return;
        loadedOnceRef.current = true;
        // 时间轴 / 绿墙保持同一份引用，不随区间重算重绘。
        setData((prev) => (prev ? { ...result, timeline: prev.timeline } : result));
        lastFetchedRangeRef.current =
          result.range.startTime && result.range.endTime
            ? `${result.range.startTime}:${result.range.endTime}`
            : '';
        if (!nextRange && result.range.startTime && result.range.endTime) {
          setRange({ start: result.range.startTime, end: result.range.endTime });
        }
      } catch (e) {
        if (seq !== seqRef.current) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (seq === seqRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [peerUid, scope],
  );

  // 导出窗口里的数据是外面递进来的：已有初始数据就别再查一遍。
  const seeded = Boolean(initialData);
  useEffect(() => {
    if (seeded) return;
    void load(null);
  }, [seeded, load]);

  // 拖动结束后按新区间重算（绿墙 / 时间轴来自全历史，不参与）。
  useEffect(() => {
    if (seeded || !range) return;
    const key = `${range.start}:${range.end}`;
    if (key === lastFetchedRangeRef.current) return;
    void load(range);
  }, [seeded, range, load]);

  // 「保存为图片」：把数据交给主进程 —— 它在隐藏窗口里渲染 + 抓图 + 弹保存框。
  const {
    available: imageAvailable,
    exporting,
    start: startExport,
  } = useAnalyticsExport({
    enabled: !loading && !refreshing && !error && !!data && !exportMode,
    build: () =>
      data
        ? {
            kind: 'buddy',
            title: peerName,
            label: EXPORT_LABEL,
            peerUid,
            periodLabel,
            data,
          }
        : null,
  });

  const stats = data?.statistics;
  const typeTotal = data
    ? TYPE_META.reduce((sum, t) => sum + (data.messageTypes[t.key] ?? 0), 0)
    : 0;

  /** 卡片正文：可见弹窗与离屏导出舞台共用同一份 JSX。 */
  const renderSections = () => (
    <>
      {/* Hero: peer + overview */}
      <div className="ba-hero">
        <Avatar name={peerName} avatarUrl={avatarUrl(data.peer?.uin)} />
        <div className="ba-hero-info">
          <strong>{peerName}</strong>
          <span>
            {formatDate(stats.firstMessageTime)} — {formatDate(stats.lastMessageTime)}
          </span>
        </div>
      </div>

      {/* 时间轴：所选区间周柱状图 + 可拖动的消息曲线（默认最近一年） */}
      {data.timeline ? (
        <section className="ba-section ca-block">
          <div className="ca-block-head">
            <h3>
              <Clock size={15} />
              活跃时间轴
            </h3>
            <small>所选区间每周一根 · 拖动下方曲线重排</small>
          </div>
          <GitHubTimeline weeks={data.timeline.weekly} range={range} />
          <RangeTimeline
            weeks={data.timeline.weekly}
            daily={data.timeline.daily}
            firstTime={data.timeline.firstMessageTime}
            lastTime={data.timeline.lastMessageTime}
            range={range}
            onChange={setRange}
          />
        </section>
      ) : null}

      <div className="ba-stat-grid">
        <div className="ba-stat">
          <MessageSquare size={16} />
          <strong>{formatNumber(stats.totalMessages)}</strong>
          <small>总消息</small>
        </div>
        <div className="ba-stat">
          <Clock size={16} />
          <strong>{stats.activeDays}</strong>
          <small>聊天天数</small>
        </div>
        <div className="ba-stat ba-stat-flame">
          <Flame size={16} />
          <strong>{data.streak?.longest ?? 0}</strong>
          <small>最长火花</small>
        </div>
        <div className="ba-stat">
          <Send size={16} />
          <strong>{data.initiation?.total ?? 0}</strong>
          <small>对话次数</small>
        </div>
      </div>

      {/* 双方周卡：私聊只有两个人，卡片直接就是排行 */}
      <section className={`ba-section${refreshing ? ' ca-refreshing' : ''}`}>
        <h3>
          <MessageSquare size={15} /> 双方发言
          <small>所选区间 · 每周消息</small>
        </h3>
        <div className="ca-people is-buddy">
          <PersonWeekCard
            name="我"
            avatarUrl={avatarUrl(data.self.uin)}
            count={stats.selfMessages}
            weekly={data.weeklySelf ?? []}
            accent={SELF_COLOR}
          />
          <PersonWeekCard
            name={peerName}
            avatarUrl={avatarUrl(data.peer.uin)}
            count={stats.peerMessages}
            weekly={data.weeklyPeer ?? []}
            accent={PEER_COLOR}
          />
        </div>
      </section>

      {/* Donut block: 发言对比 + 主动发起 side by side, 消息类型 full width */}
      <div className="ba-donut-grid">
        <section className="ba-section ba-card">
          <h3>
            <MessageSquare size={15} /> 发言对比
          </h3>
          <DonutChart
            size={116}
            segments={[
              { label: '我', value: stats.selfMessages, color: SELF_COLOR },
              { label: peerName, value: stats.peerMessages, color: PEER_COLOR },
            ]}
            centerLabel={formatNumber(stats.totalMessages)}
            centerSub="消息"
          />
        </section>

        <section className="ba-section ba-card">
          <h3>
            <Send size={15} /> 主动发起
          </h3>
          <DonutChart
            size={116}
            segments={[
              { label: '我', value: data.initiation?.self ?? 0, color: SELF_COLOR },
              { label: peerName, value: data.initiation?.peer ?? 0, color: PEER_COLOR },
            ]}
            centerLabel={String(data.initiation?.total ?? 0)}
            centerSub="次对话"
          />
        </section>

        <section className="ba-section ba-card ba-card-wide">
          <h3>
            <TypeIcon size={15} /> 消息类型比例
          </h3>
          {typeTotal > 0 ? (
            <>
              <div className="ba-langbar">
                {TYPE_META.map((t) => {
                  const v = data.messageTypes[t.key] ?? 0;
                  if (v <= 0) return null;
                  return (
                    <div
                      key={t.key}
                      style={{ width: `${(v / typeTotal) * 100}%`, background: t.color }}
                      title={`${t.label} ${v}`}
                    />
                  );
                })}
              </div>
              <div className="ba-langlegend">
                {TYPE_META.filter((t) => (data.messageTypes[t.key] ?? 0) > 0).map((t) => {
                  const v = data.messageTypes[t.key] ?? 0;
                  const pctNum = (v / typeTotal) * 100;
                  const pct = pctNum >= 0.5 ? `${Math.round(pctNum)}%` : '<1%';
                  return (
                    <span className="ba-langlegend-item" key={t.key} title={`${v} 条`}>
                      <i style={{ background: t.color }} />
                      <span className="lbl">{t.label}</span>
                      <span className="pct">{pct}</span>
                    </span>
                  );
                })}
              </div>
            </>
          ) : (
            <span className="ga-chip-empty">暂无数据</span>
          )}
        </section>
      </div>

      {/* Reply speed */}
      <section className="ba-section">
        <h3>
          <Zap size={15} /> 回复速度
        </h3>
        <div className="ba-reply-grid">
          <ReplyCard who="我" stats={data.reply?.self} color={SELF_COLOR} />
          <ReplyCard who={peerName} stats={data.reply?.peer} color={PEER_COLOR} />
        </div>
      </section>

      {/* Active hours both */}
      <section className={`ba-section${refreshing ? ' ca-refreshing' : ''}`}>
        <h3>
          <Clock size={15} /> 活跃时段
        </h3>
        <div className="ba-hours-legend">
          <span>
            <i style={{ background: SELF_COLOR }} /> 我
          </span>
          <span>
            <i style={{ background: PEER_COLOR }} /> {peerName}
          </span>
        </div>
        <div className="ba-hours-block">
          <HourlyBarChart data={data.hourlySelf} color={SELF_COLOR} />
        </div>
        <div className="ba-hours-block">
          <HourlyBarChart data={data.hourlyPeer} color={PEER_COLOR} />
        </div>
      </section>

      {/* Heatmap: 绿墙看全历史，不随区间选择重算 */}
      <section className="ba-section">
        <h3>
          <Flame size={15} /> 每日消息热力图
        </h3>
        <ContributionHeatmap data={data.timeline?.daily ?? data.daily} />
      </section>

      {/* Word cloud */}
      <section className={`ba-section${refreshing ? ' ca-refreshing' : ''}`}>
        <h3>
          <Cloud size={15} /> 聊天词云
        </h3>
        {data.wordCloud && data.wordCloud.length > 0 ? (
          <WordCloud words={data.wordCloud} height={260} />
        ) : (
          <span className="ga-chip-empty">暂无足够的文本生成词云</span>
        )}
      </section>

      {/* Common phrases */}
      <section className={`ba-section${refreshing ? ' ca-refreshing' : ''}`}>
        <h3>
          <MessageSquare size={15} /> 双方口头禅
        </h3>
        <div className="ba-two-col">
          <div>
            <h4 style={{ color: SELF_COLOR }}>我</h4>
            <PhraseChips items={data.phrasesSelf} />
          </div>
          <div>
            <h4 style={{ color: PEER_COLOR }}>{peerName}</h4>
            <PhraseChips items={data.phrasesPeer} />
          </div>
        </div>
      </section>

      {/* Common emojis */}
      <section className={`ba-section${refreshing ? ' ca-refreshing' : ''}`}>
        <h3>
          <Smile size={15} /> 双方常用表情
        </h3>
        <div className="ba-two-col">
          <div>
            <h4 style={{ color: SELF_COLOR }}>我</h4>
            <EmojiChips items={data.emojisSelf} />
          </div>
          <div>
            <h4 style={{ color: PEER_COLOR }}>{peerName}</h4>
            <EmojiChips items={data.emojisPeer} />
          </div>
        </div>
      </section>
    </>
  );

  /** 卡片本体：可见弹窗与导出窗口共用（导出窗口里不要头部按钮）。 */
  const card = (
    <section
      className="group-album-dialog ba-dialog"
      role="region"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <header>
        <div>
          <strong>私聊分析</strong>
          <span>{peerName}</span>
        </div>
        {exportMode ? null : (
          <div className="ga-head-actions">
            <button
              className="icon-button"
              type="button"
              title={imageAvailable ? '保存为图片' : '当前环境不支持保存长图'}
              onClick={startExport}
              disabled={!imageAvailable || exporting || loading || !!error || !data}
            >
              {exporting ? <Loader2 size={18} className="weq-spin" /> : <ImageDown size={18} />}
            </button>
            <button className="icon-button" type="button" title="关闭" onClick={onClose}>
              <X size={18} />
            </button>
          </div>
        )}
      </header>
      {periodLabel ? <p className="weq-analysis-period">{periodLabel}</p> : null}

      <div className="group-album-body ba-body">
        {loading ? (
          <AnalyticsSkeleton variant="buddy" />
        ) : error ? (
          <AnalyticsRetry error={error} onRetry={() => void load()} />
        ) : !data ? (
          <p className="ga-placeholder">暂无分析数据</p>
        ) : (
          renderSections()
        )}
      </div>
    </section>
  );

  // 导出窗口里整页就是这张卡片：不需要遮挡层。
  if (exportMode || embedded) return card;

  return (
    <OverlayLayer
      presentation="sidecar"
      title="好友分析"
      className="modal-scrim group-album-scrim"
      onClose={onClose}
    >
      {card}
    </OverlayLayer>
  );
}
