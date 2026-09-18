/**
 * 小团体分析：按「入群时间有多挤」把群成员分成几伙。
 *
 * 口径的重点是**时间短**而不是人多 —— 「1 小时里挤进来 20 个人」比「一天陆续来 200 个人」
 * 像一伙得多。服务端把「接二连三、谁都不冷场超过一定时间」的人串成一波，档位由短到长试
 * （相邻间隔 1 小时 → 6 小时 → 1 天 → 用户选的最长窗口），谁先凑够人就算哪一档；门槛还要
 * 挤进**本群自己**前百分之几（大群 1 小时来 20 人是日常，小群来 3 个人就是奇观），
 * 并且这一波的速度得比全群平均进人速度快一倍以上。
 *
 * 判定放在服务端（GroupInfoService.getGroupJoinClusters），这里只负责把它讲清楚：
 *
 *   ① 时间轴 —— 一条横向的入群时间轴，每个成员一个点，同一伙人一个色带。
 *      一眼就能看出「哪几波人是一起进来的」；
 *   ② 团体卡 —— 每伙一张卡：谁在里面（头像堆叠）、贡献了多少消息、话痨是谁。
 *      大群能凑出几十伙，按「窗口越短越硬」排序，只展开最像的几伙；
 *   ③ 拉新潮 —— 短时间涌入的人多到称不上「小」团体的那些波次，只做汇总；
 *   ④ 游离分子 —— 谁也没跟上的那些人，单独一张灰卡。
 *
 * 颜色沿用 analyticsCharts 的 ACCENT_SERIES，跟着设置里的主题色走。
 */
import { Users } from 'lucide-react';
import { Avatar } from '../im-template/template/primitives';
import { ACCENT_SERIES, formatNumber } from './analyticsCharts';

interface ClusterMember {
  uid: string;
  uin: string;
  displayName: string;
  joinTime: number;
  lastSpeakTime: number;
  memberLevel: number;
  messageCount: number;
}

interface Cluster {
  index: number;
  startTime: number;
  endTime: number;
  spanDays: number;
  members: ClusterMember[];
  messageCount: number;
  messageShare: number;
  topSpeaker: ClusterMember | null;
  avgLevel: number;
  /** 成伙时命中的档位（秒）= 相邻两人的最大间隔上限 —— 越小越硬。 */
  windowSeconds: number;
}

interface Wave {
  startTime: number;
  endTime: number;
  spanDays: number;
  memberCount: number;
  messageShare: number;
}

export interface JoinClusterReport {
  totalMembers: number;
  unknownJoinCount: number;
  minClusterSize: number;
  allInOneWave: boolean;
  clusters: Cluster[];
  waves: Wave[];
  waveMemberCount: number;
  drifters: ClusterMember[];
  driftMessageShare: number;
  groupMessageTotal: number;
  firstJoinTime: number;
  lastJoinTime: number;
  meanGapSeconds: number;
  tierNeeds: Array<{ windowSeconds: number; minCount: number }>;
  criteria: {
    windowDays: number;
    minSize: number;
    maxSize: number;
    densityFactor: number;
    rarityRatio: number;
  };
}

/** 大群能凑出几十伙，卡片区最多展开这么多张，其余只报个数。 */
const MAX_CARDS = 8;

/** 团体卡的色：时间轴色带与卡片主题色共用同一条，视觉上对得上。 */
const toneOf = (index: number): string => ACCENT_SERIES[(index - 1) % ACCENT_SERIES.length];

const DRIFT_TONE = 'color-mix(in srgb, var(--weq-fg-primary) 34%, transparent)';

function avatarUrlOf(uin: string | undefined | null): string | null {
  return uin && uin !== '0' ? `https://thirdqq.qlogo.cn/g?b=sdk&nk=${uin}&s=0` : null;
}

/** 入群时刻 → `2024/03/12`。 */
function dayText(ts: number): string {
  if (!ts) return '未知';
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
}

/** 入群区间 → `2024/03/12 — 03/15`（跨年 / 单日各有说法）。 */
function rangeText(start: number, end: number): string {
  const a = new Date(start * 1000);
  const b = new Date(end * 1000);
  const head = dayText(start);
  if (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  ) {
    return head;
  }
  if (a.getFullYear() === b.getFullYear()) {
    return `${head} — ${String(b.getMonth() + 1).padStart(2, '0')}/${String(b.getDate()).padStart(2, '0')}`;
  }
  return `${head} — ${dayText(end)}`;
}

