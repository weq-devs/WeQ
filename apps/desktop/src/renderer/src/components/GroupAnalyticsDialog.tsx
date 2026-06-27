// @ts-nocheck
import {
  BarChart3,
  ChevronLeft,
  Clock,
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
  commonEmojis: Array<{ emoji: string; count: number }>;
}

type View = "menu" | "members" | "memberAnalytics" | "ranking" | "activeHours";

function formatNumber(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatDate(ts: number | null): string {
  if (!ts) return "-";
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

function memberDisplayName(m: MemberWire): string {
  return m.card || m.nick || m.uin || m.uid || "?";
}

function memberAvatarUrl(m: MemberWire): string | null {
  if (m.uin && m.uin !== "0") {
    return `https://thirdqq.qlogo.cn/g?b=sdk&nk=${m.uin}&s=0`;
  }
  return null;
}

function HourlyBarChart({
  data,
  color = "#07c160",
}: {
  data: Record<number, number>;
  color?: string;
}) {
  const max = Math.max(...Object.values(data), 1);
  return (
    <div className="ga-bar-chart">
      {Array.from({ length: 24 }, (_, hour) => {
        const value = data[hour] ?? 0;
        const heightPct = max > 0 ? (value / max) * 100 : 0;
        return (
          <div className="ga-bar-col" key={hour}>
            <div className="ga-bar-value-label">
              {value > 0 ? formatNumber(value) : ""}
            </div>
            <div className="ga-bar-track">
              <div
                className="ga-bar-fill"
                style={{
                  height: `${Math.max(heightPct, value > 0 ? 2 : 0)}%`,
                  backgroundColor: color,
                }}
              />
            </div>
            <div className="ga-bar-hour-label">{hour}时</div>
          </div>
        );
      })}
    </div>
  );
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
  const [activeHoursLoading, setActiveHoursLoading] = useState(false);
  const [activeHoursError, setActiveHoursError] = useState<string | null>(null);

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
      const result = await client.account.listGroupMembers.query({
        groupCode,
        limit: 300,
      });
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
      const result = await client.account.getGroupActiveHours.query({ groupCode });
      setActiveHours(result as Record<number, number>);
    } catch (e) {
      setActiveHoursError(e instanceof Error ? e.message : String(e));
    } finally {
      setActiveHoursLoading(false);
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
    },
    [view, ranking, rankingLoading, activeHours, activeHoursLoading, loadRanking, loadActiveHours],
  );

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
        return "群成员查看";
      case "memberAnalytics":
        return "群成员详细分析";
      case "ranking":
        return "群聊发言排行";
      case "activeHours":
        return "群聊活跃时段";
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
                onClick={() => {
                  setView("menu");
                  setMemberSearch("");
                }}
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
                <Users size={28} />
                <span>群成员查看</span>
                <small>查看群成员列表和基础资料</small>
              </button>
              <button
                className="ga-menu-card"
                type="button"
                onClick={() => goTo("memberAnalytics")}
              >
                <BarChart3 size={28} />
                <span>群成员详细分析</span>
                <small>分析某个成员的发言数量、活跃周期、常用语</small>
              </button>
              <button className="ga-menu-card" type="button" onClick={() => goTo("ranking")}>
                <Medal size={28} />
                <span>群聊发言排行</span>
                <small>统计成员发言数量排行</small>
              </button>
              <button className="ga-menu-card" type="button" onClick={() => goTo("activeHours")}>
                <Clock size={28} />
                <span>群聊活跃时段</span>
                <small>查看全天活跃时间分布</small>
              </button>
            </div>
          )}

          {view === "members" && (
            <div className="ga-members">
              {membersLoading ? (
                <div className="ga-loading">
                  <Loader2 size={28} className="weq-spin" />
                </div>
              ) : membersError ? (
                <div className="ga-error">{membersError}</div>
              ) : (
                <div className="ga-members-grid">
                  {members.map((m) => (
                    <button
                      key={m.uid}
                      className="ga-member-card"
                      type="button"
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
                      {m.uin && m.uin !== "0" ? (
                        <span className="ga-member-uin">{m.uin}</span>
                      ) : null}
                      {m.memberLevel > 0 && (
                        <span className="ga-member-level">LV{m.memberLevel}</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {view === "memberAnalytics" && (
            <div className="ga-member-analytics">
              {/* Member selector */}
              <div className="ga-member-select-row">
                <div className="ga-search-wrap">
                  <Search size={14} />
                  <input
                    type="text"
                    placeholder="搜索成员昵称 / QQ号"
                    value={memberSearch}
                    onChange={(e) => setMemberSearch(e.target.value)}
                  />
                </div>
              </div>

              {/* Selected member chip */}
              {selectedMember ? (
                <div className="ga-selected-member">
                  <Avatar name={memberDisplayName(selectedMember)} avatarUrl={memberAvatarUrl(selectedMember)} />
                  <div>
                    <strong>{memberDisplayName(selectedMember)}</strong>
                    {selectedMember.uin && selectedMember.uin !== "0" ? (
                      <small>QQ: {selectedMember.uin}</small>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {/* Member search list */}
              {memberSearch.trim() ? (
                <div className="ga-member-search-list">
                  {filteredMembers.slice(0, 30).map((m) => (
                    <button
                      key={m.uid}
                      className={cn(
                        "ga-member-search-item",
                        selectedMemberUid === m.uid && "active",
                      )}
                      type="button"
                      onClick={() => {
                        setMemberSearch("");
                        void loadMemberAnalytics(m.uid);
                      }}
                    >
                      <Avatar name={memberDisplayName(m)} avatarUrl={memberAvatarUrl(m)} />
                      <span>{memberDisplayName(m)}</span>
                      {m.uin ? <small>QQ: {m.uin}</small> : null}
                    </button>
                  ))}
                </div>
              ) : null}

              {!selectedMember ? (
                <p className="ga-placeholder">请搜索并选择一名成员进行分析</p>
              ) : memberAnalyticsLoading ? (
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
                      <MessageSquare size={20} />
                      <div>
                        <strong>{formatNumber(memberAnalytics.statistics.totalMessages)}</strong>
                        <span>发言数量</span>
                      </div>
                    </div>
                    <div className="ga-stat-card">
                      <Clock size={20} />
                      <div>
                        <strong>{memberAnalytics.statistics.activeDays}</strong>
                        <span>活跃天数</span>
                      </div>
                    </div>
                    <div className="ga-stat-card ga-stat-wide">
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
                          <span
                            className="ga-type-dot"
                            style={{ backgroundColor: x.color }}
                          />
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
                                <small>{item.count}次</small>
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
                              <span className="ga-chip" key={idx}>
                                <span>{item.emoji}</span>
                                <small>{item.count}次</small>
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
                <p className="ga-placeholder">点击上方搜索列表中的成员开始分析</p>
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
                      <span
                        className={cn("ga-rank-num", idx < 3 && "top")}
                      >
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
                      <span className="ga-rank-count">
                        {formatNumber(item.messageCount)} 条
                      </span>
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
              ) : activeHours ? (
                <HourlyBarChart data={activeHours} />
              ) : null}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
