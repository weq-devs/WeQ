/**
 * 入群批次：三小时里挤进来的人够多（≥ max(3, 群总人数 ÷ 20)）就算一批。
 *
 * 这只是「谁跟谁前后脚进来」的时间批次，**不是**人际关系意义上的小团体 ——
 * 真正按聊天会话算的小团体见 {@link ./GroupConversationGraph}。
 *
 * 判定在服务端（GroupInfoService.getGroupJoinBatches，纯函数 + 单测），这里只负责
 * 把它讲清楚：
 *   ① 一条横向的入群时间轴，每批一个色带，一眼看出「哪几波人是一起进来的」；
 *   ② 每批一张卡：谁在里面（头像堆叠）、贡献了多少消息、话痨是谁。
 *
 * 颜色沿用 analyticsCharts 的 ACCENT_SERIES，跟着设置里的主题色走。
 */
import type { CSSProperties } from 'react';
import { CalendarClock, Users } from 'lucide-react';
import { Avatar } from '../im-template/template/primitives';
import { ACCENT_SERIES, formatNumber } from './analyticsCharts';

interface BatchMember {
  uid: string;
  uin: string;
  displayName: string;
  joinTime: number;
  lastSpeakTime: number;
  memberLevel: number;
  messageCount: number;
}

interface JoinBatch {
  index: number;
  startTime: number;
  endTime: number;
  spanSeconds: number;
  members: BatchMember[];
  messageCount: number;
  topSpeaker: BatchMember | null;
}

export interface JoinBatchReport {
  memberTotal: number;
  datedMemberCount: number;
  unknownJoinCount: number;
  threshold: number;
  windowSeconds: number;
  batches: JoinBatch[];
  batchMemberCount: number;
  groupMessageTotal: number;
  firstJoinTime: number;
  lastJoinTime: number;
}

/** 大群能凑出几十批，卡片区最多展开这么多张。 */
const MAX_CARDS = 8;

/** 批次色：时间轴色带与卡片主题色共用同一条，视觉上对得上。 */
const toneOf = (index: number): string =>
  ACCENT_SERIES[(index - 1) % ACCENT_SERIES.length] ?? ACCENT_SERIES[0];

function avatarUrlOf(uin: string | undefined | null): string | null {
  return uin && uin !== '0' ? `https://thirdqq.qlogo.cn/g?b=sdk&nk=${uin}&s=0` : null;
}

/** 时刻 → `03/12 14:05`（跨年时补上年份）。 */
function momentText(ts: number, withYear = false): string {
  if (!ts) return '未知';
  const d = new Date(ts * 1000);
  const md = `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return withYear ? `${d.getFullYear()}/${md} ${hm}` : `${md} ${hm}`;
}

/** 批次的入群区间 → `03/12 14:05 — 15:40`（跨天 / 跨年各有说法）。 */
function rangeText(start: number, end: number): string {
  const a = new Date(start * 1000);
  const b = new Date(end * 1000);
  const sameDay =
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (sameDay) return `${momentText(start)} — ${momentText(end).slice(-5)}`;
  if (a.getFullYear() === b.getFullYear()) {
    return `${momentText(start)} — ${momentText(end)}`;
  }
  return `${momentText(start, true)} — ${momentText(end, true)}`;
}

/** 跨度的人话 —— 批次看的就是「挤」，所以短跨度要说得细（秒 / 分钟 / 小时）。 */
function spanText(spanSeconds: number): string {
  if (spanSeconds <= 0) return '同一时刻';
  if (spanSeconds < 60) return `${spanSeconds} 秒内`;
  if (spanSeconds < 3600) return `${Math.round(spanSeconds / 60)} 分钟内`;
  if (spanSeconds < 86400) return `${Number((spanSeconds / 3600).toFixed(1))} 小时内`;
  return `${Number((spanSeconds / 86400).toFixed(1))} 天内`;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(value >= 0.1 ? 0 : 1)}%`;
}

/**
 * 大群（几千人）时时间轴上的点会糊成一条灰带，均匀抽样到上限为止 ——
 * 按比例抽，不偏向时间轴任何一段。
 */
function sampleEven<T>(list: T[], max: number): T[] {
  if (list.length <= max) return list;
  const step = list.length / max;
  return Array.from({ length: max }, (_, i) => list[Math.floor(i * step)]!).filter(Boolean);
}

/** 头像堆叠行：最多 10 张，多了折成 +N。 */
function FaceRow({ members, tone }: { members: BatchMember[]; tone: string }) {
  const show = members.slice(0, 10);
  return (
    <div className="gc-faces">
      {show.map((m) => (
        <span
          className="gc-face"
          key={m.uid}
          title={`${m.displayName} · ${momentText(m.joinTime)} 入群`}
        >
          <Avatar name={m.displayName} avatarUrl={avatarUrlOf(m.uin)} seed={m.uid} />
        </span>
      ))}
      {members.length > show.length ? (
        <span className="gc-face-more" style={{ borderColor: tone }}>
          +{members.length - show.length}
        </span>
      ) : null}
    </div>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="gc-metric" title={hint}>
      <small>{label}</small>
      <strong>{value}</strong>
    </div>
  );
}

/**
 * 入群时间轴：横轴 = 从最早到最晚的入群时间；每个批次一条色带，带内成员各一个点。
 * 点按 3 行错开摆，同一天一起进来的一大波人不会叠成一个点。
 */