/** 档位的人话：档位 = 同一伙人里相邻两位入群的间隔上限。 */
function tierName(windowSeconds: number): string {
  if (windowSeconds <= 3600) return '1 小时';
  if (windowSeconds <= 21600) return '6 小时';
  if (windowSeconds <= 86400) return '1 天';
  return `${Math.max(1, Math.round(windowSeconds / 86400))} 天`;
}

/**
 * 一伙人的「气质」：命中的档位越短越硬（这才是小团体的典型形态），
 * 全团没说过话的叫潜水团。
 */
function vibeOf(cluster: Cluster): { text: string; kind: 'hot' | 'cold' | 'normal' } {
  if (cluster.messageCount === 0) return { text: '潜水团', kind: 'cold' };
  if (cluster.windowSeconds <= 3600) return { text: '闪电成团', kind: 'hot' };
  if (cluster.windowSeconds <= 21600) return { text: '半天成团', kind: 'hot' };
  if (cluster.windowSeconds <= 86400) return { text: '同天成团', kind: 'hot' };
  if (cluster.messageShare >= 0.35) return { text: '顶梁柱', kind: 'hot' };
  return { text: '慢慢聚起', kind: 'normal' };
}

/** 入群跨度的人话 —— 小团体看的就是「挤」，所以短跨度要说得细（秒 / 分钟 / 小时）。 */
function spanText(cluster: Cluster): string {
  const sec = Math.round(cluster.spanDays * 86400);
  if (sec <= 0) return '同一时刻';
  if (sec <= 60) return `${sec} 秒内`;
  if (sec < 3600) return `${Math.round(sec / 60)} 分钟内`;
  if (sec < 86400) return `${Math.round(sec / 3600)} 小时内`;
  return `${Number((sec / 86400).toFixed(1))} 天内`;
}

/**
 * 「像不像一伙」的排序：档位越短越硬 → 人越多越像 → 跨度越短越挤。
 * 大群里几十个 3 人小簇全列出来没人看，把最硬的几伙顶前面。
 */
