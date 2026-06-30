// @ts-nocheck
import {
  Clock,
  Cloud,
  Flame,
  Loader2,
  MessageSquare,
  Send,
  Smile,
  Type as TypeIcon,
  X,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { client } from "../trpc/client";
import { Avatar } from "../im-template/template/primitives";
import { closeFromScrim, useEscapeToClose } from "../im-template/template/modalUtils";
import { FaceEmoji } from "./FaceEmoji";
import {
  ContributionHeatmap,
  DonutChart,
  HourlyBarChart,
  WordCloud,
  formatDate,
  formatDuration,
  formatNumber,
} from "./analyticsCharts";

const SELF_COLOR = "var(--weq-accent-effective)";
const PEER_COLOR = "#8b5cf6";

const TYPE_META: Array<{ key: string; label: string; color: string }> = [
  { key: "text", label: "文本", color: "#3b82f6" },
  { key: "image", label: "图片", color: "#22c55e" },
  { key: "voice", label: "语音", color: "#f97316" },
  { key: "video", label: "视频", color: "#a855f7" },
  { key: "emoji", label: "表情", color: "#ec4899" },
  { key: "other", label: "其他", color: "#6b7280" },
];

function avatarUrl(uin: string | undefined | null): string | null {
  return uin && uin !== "0" ? `https://thirdqq.qlogo.cn/g?b=sdk&nk=${uin}&s=0` : null;
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
      {items.map((item, idx) => (
        <span className="ga-chip" key={idx}>
          <span>{item.phrase}</span>
          <small>{item.count}</small>
        </span>
      ))}
    </div>
  );
}

function EmojiChips({ items }: { items: Array<{ faceId: number; faceText: string; count: number }> }) {
  if (!items || items.length === 0) return <span className="ga-chip-empty">暂无表情数据</span>;
  return (
    <div className="ga-chips">
      {items.map((item, idx) => (
        <span className="ga-chip ga-emoji-chip" key={idx} title={item.faceText}>
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
}: {
  peerUid: string;
  peerName: string;
  onClose: () => void;
}) {
  useEscapeToClose(onClose);

  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await client.account.getBuddyAnalytics.query({ peerUid });
      setData(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [peerUid]);

  useEffect(() => {
    void load();
  }, [load]);

  const stats = data?.statistics;
  const typeTotal = data
    ? TYPE_META.reduce((sum, t) => sum + (data.messageTypes[t.key] ?? 0), 0)
    : 0;

  return (
    <div
      className="modal-scrim group-album-scrim"
      role="presentation"
      onMouseDown={closeFromScrim(onClose)}
    >
      <section
        className="group-album-dialog ba-dialog"
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header>
          <div>
            <strong>私聊分析</strong>
            <span>{peerName}</span>
          </div>
          <button className="icon-button" type="button" title="关闭" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <div className="group-album-body ba-body">
          {loading ? (
            <div className="ga-loading">
              <Loader2 size={28} className="weq-spin" />
            </div>
          ) : error ? (
            <div className="ga-error">{error}</div>
          ) : !data ? (
            <p className="ga-placeholder">暂无分析数据</p>
          ) : (
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

              {/* Donut block: 发言对比 + 主动发起 side by side, 消息类型 full width */}
              <div className="ba-donut-grid">
                <section className="ba-section ba-card">
                  <h3>
                    <MessageSquare size={15} /> 发言对比
                  </h3>
                  <DonutChart
                    size={116}
                    segments={[
                      { label: "我", value: stats.selfMessages, color: SELF_COLOR },
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
                      { label: "我", value: data.initiation?.self ?? 0, color: SELF_COLOR },
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
                          const pct = pctNum >= 0.5 ? `${Math.round(pctNum)}%` : "<1%";
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
              <section className="ba-section">
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

              {/* Heatmap */}
              <section className="ba-section">
                <h3>
                  <Flame size={15} /> 每日消息热力图
                </h3>
                <ContributionHeatmap data={data.daily} />
              </section>

              {/* Word cloud */}
              <section className="ba-section">
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
              <section className="ba-section">
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
              <section className="ba-section">
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
          )}
        </div>
      </section>
    </div>
  );
}