function BatchTimeline({ report }: { report: JoinBatchReport }) {
  const from = report.firstJoinTime;
  const to = report.lastJoinTime;
  const span = Math.max(to - from, 1);
  const posOf = (ts: number) => Math.min(100, Math.max(0, ((ts - from) / span) * 100));

  // 5 个刻度，等分时刻标年月；相邻刻度落在同一个月时只画一个。
  const ticks: Array<{ p: number; label: string }> = [];
  for (let i = 0; i <= 4; i++) {
    const p = (i / 4) * 100;
    const d = new Date((from + (span * i) / 4) * 1000);
    const label = `${d.getFullYear()}/${d.getMonth() + 1}`;
    if (ticks.length === 0 || ticks[ticks.length - 1]!.label !== label) ticks.push({ p, label });
  }

  return (
    <div className="gc-timeline">
      <div className="gc-tl-track">
        {report.batches.map((batch) => {
          const left = posOf(batch.startTime);
          const right = posOf(batch.endTime);
          return (
            <div
              key={`band-${batch.index}`}
              className="gc-tl-band"
              style={{
                left: `${left}%`,
                // 同一时刻进完的批次也要看得见，给一条最小宽度。
                width: `${Math.max(right - left, 1.4)}%`,
                background: toneOf(batch.index),
                opacity: 0.22,
              }}
              title={`${rangeText(batch.startTime, batch.endTime)} · ${batch.members.length} 人`}
            />
          );
        })}
        {report.batches.flatMap((batch) =>
          sampleEven(batch.members, 160).map((member, i) => (
            <span
              key={`dot-${member.uid}-${batch.index}`}
              className="gc-tl-dot"
              style={{
                left: `${posOf(member.joinTime)}%`,
                top: 8 + (i % 3) * 14,
                background: toneOf(batch.index),
              }}
              title={`${member.displayName} · ${momentText(member.joinTime)} 入群`}
            />
          )),
        )}
      </div>
      <div className="gc-tl-axis">
        {ticks.map((tick) => (
          <span
            key={`${tick.label}-${tick.p}`}
            className="gc-tl-tick"
            style={{
              left: `${tick.p}%`,
              transform:
                tick.p < 5 ? 'none' : tick.p > 95 ? 'translateX(-100%)' : 'translateX(-50%)',
            }}
          >
            {tick.label}
          </span>
        ))}
      </div>
    </div>
  );
}

export function GroupJoinBatches({ report }: { report: JoinBatchReport }) {
  const shown = report.batches.slice(0, MAX_CARDS);
  const hidden = report.batches.length - shown.length;
  const bySize = report.memberTotal > 0 ? report.memberTotal : 1;
  const windowHours = Math.max(1, Math.round(report.windowSeconds / 3600));

  return (
    <div className="gc-root">
      {report.datedMemberCount > 0 ? <BatchTimeline report={report} /> : null}

      {report.batches.length === 0 ? (
        <p className="ga-placeholder">
          {report.datedMemberCount === 0
            ? '拿不到成员入群时间，这次分析跳过了。'
            : `${windowHours} 小时内从没挤进过 ${report.threshold} 个人 —— 这个群的人是零散加进来的。`}
        </p>
      ) : (
        <div className="gc-grid">
          {shown.map((batch) => {
            const tone = toneOf(batch.index);
            const perCapita =
              batch.members.length > 0 ? Math.round(batch.messageCount / batch.members.length) : 0;
            const share =
              report.groupMessageTotal > 0 ? batch.messageCount / report.groupMessageTotal : 0;
            return (
              <div
                className="gc-card"
                key={batch.index}
                style={{ '--gc-tone': tone } as CSSProperties}
              >
                <div className="gc-card-head">
                  <span className="gc-card-idx">{batch.index}</span>
                  <div className="gc-card-title">
                    <strong>{rangeText(batch.startTime, batch.endTime)}</strong>
                    <small>
                      {batch.members.length} 人 · {spanText(batch.spanSeconds)}
                    </small>
                  </div>
                  <span className="gc-badge is-normal">
                    <CalendarClock size={11} /> {windowHours}h 批
                  </span>
                </div>

                <FaceRow members={batch.members} tone={tone} />

                <div className="gc-metrics">
                  <Metric
                    label="发言占比"
                    value={pct(share)}
                    hint={`全群共 ${formatNumber(report.groupMessageTotal)} 条消息`}
                  />
                  <Metric label="人均发言" value={`${formatNumber(perCapita)} 条`} />
                  <Metric
                    label="人数占比"
                    value={pct(batch.members.length / bySize)}
                    hint="这批人占全群总人数的比例"
                  />
                </div>
                <div className="gc-sharebar">
                  <i style={{ width: `${Math.min(share * 100, 100)}%`, background: tone }} />
                </div>

                <div className="gc-card-foot">
                  {batch.topSpeaker ? (
                    <span className="gc-top" title="这批人里发言最多的一位">
                      <Avatar
                        name={batch.topSpeaker.displayName}
                        avatarUrl={avatarUrlOf(batch.topSpeaker.uin)}
                        seed={batch.topSpeaker.uid}
                      />
                      <span className="gc-top-name" title={batch.topSpeaker.displayName}>
                        {batch.topSpeaker.displayName}
                      </span>
                      <small>{formatNumber(batch.topSpeaker.messageCount)} 条</small>
                    </span>
                  ) : (
                    <span className="gc-top is-empty">
                      <Users size={12} /> 这批人还没人说过话
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {hidden > 0 ? (
        <p className="ga-placeholder gc-more">
          还有 {hidden} 个批次没列 —— 时间在后面的那些，点开图片或滚动时间轴也能看到。
        </p>
      ) : null}
    </div>
  );
}
