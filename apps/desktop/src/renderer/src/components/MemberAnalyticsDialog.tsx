// @ts-nocheck
/**
 * 群成员的聊天分析灯箱。
 *
 * 从资料卡（{@link ./MemberProfileCard}）底部的「聊天分析」按钮打开 —— 只针对
 * 「这个人在**这个群**里」的发言，因此必须同时拿到 groupCode 与 uid。
 *
 * 数据一路来自 `account.getGroupMemberAnalytics`（服务端扫一遍该成员的消息），
 * 进来就拉、拿不到就报错，不做缓存。
 *
 * 层级：资料卡本身是一个 inline `z-index: 90` 的光标浮层，这个灯箱从卡片里打开，
 * 复用 `.weq-profile-layer` 并抬到 `.weq-mutual-layer` 的同一个 100 层，才能盖在卡片上。
 */
import {
  CalendarDays,
  Clock,
  Flame,
  ImageDown,
  Loader2,
  MessageSquare,
  Smile,
  Type as TypeIcon,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { client } from '../trpc/client';
import { Avatar } from '../im-template/template/primitives';
import { useEscapeToClose } from '../im-template/template/modalUtils';
import { FaceEmoji } from './FaceEmoji';
import { useToast } from './Toast';
import { exportAnalyticsCard } from './analyticsShot';
import { HourlyBarChart, formatDate, formatNumber } from './analyticsCharts';

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

/** 消息类型配色（与 weq_assistant 的统计页保持一致）。 */
const TYPE_META: Array<{ key: string; label: string; color: string }> = [
  { key: 'text', label: '文本', color: '#3b82f6' },
  { key: 'image', label: '图片', color: '#22c55e' },
  { key: 'voice', label: '语音', color: '#f97316' },
  { key: 'video', label: '视频', color: '#a855f7' },
  { key: 'emoji', label: '表情', color: '#ec4899' },
  { key: 'other', label: '其他', color: '#6b7280' },
];

function typeCount(data: MemberAnalyticsData, key: string): number {
  const s = data.statistics;
  switch (key) {
    case 'text':
      return s.textMessages;
    case 'image':
      return s.imageMessages;
    case 'voice':
      return s.voiceMessages;
    case 'video':
      return s.videoMessages;
    case 'emoji':
      return s.emojiMessages;
    default:
      return s.otherMessages;
  }
}

export function MemberAnalyticsDialog({
  groupCode,
  groupName,
  member,
  onClose,
}: {
  groupCode: string;
  groupName: string;
  member: { uid: string; name: string; uin?: string | null; avatarUrl?: string | null };
  onClose: () => void;
}) {
  useEscapeToClose(onClose);

  const rootRef = useRef<HTMLElement | null>(null);
  const [exporting, setExporting] = useState(false);
  const [data, setData] = useState<MemberAnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await client.account.getGroupMemberAnalytics.query({
        groupCode,
        memberUid: member.uid,
      });
      setData(result as MemberAnalyticsData);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [groupCode, member.uid]);

  useEffect(() => {
    void load();
  }, [load]);

  // 长图导出：抓真实窗口逐屏拼接，见 ./analyticsShot。
  const handleExport = useCallback(async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const result = await exportAnalyticsCard({
        root: rootRef.current,
        title: `${member.name}_${groupName}`,
        label: '成员分析',
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
  }, [exporting, member.name, groupName]);

  const stats = data?.statistics;
  const typeTotal = data ? TYPE_META.reduce((sum, t) => sum + typeCount(data, t.key), 0) : 0;

  return createPortal(
    <div
      className="weq-profile-layer weq-mutual-layer"
      role="presentation"
      // portal 挂在 body 上，但 React 事件仍沿组件树冒泡 —— 不拦就会连带关掉下面的资料卡。
      onMouseDown={(event) => {
        event.stopPropagation();
        onClose();
      }}
    >
      <section
        className="group-album-dialog ma-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`${member.name} 在 ${groupName} 的聊天分析`}
        ref={rootRef}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <strong>聊天分析</strong>
            <span>
              {member.name} · {groupName}
            </span>
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

        <div className="group-album-body ma-body">
          {loading ? (
            <div className="ga-loading">
              <Loader2 size={28} className="weq-spin" />
            </div>
          ) : error ? (
            <div className="ga-error">{error}</div>
          ) : !data || !stats ? (
            <p className="ga-placeholder">未能加载该成员的分析数据</p>
          ) : (
            <>
              <div className="ba-hero">
                <Avatar name={member.name} avatarUrl={member.avatarUrl ?? null} />
                <div className="ba-hero-info">
                  <strong>{member.name}</strong>
                  <span>
                    {formatDate(stats.firstMessageTime)} — {formatDate(stats.lastMessageTime)}
                  </span>
                  {member.uin && member.uin !== '0' ? <span>QQ {member.uin}</span> : null}
                </div>
              </div>

              <div className="ba-stat-grid">
                <div className="ba-stat">
                  <MessageSquare size={16} />
                  <strong>{formatNumber(stats.totalMessages)}</strong>
                  <small>发言数量</small>
                </div>
                <div className="ba-stat">
                  <CalendarDays size={16} />
                  <strong>{stats.activeDays}</strong>
                  <small>活跃天数</small>
                </div>
                <div className="ba-stat">
                  <TypeIcon size={16} />
                  <strong>{formatNumber(stats.textMessages)}</strong>
                  <small>文本消息</small>
                </div>
                <div className="ba-stat ba-stat-flame">
                  <Flame size={16} />
                  <strong>
                    {stats.activeDays > 0
                      ? formatNumber(Math.round(stats.totalMessages / stats.activeDays))
                      : 0}
                  </strong>
                  <small>日均发言</small>
                </div>
              </div>

              <section className="ba-section">
                <h3>
                  <TypeIcon size={15} /> 消息类型
                </h3>
                {typeTotal > 0 ? (
                  <div className="ga-type-breakdown">
                    {TYPE_META.filter((t) => typeCount(data, t.key) > 0).map((t) => (
                      <div className="ga-type-chip" key={t.key}>
                        <span className="ga-type-dot" style={{ backgroundColor: t.color }} />
                        <span className="ga-type-label">{t.label}</span>
                        <span className="ga-type-count">{typeCount(data, t.key)}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <span className="ga-chip-empty">暂无数据</span>
                )}
              </section>

              <section className="ba-section">
                <h3>
                  <Clock size={15} /> 活跃时段
                </h3>
                <div className="ga-ov-card">
                  <HourlyBarChart data={data.timeDistribution} />
                </div>
              </section>

              <section className="ba-section">
                <h3>
                  <MessageSquare size={15} /> 常用语
                </h3>
                {data.commonPhrases.length > 0 ? (
                  <div className="ga-chips">
                    {data.commonPhrases.map((item) => (
                      <span className="ga-chip" key={item.phrase}>
                        <span>{item.phrase}</span>
                        <small>{item.count}</small>
                      </span>
                    ))}
                  </div>
                ) : (
                  <span className="ga-chip-empty">暂无常用语</span>
                )}
              </section>

              <section className="ba-section">
                <h3>
                  <Smile size={15} /> 常用表情
                </h3>
                {data.commonEmojis.length > 0 ? (
                  <div className="ga-chips">
                    {data.commonEmojis.map((item) => (
                      <span
                        className="ga-chip ga-emoji-chip"
                        key={item.faceId}
                        title={item.faceText}
                      >
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
              </section>
            </>
          )}
        </div>
      </section>
    </div>,
    document.body,
  );
}
