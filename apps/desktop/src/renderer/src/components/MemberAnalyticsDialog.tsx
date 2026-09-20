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
 *
 * 首屏加载时显示 skeleton + shimmer（见 {@link ./AnalyticsSkeleton}）。
 *
 * 「保存为图片」不在这张弹窗上动手：数据交给主进程，由它在一个**从不显示的窗口**里
 * 用同一个组件把卡片重新渲染（840px 长图口径）并拍下来 —— 屏幕上全程零变化。
 * 导出窗口里靠 `exportMode` + `initialData` 复用这里（见 ./export/main.tsx）。
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
import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { client } from '../trpc/client';
import { Avatar } from '../im-template/template/primitives';
import { useEscapeToClose } from '../im-template/template/modalUtils';
import { FaceEmoji } from './FaceEmoji';
import { AnalyticsSkeleton } from './AnalyticsSkeleton';
import { useAnalyticsExport } from './useAnalyticsExport';
import { HourlyBarChart, formatDate, formatNumber } from './analyticsCharts';

/** 导出图片的默认文件名前缀。 */
const EXPORT_LABEL = '成员分析';

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
  exportMode = false,
  initialData,
}: {
  groupCode: string;
  groupName: string;
  member: { uid: string; name: string; uin?: string | null; avatarUrl?: string | null };
  onClose: () => void;
  /** 导出窗口里的渲染口径：不画遮罩、不带头部按钮，宽度按长图铺开。 */
  exportMode?: boolean;
  /** 导出时由可见窗口递过来的数据，避免同一份分析再扫一遍。 */
  initialData?: unknown;
}) {
  useEscapeToClose(onClose);

  const [data, setData] = useState<MemberAnalyticsData | null>(
    (initialData as MemberAnalyticsData) ?? null,
  );
  const [loading, setLoading] = useState(!initialData);
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

  // 导出窗口里的数据是外面递进来的：已有初始数据就别再扫一遍。
  const seeded = Boolean(initialData);
  useEffect(() => {
    if (seeded) return;
    void load();
  }, [seeded, load]);

  // 「保存为图片」：把数据交给主进程 —— 它在隐藏窗口里渲染 + 抓图 + 弹保存框。
  const { exporting, start: startExport } = useAnalyticsExport({
    enabled: !loading && !error && !!data && !exportMode,
    build: () =>
      data
        ? {
            kind: 'member',
            title: `${member.name}_${groupName}`,
            label: EXPORT_LABEL,
            groupCode,
            groupName,
            member,
            data,
          }
        : null,
  });

  const stats = data?.statistics;
  const typeTotal = data ? TYPE_META.reduce((sum, t) => sum + typeCount(data, t.key), 0) : 0;

  /** 卡片正文：可见弹窗与离屏导出舞台共用同一份 JSX。 */
  const renderSections = () => (
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
              <span className="ga-chip ga-emoji-chip" key={item.faceId} title={item.faceText}>
                <FaceEmoji element={{ faceId: item.faceId, faceText: item.faceText }} size={22} />
                <small>{item.count}</small>
              </span>
            ))}
          </div>
        ) : (
          <span className="ga-chip-empty">暂无表情数据</span>
        )}
      </section>
    </>
  );

  /** 卡片本体：可见弹窗与导出窗口共用（导出窗口里不要头部按钮）。 */
  const card = (
    <section
      className="group-album-dialog ma-dialog"
      role="dialog"
      aria-modal={exportMode ? undefined : 'true'}
      aria-label={`${member.name} 在 ${groupName} 的聊天分析`}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <header>
        <div>
          <strong>聊天分析</strong>
          <span>
            {member.name} · {groupName}
          </span>
        </div>
        {exportMode ? null : (
          <div className="ga-head-actions">
            <button
              className="icon-button"
              type="button"
              title="保存为图片"
              onClick={startExport}
              disabled={exporting || loading || !!error || !data}
            >
              {exporting ? <Loader2 size={18} className="weq-spin" /> : <ImageDown size={18} />}
            </button>
            <button className="icon-button" type="button" title="关闭" onClick={onClose}>
              <X size={18} />
            </button>
          </div>
        )}
      </header>

      <div className="group-album-body ma-body">
        {loading ? (
          <AnalyticsSkeleton variant="member" />
        ) : error ? (
          <div className="ga-error">{error}</div>
        ) : !data || !stats ? (
          <p className="ga-placeholder">未能加载该成员的分析数据</p>
        ) : (
          renderSections()
        )}
      </div>
    </section>
  );

  // 导出窗口里整页就是这张卡片：不需要遮挡层。
  if (exportMode) return card;

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
      {card}
    </div>,
    document.body,
  );
}