function conviction(a: Cluster, b: Cluster): number {
  if (a.windowSeconds !== b.windowSeconds) return a.windowSeconds - b.windowSeconds;
  if (a.members.length !== b.members.length) return b.members.length - a.members.length;
  return a.spanDays - b.spanDays;
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
function FaceRow({ members, tone }: { members: ClusterMember[]; tone: string }) {
  const show = members.slice(0, 10);
  return (
    <div className="gc-faces">
      {show.map((m) => (
        <span
          className="gc-face"
          key={m.uid}
          title={`${m.displayName} · ${dayText(m.joinTime)} 入群`}
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
 * 入群时间轴：横轴 = 从最早到最晚的入群时间；每个成员一个点，同一伙一个色带。
 * 点按 3 行错开摆，同一天一起进来的一大波人不会叠成一个点。
 */
function JoinTimeline({ report }: { report: JoinClusterReport }) {
  const from = report.firstJoinTime;
  const to = report.lastJoinTime;
  const span = Math.max(to - from, 1);
  const posOf = (ts: number) => Math.min(100, Math.max(0, ((ts - from) / span) * 100));

  // 5 个刻度，落在整月/整年上太麻烦，直接取等分时刻标年月；
  // 相邻刻度落在同一个月时只画一个（否则会挤成一片）。
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
        {report.clusters.map((cluster) => {
          const left = posOf(cluster.startTime);
          const right = posOf(cluster.endTime);
          return (
            <div
              key={`band-${cluster.index}`}
              className="gc-tl-band"
              style={{
                left: `${left}%`,
                // 一天内进完的团也要看得见，给一条最小宽度。
                width: `${Math.max(right - left, 1.4)}%`,
                background: toneOf(cluster.index),
                opacity: 0.22,
              }}
              title={`${rangeText(cluster.startTime, cluster.endTime)} · ${cluster.members.length} 人`}
            />
          );
        })}
        {report.clusters.flatMap((cluster) =>
          sampleEven(cluster.members, 160).map((member, i) => (
            <span
              key={`dot-${member.uid}-${cluster.index}`}
              className="gc-tl-dot"
              style={{
                left: `${posOf(member.joinTime)}%`,
                top: 8 + (i % 3) * 14,
                background: toneOf(cluster.index),
              }}
              title={`${member.displayName} · ${dayText(member.joinTime)} 入群`}
            />
          )),
        )}
        {sampleEven(report.drifters, 200).map((member, i) => (
          <span
            key={`drift-${member.uid}`}
            className="gc-tl-dot is-drift"
            style={{ left: `${posOf(member.joinTime)}%`, top: 12 + (i % 2) * 18 }}
            title={`${member.displayName} · ${dayText(member.joinTime)} 入群（游离）`}
          />
        ))}
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
      <div className="gc-tl-legend">
        <span>
          <i className="gc-legend-dot" style={{ background: 'var(--weq-accent-effective)' }} />
          团体成员
        </span>
        <span>
          <i className="gc-legend-dot is-drift" />
          游离分子
        </span>
      </div>
    </div>
  );
}

/** 口径说明里的门槛梯子：只列「还有人能达标」的档位（门槛越过人数上限的档其实就是死档）。 */
function tierLadder(report: JoinClusterReport): string {
  const usable = report.tierNeeds.filter((t) => t.minCount <= report.criteria.maxSize);
  if (usable.length === 0) return `本群门槛约 ${report.minClusterSize} 人`;
  return `本群门槛：${usable.map((t) => `${tierName(t.windowSeconds)}内 ≥ ${t.minCount} 人`).join(' · ')}`;
}

export function GroupJoinClusters({ report }: { report: JoinClusterReport }) {
  const ranked = [...report.clusters].sort(conviction);
  const shown = ranked.slice(0, MAX_CARDS);
  const hidden = ranked.length - shown.length;
  const bySize = report.totalMembers > 0 ? report.totalMembers : 1;
  const drifters = report.drifters;
  const biggestWave = report.waves.reduce<Wave | null>(
    (best, w) => (!best || w.memberCount > best.memberCount ? w : best),
    null,
  );

  return (
    <div className="gc-root">
      <p className="gc-note">
        {report.allInOneWave ? (
          <>
            这个群其实就是<strong>一伙人</strong> —— {report.totalMembers} 位成员的入群时间全都挤在{' '}
            {report.criteria.windowDays} 天以内。
          </>
        ) : (
          <>
            看<strong>入群时间</strong>找一波人：把<strong>接二连三、谁都不冷场超过一定时间</strong>
            的人串成一波，档位由短到长试（相邻间隔 1 小时 → 6 小时 → 1 天 →{' '}
            {report.criteria.windowDays} 天），谁先凑够人就算哪一档 ——{' '}
            <strong>时间短比人多有说服力</strong>。人数保底 {report.criteria.minSize} 人、上限{' '}
            {report.criteria.maxSize} 人（再多就归拉新潮了）；还得挤进本群自己的前{' '}
            {Math.round(report.criteria.rarityRatio * 100)}%（{tierLadder(report)}），
            且这一波的速度要达到全群平均进人速度的 {report.criteria.densityFactor} 倍 ——
            匀速进人的群不算一伙。
          </>
        )}
        <span className="gc-note-sub">
          共 {report.totalMembers} 人有入群记录
          {report.unknownJoinCount > 0 ? `（另有 ${report.unknownJoinCount} 人入群时间未知）` : ''}
        </span>
      </p>

      {report.totalMembers > 0 ? <JoinTimeline report={report} /> : null}

      {report.waves.length > 0 ? (
        <p className="gc-wave-note">
          另外捡出 <strong>{report.waves.length}</strong> 波「拉新潮」：共 {report.waveMemberCount}{' '}
          人
          {biggestWave
            ? `，最大一波 ${biggestWave.memberCount} 人（${rangeText(biggestWave.startTime, biggestWave.endTime)}）`
            : ''}
          —— 短时间涌进的人太多，只能算潮汐，不算「小团体」。
        </p>
      ) : null}

      {ranked.length === 0 ? (
        <p className="ga-placeholder">
          {report.totalMembers === 0
            ? '拿不到成员入群时间，这次分析跳过了。'
            : report.waves.length > 0
              ? '这个群没有明显的紧密小团体 —— 进人要么零散，要么就是成批涌进来的（见上面的拉新潮）。'
              : '这个群没有明显的小团体 —— 大家是一个个零散加进来的。'}
        </p>
      ) : (
        <div className="gc-grid">
          {shown.map((cluster) => {
            const tone = toneOf(cluster.index);
            const vibe = vibeOf(cluster);
            const perCapita =
              cluster.members.length > 0
                ? Math.round(cluster.messageCount / cluster.members.length)
                : 0;
            return (
              <div className="gc-card" key={cluster.index} style={{ '--gc-tone': tone }}>
                <div className="gc-card-head">
                  <span className="gc-card-idx">{cluster.index}</span>
                  <div className="gc-card-title">
                    <strong>{rangeText(cluster.startTime, cluster.endTime)}</strong>
                    <small>
                      集中入群 {cluster.members.length} 人 · {spanText(cluster)} · 每位间隔 ≤{' '}
                      {tierName(cluster.windowSeconds)}
                    </small>
                  </div>
                  <span className={`gc-badge is-${vibe.kind}`}>{vibe.text}</span>
                </div>

                <FaceRow members={cluster.members} tone={tone} />

                <div className="gc-metrics">
                  <Metric
                    label="发言占比"
                    value={pct(cluster.messageShare)}
                    hint={`全群共 ${formatNumber(report.groupMessageTotal)} 条消息`}
                  />
                  <Metric label="人均发言" value={`${formatNumber(perCapita)} 条`} />
                  <Metric
                    label="人数占比"
                    value={pct(cluster.members.length / bySize)}
                    hint="这伙人占全群有入群记录成员的比例"
                  />
                </div>
                <div className="gc-sharebar">
                  <i
                    style={{
                      width: `${Math.min(cluster.messageShare * 100, 100)}%`,
                      background: tone,
                    }}
                  />
                </div>

                <div className="gc-card-foot">
                  {cluster.topSpeaker ? (
                    <span className="gc-top" title="这伙人里发言最多的一位">
                      <Avatar
                        name={cluster.topSpeaker.displayName}
                        avatarUrl={avatarUrlOf(cluster.topSpeaker.uin)}
                        seed={cluster.topSpeaker.uid}
                      />
                      <span className="gc-top-name" title={cluster.topSpeaker.displayName}>
                        {cluster.topSpeaker.displayName}
                      </span>
                      <small>{formatNumber(cluster.topSpeaker.messageCount)} 条</small>
                    </span>
                  ) : (
                    <span className="gc-top is-empty">全团潜水，没人说过话</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {hidden > 0 ? (
        <p className="ga-placeholder gc-more">
          还有 {hidden} 伙没列 —— 窗口更长或人更少，说服力排在这 {shown.length} 伙后面。
        </p>
      ) : null}

      {drifters.length > 0 ? (
        <div className="gc-card is-drift" style={{ '--gc-tone': DRIFT_TONE }}>
          <div className="gc-card-head">
            <span className="gc-card-idx is-drift">
              <Users size={14} />
            </span>
            <div className="gc-card-title">
              <strong>游离分子</strong>
              <small>时间轴上谁也不挨着的 {drifters.length} 人</small>
            </div>
            <span className="gc-badge is-normal">散装</span>
          </div>

          <FaceRow members={drifters} tone="var(--weq-fg-muted)" />

          <div className="gc-metrics">
            <Metric
              label="发言占比"
              value={pct(report.driftMessageShare)}
              hint={`全群共 ${formatNumber(report.groupMessageTotal)} 条消息`}
            />
            <Metric
              label="人均发言"
              value={`${formatNumber(
                drifters.length > 0
                  ? Math.round(
                      drifters.reduce((sum, m) => sum + m.messageCount, 0) / drifters.length,
                    )
                  : 0,
              )} 条`}
            />
            <Metric label="人数占比" value={pct(drifters.length / bySize)} />
          </div>
          <div className="gc-sharebar">
            <i
              style={{
                width: `${Math.min(report.driftMessageShare * 100, 100)}%`,
                background: 'var(--weq-fg-muted)',
              }}
            />
          </div>
          <div className="gc-card-foot">
            <span className="gc-top is-empty">
              {drifters
                .slice(0, 8)
                .map((m) => m.displayName)
                .join(' · ')}
              {drifters.length > 8 ? ` 等 ${drifters.length} 人` : ''}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
