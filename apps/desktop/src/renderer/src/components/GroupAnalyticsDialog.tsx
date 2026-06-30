// @ts-nocheck
import {
  BarChart3,
  ChevronLeft,
  Clock,
  Cloud,
  Loader2,
  Medal,
  MessageSquare,
  Search,
  Users,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { client } from "../trpc/client";
import { Avatar } from "../im-template/template/primitives";
import { cn } from "../im-template/template/classNames";
import { closeFromScrim, useEscapeToClose } from "../im-template/template/modalUtils";
import { FaceEmoji } from "./FaceEmoji";
import {
  ContributionHeatmap,
  HourlyBarChart,
  WordCloud,
  formatDate,
  formatNumber,
  type DailyActivityItem,
  type WordCloudItem,
} from "./analyticsCharts";

interface MemberWire {
  uid: string;
  uin: string;
  card: string;
  nick: string;
  joinTime: number;
  lastSpeakTime: number;
  adminFlag: number;
  customTitle: string;
  memberLevel: number;
}

interface RankingItem {
  uid: string;
  uin: string;
  displayName: string;
  messageCount: number;
}

interface MemberAnalyticsData {
  statistics: {
    totalMessages: number;
    textMessages: number;
    imageMessages: number;
    voiceMessages: number;
    videoMessages: number;
    emojiMessages: number;
    otherMessages: number;
    firstMessageTime: number | null;
    lastMessageTime: number | null;
    activeDays: number;
  };
  timeDistribution: Record<number, number>;
  commonPhrases: Array<{ phrase: string; count: number }>;
  commonEmojis: Array<{ faceId: number; faceText: string; count: number }>;
}

type View = "menu" | "members" | "memberAnalytics" | "ranking" | "activeHours" | "wordcloud";

function memberDisplayName(m: MemberWire): string {
  return m.card || m.nick || m.uin || m.uid || "?";
}

function memberAvatarUrl(m: MemberWire): string | null {
  if (m.uin && m.uin !== "0") {
    return `https://thirdqq.qlogo.cn/g?b=sdk&nk=${m.uin}&s=0`;
  }
  return null;
}

export function GroupAnalyticsDialog({
  groupCode,
  groupName,
  onClose,
}: {
  groupCode: string;
  groupName: string;
  onClose: () => void;
}) {
  useEscapeToClose(onClose);

  const [view, setView] = useState<View>("menu");
  const [members, setMembers] = useState<MemberWire[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [membersError, setMembersError] = useState<string | null>(null);

  const [ranking, setRanking] = useState<RankingItem[]>([]);
  const [rankingLoading, setRankingLoading] = useState(false);
  const [rankingError, setRankingError] = useState<string | null>(null);

  const [activeHours, setActiveHours] = useState<Record<number, number> | null>(null);
  const [dailyActivity, setDailyActivity] = useState<DailyActivityItem[] | null>(null);
  const [activeHoursLoading, setActiveHoursLoading] = useState(false);
  const [activeHoursError, setActiveHoursError] = useState<string | null>(null);

  const [wordCloud, setWordCloud] = useState<WordCloudItem[] | null>(null);
  const [wordCloudLoading, setWordCloudLoading] = useState(false);
  const [wordCloudError, setWordCloudError] = useState<string | null>(null);

  const [selectedMemberUid, setSelectedMemberUid] = useState<string>("");
  const [memberSearch, setMemberSearch] = useState("");
  const [memberAnalytics, setMemberAnalytics] = useState<MemberAnalyticsData | null>(null);
  const [memberAnalyticsLoading, setMemberAnalyticsLoading] = useState(false);
  const [memberAnalyticsError, setMemberAnalyticsError] = useState<string | null>(null);

  const selectedMember = useMemo(
    () => members.find((m) => m.uid === selectedMemberUid) ?? null,
    [members, selectedMemberUid],
  );

  const loadMembers = useCallback(async () => {
    setMembersLoading(true);
    setMembersError(null);
    try {
      const result = await client.account.listGroupMembers.query({ groupCode, limit: 300 });
      setMembers(result as MemberWire[]);
    } catch (e) {
      setMembersError(e instanceof Error ? e.message : String(e));
    } finally {
      setMembersLoading(false);
    }
  }, [groupCode]);

  useEffect(() => {
    void loadMembers();
  }, [loadMembers]);

  const loadRanking = useCallback(async () => {
    setRankingLoading(true);
    setRankingError(null);
    try {
      const result = await client.account.getGroupMessageRanking.query({ groupCode });
      setRanking(result as RankingItem[]);
    } catch (e) {
      setRankingError(e instanceof Error ? e.message : String(e));
    } finally {
      setRankingLoading(false);
    }
  }, [groupCode]);

  const loadActiveHours = useCallback(async () => {
    setActiveHoursLoading(true);
    setActiveHoursError(null);
    try {
      const [hours, daily] = await Promise.all([
        client.account.getGroupActiveHours.query({ groupCode }),
        client.account.getGroupDailyActivity.query({ groupCode }),
      ]);
      setActiveHours(hours as Record<number, number>);
      setDailyActivity(daily as DailyActivityItem[]);
    } catch (e) {
      setActiveHoursError(e instanceof Error ? e.message : String(e));
    } finally {
      setActiveHoursLoading(false);
    }
  }, [groupCode]);

  const loadWordCloud = useCallback(async () => {
    setWordCloudLoading(true);
    setWordCloudError(null);
    try {
      const result = await client.account.getGroupWordCloud.query({ groupCode, limit: 150 });
      setWordCloud(result as WordCloudItem[]);
    } catch (e) {
      setWordCloudError(e instanceof Error ? e.message : String(e));
    } finally {
      setWordCloudLoading(false);
    }
  }, [groupCode]);

  const loadMemberAnalytics = useCallback(
    async (uid: string) => {
      setSelectedMemberUid(uid);
      setMemberAnalyticsLoading(true);
      setMemberAnalyticsError(null);
      setMemberAnalytics(null);
      try {
        const result = await client.account.getGroupMemberAnalytics.query({
          groupCode,
          memberUid: uid,
        });
        setMemberAnalytics(result as MemberAnalyticsData);
      } catch (e) {
        setMemberAnalyticsError(e instanceof Error ? e.message : String(e));
      } finally {
        setMemberAnalyticsLoading(false);
      }
    },
    [groupCode],
  );

  const goTo = useCallback(
    (v: View) => {
      setView(v);
      if (v === "ranking" && ranking.length === 0 && !rankingLoading) void loadRanking();
      if (v === "activeHours" && !activeHours && !activeHoursLoading) void loadActiveHours();
      if (v === "wordcloud" && !wordCloud && !wordCloudLoading) void loadWordCloud();
    },
    [
      ranking,
      rankingLoading,
      activeHours,
      activeHoursLoading,
      wordCloud,
      wordCloudLoading,
      loadRanking,
      loadActiveHours,
      loadWordCloud,
    ],
  );

  const handleBack = useCallback(() => {
    if (view === "memberAnalytics") {
      setView("members");
    } else {
      setView("menu");
      setMemberSearch("");
    }
  }, [view]);

  const filteredMembers = useMemo(() => {
    if (!memberSearch.trim()) return members;
    const kw = memberSearch.trim().toLowerCase();
    return members.filter(
      (m) =>
        (m.card || "").toLowerCase().includes(kw) ||
        (m.nick || "").toLowerCase().includes(kw) ||
        (m.uin || "").includes(kw) ||
        (m.uid || "").toLowerCase().includes(kw),
    );
  }, [members, memberSearch]);

  const title = (() => {
    switch (view) {
      case "members":
        return "群成员";
      case "memberAnalytics":
        return "成员详细分析";
      case "ranking":
        return "群聊发言排行";
      case "activeHours":
        return "群聊活跃时段";
      case "wordcloud":
        return "群词云";
      default:
        return "群聊分析";
    }
  })();

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
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header>
          <div>
            {view !== "menu" && (
              <button
                className="icon-button"
                type="button"
                title="返回"
                onClick={handleBack}
                style={{ marginRight: 8 }}
              >
                <ChevronLeft size={18} />
              </button>
            )}
            <strong>{title}</strong>
            <span>{groupName}</span>
          </div>
          <button className="icon-button" type="button" title="关闭" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <div className="group-album-body ga-body">
          {view === "menu" && (
            <div className="ga-menu-grid">
              <button className="ga-menu-card" type="button" onClick={() => goTo("members")}>
                <span className="ga-menu-icon">
                  <Users size={26} />
                </span>
                <span className="ga-menu-title">群成员</span>
                <small>查看成员资料，点击成员查看发言 / 活跃详细分析</small>
              </button>
              <button className="ga-menu-card" type="button" onClick={() => goTo("ranking")}>
                <span className="ga-menu-icon">
                  <Medal size={26} />
                </span>
                <span className="ga-menu-title">群聊发言排行</span>
                <small>统计成员发言数量排行</small>
              </button>
              <button className="ga-menu-card" type="button" onClick={() => goTo("activeHours")}>
                <span className="ga-menu-icon">
                  <Clock size={26} />
                </span>
                <span className="ga-menu-title">群聊活跃时段</span>
                <small>全天活跃分布 + 每日消息热力图</small>
              </button>
              <button className="ga-menu-card" type="button" onClick={() => goTo("wordcloud")}>
                <span className="ga-menu-icon">
                  <Cloud size={26} />
                </span>
                <span className="ga-menu-title">群词云</span>
                <small>群内高频词词云图</small>
              </button>
            </div>
          )}

          {view === "members" && (
            <div className="ga-members">
              <div className="ga-search-wrap ga-members-search">
                <Search size={14} />
                <input
                  type="text"
                  placeholder="搜索成员昵称 / 群名片 / QQ号"
                  value={memberSearch}
                  onChange={(e) => setMemberSearch(e.target.value)}
                />
              </div>
              {membersLoading ? (
                <div className="ga-loading">
                  <Loader2 size={28} className="weq-spin" />
                </div>
              ) : membersError ? (
                <div className="ga-error">{membersError}</div>
              ) : filteredMembers.length === 0 ? (
                <p className="ga-placeholder">没有匹配的成员</p>
              ) : (
                <div className="ga-members-grid">
                  {filteredMembers.map((m) => (
                    <button
                      key={m.uid}
                      className="ga-member-card"
                      type="button"
                      title={`${memberDisplayName(m)}${m.uin ? ` · ${m.uin}` : ""}`}
                      onClick={() => {
                        setSelectedMemberUid(m.uid);
                        setMemberAnalytics(null);
                        setMemberAnalyticsError(null);
                        setView("memberAnalytics");
                        void loadMemberAnalytics(m.uid);
                      }}
                    >
                      <Avatar name={memberDisplayName(m)} avatarUrl={memberAvatarUrl(m)} />
                      <span className="ga-member-name">{memberDisplayName(m)}</span>
                      {m.memberLevel > 0 && <span className="ga-member-level">LV{m.memberLevel}</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {view === "memberAnalytics" && (
            <div className="ga-member-analytics">
              {/* Selected member chip */}
              {selectedMember ? (
                <div className="ga-selected-member">
                  <Avatar
                    name={memberDisplayName(selectedMember)}
                    avatarUrl={memberAvatarUrl(selectedMember)}
                  />
                  <div>
                    <strong>{memberDisplayName(selectedMember)}</strong>
                    {selectedMember.uin && selectedMember.uin !== "0" ? (
                      <small>QQ: {selectedMember.uin}</small>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {memberAnalyticsLoading ? (
                <div className="ga-loading">
                  <Loader2 size={28} className="weq-spin" />
                </div>
              ) : memberAnalyticsError ? (
                <div className="ga-error">{memberAnalyticsError}</div>
              ) : memberAnalytics ? (
                <div className="ga-analytics-content">
                  {/* Stats cards */}
                  <div className="ga-stats-cards">
                    <div className="ga-stat-card">
                      <MessageSquare size={18} />
                      <div>
                        <strong>{formatNumber(memberAnalytics.statistics.totalMessages)}</strong>
                        <span>发言数量</span>
                      </div>
                    </div>
                    <div className="ga-stat-card">
                      <Clock size={18} />
                      <div>
                        <strong>{memberAnalytics.statistics.activeDays}</strong>
                        <span>活跃天数</span>
                      </div>
                    </div>
                    <div className="ga-stat-card ga-stat-wide">
                      <BarChart3 size={18} />
                      <div>
                        <strong>
                          {formatDate(memberAnalytics.statistics.firstMessageTime)} —{" "}
                          {formatDate(memberAnalytics.statistics.lastMessageTime)}
                        </strong>
                        <span>活跃周期</span>
                      </div>
                    </div>
                  </div>

                  {/* Message type breakdown */}
                  <div className="ga-type-breakdown">
                    {[
                      { label: "文本", count: memberAnalytics.statistics.textMessages, color: "#3b82f6" },
                      { label: "图片", count: memberAnalytics.statistics.imageMessages, color: "#22c55e" },
                      { label: "语音", count: memberAnalytics.statistics.voiceMessages, color: "#f97316" },
                      { label: "视频", count: memberAnalytics.statistics.videoMessages, color: "#a855f7" },
                      { label: "表情", count: memberAnalytics.statistics.emojiMessages, color: "#ec4899" },
                      { label: "其他", count: memberAnalytics.statistics.otherMessages, color: "#6b7280" },
                    ]
                      .filter((x) => x.count > 0)
                      .map((x) => (
                        <div className="ga-type-chip" key={x.label}>
                          <span className="ga-type-dot" style={{ backgroundColor: x.color }} />
                          <span className="ga-type-label">{x.label}</span>
                          <span className="ga-type-count">{x.count}</span>
                        </div>
                      ))}
                  </div>

                  {/* Hourly bar chart */}
                  <div className="ga-section">
                    <h3>活跃时段</h3>
                    <HourlyBarChart data={memberAnalytics.timeDistribution} />
                  </div>

                  {/* Common phrases & emojis */}
                  <div className="ga-section">
                    <div className="ga-phrases-row">
                      <div className="ga-phrases-col">
                        <h3>常用语</h3>
                        {memberAnalytics.commonPhrases.length > 0 ? (
                          <div className="ga-chips">
                            {memberAnalytics.commonPhrases.map((item, idx) => (
                              <span className="ga-chip" key={idx}>
                                <span>{item.phrase}</span>
                                <small>{item.count}</small>
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span className="ga-chip-empty">暂无常用语</span>
                        )}
                      </div>
                      <div className="ga-phrases-col">
                        <h3>常用表情</h3>
                        {memberAnalytics.commonEmojis.length > 0 ? (
                          <div className="ga-chips">
                            {memberAnalytics.commonEmojis.map((item, idx) => (
                              <span className="ga-chip ga-emoji-chip" key={idx} title={item.faceText}>
                                <FaceEmoji
                                  element={{ faceId: item.faceId, faceText: item.faceText }}
                                  size={22}
                                />
                                <small>{item.count}</small>
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span className="ga-chip-empty">暂无表情数据</span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <p className="ga-placeholder">未能加载该成员的分析数据</p>
              )}
            </div>
          )}

          {view === "ranking" && (
            <div className="ga-ranking">
              {rankingLoading ? (
                <div className="ga-loading">
                  <Loader2 size={28} className="weq-spin" />
                </div>
              ) : rankingError ? (
                <div className="ga-error">{rankingError}</div>
              ) : ranking.length === 0 ? (
                <p className="ga-placeholder">暂无发言数据</p>
              ) : (
                <div className="ga-ranking-list">
                  {ranking.map((item, idx) => (
                    <div
                      className={cn(
                        "ga-ranking-item",
                        idx === 0 && "rank-1",
                        idx === 1 && "rank-2",
                        idx === 2 && "rank-3",
                      )}
                      key={item.uid}
                    >
                      <span className={cn("ga-rank-num", idx < 3 && "top")}>
                        {idx < 3 ? <Medal size={14} /> : idx + 1}
                      </span>
                      <Avatar
                        name={item.displayName}
                        avatarUrl={
                          item.uin && item.uin !== "0"
                            ? `https://thirdqq.qlogo.cn/g?b=sdk&nk=${item.uin}&s=0`
                            : null
                        }
                      />
                      <span className="ga-rank-name">{item.displayName}</span>
                      <span className="ga-rank-count">{formatNumber(item.messageCount)} 条</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {view === "activeHours" && (
            <div className="ga-active-hours">
              {activeHoursLoading ? (
                <div className="ga-loading">
                  <Loader2 size={28} className="weq-spin" />
                </div>
              ) : activeHoursError ? (
                <div className="ga-error">{activeHoursError}</div>
              ) : (
                <>
                  <div className="ga-section">
                    <h3>全天活跃分布</h3>
                    {activeHours ? <HourlyBarChart data={activeHours} /> : null}
                  </div>
                  <div className="ga-section">
                    <h3>每日消息热力图</h3>
                    {dailyActivity ? <ContributionHeatmap data={dailyActivity} /> : null}
                  </div>
                </>
              )}
            </div>
          )}

          {view === "wordcloud" && (
            <div className="ga-wordcloud-view">
              {wordCloudLoading ? (
                <div className="ga-loading">
                  <Loader2 size={28} className="weq-spin" />
                </div>
              ) : wordCloudError ? (
                <div className="ga-error">{wordCloudError}</div>
              ) : wordCloud && wordCloud.length > 0 ? (
                <WordCloud words={wordCloud} />
              ) : (
                <p className="ga-placeholder">暂无足够的文本数据生成词云</p>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
