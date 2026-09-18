/**
 * 「小团体」聚类 —— 纯函数，不带任何 IO（IO 在 GroupInfoService.getGroupJoinClusters）。
 *
 * 一句话口径：**接二连三进来的一小撮人。**
 *
 *   ① **串成一波**：按入群时间从左到右走，相邻两人间隔不超过某个档位就串在一起
 *      （档位从 1 小时起步，串不够长就放宽到 6 小时 / 1 天 / 用户选的最长窗口）；
 *      整波跨度还不能超过最长窗口，「今天来两个、下周再来两个」不算一伙。
 *   ② **人别太多也别太少**：至少 `minSize`（默认 3，两个人不叫团体），至多 `maxSize`
 *      （默认 20）—— 毕竟叫「**小**」团体。超过上限的是「拉新潮」，单独收进 `waves`。
 *   ③ **要挤过本群自己的常态**：同一档下，本群历史里「一波多少人」的高分位就是门槛
 *      （默认前 2%）—— 大群 1 小时来 20 人是日常，小群来 3 个人就是奇观，
 *      只有跟本群自己的节奏比才有意义；另外这一波的速度还得达到全群**平均进人速度**的
 *      `densityFactor` 倍（默认 2 倍），否则「每 12 小时匀速来一个」这种流水线也会被
 *      串成一堆假团体（它的局部速度和全群平均速度一模一样）。
 *   ④ 全员都在最长窗口里进来的群本身就是一伙（`allInOneWave`），不再切碎。
 *
 * 剩下的全是游离分子。入群时间为 0 的行不参与成波，只计进 `unknownJoinCount`。
 *
 * 每个档位的门槛都写进 `tierNeeds`，前端据此讲清楚「凭什么算一伙」。
 */

/** 参与聚类的成员（入群时间 + 后来的发言量）。 */
export interface GroupJoinClusterMember {
  uid: string;
  uin: string;
  displayName: string;
  /** 入群时间（unix 秒）。 */
  joinTime: number;
  /** 最后发言时间（unix 秒；0 = 入群后没说过话 / 未知）。 */
  lastSpeakTime: number;
  memberLevel: number;
  /** 全群历史里的发言条数（0 = 潜水）。 */
  messageCount: number;
}

/** 一个「小团体」：接二连三挤进来的、人数也不多的一伙人。 */
export interface GroupJoinCluster {
  /** 按入群先后编号，从 1 开始 —— 时间轴上的顺序，不是按人多人少。 */
  index: number;
  startTime: number;
  endTime: number;
  /** 这伙人入群的跨度（天，原始精度 —— 别四舍五入，1 小时档会被舍成 0）。 */
  spanDays: number;
  members: GroupJoinClusterMember[];
  messageCount: number;
  /** 占全群历史消息的比例（0..1）。 */
  messageShare: number;
  /** 团里发言最多的人（全团潜水时为 null）。 */
  topSpeaker: GroupJoinClusterMember | null;
  /** 团成员平均等级。 */
  avgLevel: number;
  /** 成伙时命中的档位（秒）= 相邻两人的最大间隔上限 —— 1 小时档比 3 天档「更硬」。 */
  windowSeconds: number;
  /** 平均每人多久来一个（秒）；越小说明挤得越紧。 */
  gapSeconds: number;
}

/** 大波次（潮汐）：接二连三涌进来的人多到称不上「小团体」。只做汇总，不列成员。 */
export interface GroupJoinWave {
  startTime: number;
  endTime: number;
  spanDays: number;
  memberCount: number;
  messageCount: number;
  /** 占全群历史消息的比例（0..1）。 */
  messageShare: number;
}

/** 各档位的人数门槛（本群自己算出来的）。 */
export interface GroupJoinTierNeed {
  /** 档位（秒）：相邻两人的间隔上限。 */
  windowSeconds: number;
  /** 这一档至少要凑够多少人。 */
  minCount: number;
}

/** 小团体分析结果。 */
export interface GroupJoinClusterReport {
  /** 参与成团的成员数（入群时间有效的那部分）。 */
  totalMembers: number;
  /** 入群时间为 0、无法参与成团的成员数。 */
  unknownJoinCount: number;
  /** 实际成团的人数门槛 —— 最短那一档的门槛，前端用它讲口径。 */
  minClusterSize: number;
  /** 全员都在一个窗口内入群 —— 整个群就是一伙（这时不谈「小团体」，它本身就是）。 */
  allInOneWave: boolean;
  clusters: GroupJoinCluster[];
  /** 大波次：短时间内涌入太多人，算不上「小团体」的那些波次（按时间先后）。 */
  waves: GroupJoinWave[];
  /** 落在大波次里、既不算小团体也不算游离的人数。 */
  waveMemberCount: number;
  /** 游离分子：谁也没跟上的那些人，按入群时间排序。 */
  drifters: GroupJoinClusterMember[];
  /** 游离分子合起来的消息占比（0..1）。 */
  driftMessageShare: number;
  /** 全群历史消息总数（按发送者聚合而来，用于算占比）。 */
  groupMessageTotal: number;
  firstJoinTime: number;
  lastJoinTime: number;
  /** 全群平均「多久来一个人」（秒）= 总跨度 ÷ (人数 - 1) —— 速度门槛的分母。 */
  meanGapSeconds: number;
  /** 各档窗口的实际人数门槛（由本群自己的挤度分布算出），由短到长。 */
  tierNeeds: GroupJoinTierNeed[];
  /** 成团口径，回传给前端做解释。 */
  criteria: {
    windowDays: number;
    minSize: number;
    maxSize: number;
    densityFactor: number;
    rarityRatio: number;
  };
}

export interface JoinClusterCriteria {
  /** 最长窗口（天）：整波的跨度上限，也是档位梯子的顶端。 */
  windowDays: number;
  /** 成伙的人数下限。 */
  minSize: number;
  /** 成伙的人数上限 —— 超过就不是「小」团体了，归入大波次。 */
  maxSize: number;
  /** 速度倍数：这一波的入群速度要达到平时步伐的这么多倍。 */
  densityFactor: number;
  /** 稀有度：一波的人数要排进本群自己的前这个比例（0.02 = 前 2%）。 */
  rarityRatio: number;
}

/**
 * 默认口径：最长 3 天 / 3~20 人 / 人数进本群前 2% / 速度达平时步伐的 2 倍。
 *
 * 最短档 1 小时是「一波人一起进群」的典型尺度（朋友互拉、被同一张邀请拉进来）；
 * 3 天是留给人慢慢拉人的余量（今天拉两个、后天再拉一个）。
 */
export const DEFAULT_JOIN_CLUSTER_CRITERIA: JoinClusterCriteria = {
  windowDays: 3,
  minSize: 3,
  maxSize: 20,
  densityFactor: 2,
  rarityRatio: 0.02,
};

/** 分位数不能压到比中位数还低（样本极少时兜底）。 */
const QUANTILE_MIN_RATIO = 0.5;

/** 稀有度判定的最小样本数：样本太少时分位数没有意义，直接退回人数下限。 */
const MIN_QUANTILE_SAMPLES = 3;

const DAY_SECONDS = 86400;
const HOUR_SECONDS = 3600;

/**
 * 候选档位（秒），由短到长：1 小时 → 6 小时 → 1 天 → 用户选的最长窗口。
 * 越短的档位越「硬」：同样凑够人，1 小时档判出来的团体比 3 天档可信。
 */
function tierSeconds(criteria: JoinClusterCriteria): number[] {
  const maxSec = Math.max(criteria.windowDays * DAY_SECONDS, HOUR_SECONDS);
  const tiers = [HOUR_SECONDS, 6 * HOUR_SECONDS, DAY_SECONDS].filter((s) => s < maxSec);
  tiers.push(maxSec);
  return [...new Set(tiers)].sort((a, b) => a - b);
}

/**
 * 从 `start` 开始「不冷场」能串到哪一位（返回末位下标）。
 *
 * 两个条件：相邻两人的间隔 ≤ `tier`，且整段跨度 ≤ `maxSpanSec`。
 * 跨度上限是必要的 —— 否则「每两天来一个」的群会被一路串成一整条长链。
 */
function chainEnd(
  list: readonly GroupJoinClusterMember[],
  start: number,
  tier: number,
  maxSpanSec: number,
): number {
  let end = start;
  while (
    end + 1 < list.length &&
    list[end + 1]!.joinTime - list[end]!.joinTime <= tier &&
    list[end + 1]!.joinTime - list[start]!.joinTime <= maxSpanSec
  ) {
    end += 1;
  }
  return end;
}

/** 按某一档把全群切成互不重叠的一波波，返回每波的人数（升序）。 */
function chainSizes(
  list: readonly GroupJoinClusterMember[],
  tier: number,
  maxSpanSec: number,
): number[] {
  const sizes: number[] = [];
  for (let i = 0; i < list.length; ) {
    const end = chainEnd(list, i, tier, maxSpanSec);
    sizes.push(end - i + 1);
    i = end + 1;
  }
  return sizes.sort((a, b) => a - b);
}

/** 取分位数（最近秩）；空数组给 0。 */
function quantile(sorted: readonly number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(Math.min(Math.max(ratio, QUANTILE_MIN_RATIO), 1) * sorted.length) - 1),
  );
  return sorted[idx]!;
}

/**
 * 挤度门槛：本群一波能来多少人，取 `1 - rarityRatio` 分位。
 *
 * 样本少的时候分位数会退化成「只有最挤的那一波」—— 一个 6 人波就能把 5 人波挡在门外，
 * 所以小样本时用 `1 / 波数` 兜底（即至少退到第二挤的那一波），让同一个群里两波差不多
 * 紧的人都能成伙；样本少于 {@link MIN_QUANTILE_SAMPLES} 波时分位数没有意义，退回 0
 * 交由人数下限兜底。
 */
function crowdBar(sizes: readonly number[], rarityRatio: number): number {
  if (sizes.length < MIN_QUANTILE_SAMPLES) return 0;
  const ratio = Math.max(rarityRatio, 1 / sizes.length);
  return quantile(sizes, 1 - ratio);
}

/**
 * 全群平均「多久来一个人」（秒）= 总跨度 ÷ (人数 - 1)。
 *
 * 用平均而不是中位数：中位数会被灌水波次带偏（一波 300 人挤在同一天，中位间隔就变成几分钟，
 * 门槛直接被顶到天上）；平均速度代表「这个群长期来看进人多快」，正好当速度门槛的分母。
 */
function meanGapSeconds(sorted: readonly GroupJoinClusterMember[]): number {
  if (sorted.length < 2) return 0;
  const span = sorted[sorted.length - 1]!.joinTime - sorted[0]!.joinTime;
  return span > 0 ? span / (sorted.length - 1) : 0;
}

function buildCluster(
  index: number,
  raw: GroupJoinClusterMember[],
  total: number,
  windowSeconds: number,
): GroupJoinCluster {
  const startTime = raw[0]!.joinTime;
  const endTime = raw[raw.length - 1]!.joinTime;
  const messageCount = raw.reduce((sum, m) => sum + m.messageCount, 0);
  const topSpeaker = raw.reduce<GroupJoinClusterMember | null>(
    (best, m) => (m.messageCount > 0 && (!best || m.messageCount > best.messageCount) ? m : best),
    null,
  );
  const levelSum = raw.reduce((sum, m) => sum + m.memberLevel, 0);
  return {
    index,
    startTime,
    endTime,
    spanDays: (endTime - startTime) / DAY_SECONDS,
    members: raw,
    messageCount,
    messageShare: total > 0 ? messageCount / total : 0,
    topSpeaker,
    avgLevel: Math.round(levelSum / raw.length),
    windowSeconds,
    gapSeconds: Math.round((endTime - startTime) / Math.max(raw.length - 1, 1)),
  };
}

/**
 * 把成员列表聚成若干小团体 + 一堆游离分子。
 *
 * `groupMessageTotal` 传全群历史消息总数（服务层用一条 `GROUP BY 发送者` 的 SQL 得到），
 * 用于算每伙人的发言占比。入群时间为 0 的成员照常传进来，它们只影响 `unknownJoinCount`。
 */
export function buildJoinClusterReport(
  members: readonly GroupJoinClusterMember[],
  groupMessageTotal: number,
  criteria: JoinClusterCriteria = DEFAULT_JOIN_CLUSTER_CRITERIA,
): GroupJoinClusterReport {
  const dated = members.filter((m) => m.joinTime > 0).sort((a, b) => a.joinTime - b.joinTime);
  const unknownJoinCount = members.length - dated.length;

  const empty = {
    totalMembers: dated.length,
    unknownJoinCount,
    minClusterSize: criteria.minSize,
    allInOneWave: false,
    clusters: [] as GroupJoinCluster[],
    waves: [] as GroupJoinWave[],
    waveMemberCount: 0,
    drifters: [] as GroupJoinClusterMember[],
    driftMessageShare: 0,
    groupMessageTotal,
    meanGapSeconds: 0,
    tierNeeds: [] as GroupJoinTierNeed[],
    criteria,
  };
  if (dated.length === 0) {
    return { ...empty, firstJoinTime: 0, lastJoinTime: 0 };
  }

  const firstTime = dated[0]!.joinTime;
  const lastTime = dated[dated.length - 1]!.joinTime;
  const maxWindowSec = Math.max(criteria.windowDays * DAY_SECONDS, HOUR_SECONDS);

  // 全员都在最长窗口里进来 —— 这个群本身就是一伙，先处理掉：
  // 否则档位梯子会把它切成好几块，还会给「几个人一起建群」这种正常的事挑刺。
  if (lastTime - firstTime <= maxWindowSec && dated.length >= criteria.minSize) {
    return {
      ...empty,
      allInOneWave: true,
      clusters: [buildCluster(1, dated, groupMessageTotal, maxWindowSec)],
      meanGapSeconds: meanGapSeconds(dated),
      firstJoinTime: firstTime,
      lastJoinTime: lastTime,
    };
  }

  const tiers = tierSeconds(criteria);
  const meanGap = meanGapSeconds(dated);
  const cap = Math.max(criteria.maxSize, criteria.minSize);

  /**
   * 某一档的人数门槛：本群自己「一波能来多少人」的高分位，再用 minSize 保底。
   * 分位数的意义：大群里 1 小时来 20 个人是日常，小群里 3 个人就是奇观 ——
   * 只有跟本群自己的节奏比才有意义。
   */
  const needs = new Map<number, number>();
  for (const tier of tiers) {
    const crowd = crowdBar(chainSizes(dated, tier, maxWindowSec), criteria.rarityRatio);
    needs.set(tier, Math.max(criteria.minSize, crowd));
  }
  const needFor = (windowSec: number): number => needs.get(windowSec) ?? criteria.minSize;

  /**
   * 速度门槛：这一波的速度（`spanSec` 秒里 `size` 人）要达到全群平均速度的
   * `densityFactor` 倍。匀速进人的群永远过不了这道闸（它就是自己的平均速度），
   * 这正是我们想要的：流水线不算「一伙人」。
   */
  const beatsPace = (size: number, spanSec: number): boolean => {
    if (meanGap <= 0) return true;
    const expected = (spanSec / meanGap) * criteria.densityFactor;
    return size >= expected;
  };

  const picked: Array<{ start: number; end: number; windowSeconds: number }> = [];
  const waveRanges: Array<{ start: number; end: number }> = [];

  for (let i = 0; i < dated.length; ) {
    // 由短到长试档位：谁先「串够人 + 挤过本群常态」就用哪一档 —— 越短越硬。
    let used = false;
    for (const tier of tiers) {
      const end = chainEnd(dated, i, tier, maxWindowSec);
      const size = end - i + 1;
      if (size < criteria.minSize || size < needFor(tier)) continue;
      const spanSec = dated[end]!.joinTime - dated[i]!.joinTime;
      if (!beatsPace(size, spanSec)) continue; // 只是本群的常态流水，算不上「挤」
      // 人多到称不上「小」团体 → 拉新潮。
      if (size > cap) waveRanges.push({ start: i, end });
      else picked.push({ start: i, end, windowSeconds: tier });
      i = end + 1;
      used = true;
      break;
    }
    if (!used) i += 1;
  }

  const clusters = picked.map((raw, idx) =>
    buildCluster(
      idx + 1,
      dated.slice(raw.start, raw.end + 1),
      groupMessageTotal,
      raw.windowSeconds,
    ),
  );

  const waveMembers: GroupJoinClusterMember[] = [];
  for (const range of waveRanges) waveMembers.push(...dated.slice(range.start, range.end + 1));
  waveMembers.sort((a, b) => a.joinTime - b.joinTime);

  // 潮汐段按时间切分：同一波里的成员彼此间隔不超过最长窗口，断开就是两波。
  const waves: GroupJoinWave[] = [];
  for (let i = 0; i < waveMembers.length; ) {
    let j = i;
    while (
      j + 1 < waveMembers.length &&
      waveMembers[j + 1]!.joinTime - waveMembers[j]!.joinTime <= maxWindowSec
    ) {
      j += 1;
    }
    const raw = waveMembers.slice(i, j + 1);
    const startTime = raw[0]!.joinTime;
    const endTime = raw[raw.length - 1]!.joinTime;
    const messageCount = raw.reduce((sum, m) => sum + m.messageCount, 0);
    waves.push({
      startTime,
      endTime,
      spanDays: (endTime - startTime) / DAY_SECONDS,
      memberCount: raw.length,
      messageCount,
      messageShare: groupMessageTotal > 0 ? messageCount / groupMessageTotal : 0,
    });
    i = j + 1;
  }

  const claimed = new Set<GroupJoinClusterMember>();
  for (const cluster of clusters) for (const m of cluster.members) claimed.add(m);
  for (const wave of waveRanges) {
    for (let k = wave.start; k <= wave.end; k++) claimed.add(dated[k]!);
  }
  const drifters = dated.filter((m) => !claimed.has(m));
  const driftMessages = drifters.reduce((sum, m) => sum + m.messageCount, 0);

  return {
    ...empty,
    totalMembers: dated.length,
    unknownJoinCount,
    minClusterSize: needFor(tiers[0]!),
    clusters,
    waves,
    waveMemberCount: waveMembers.length,
    drifters,
    driftMessageShare: groupMessageTotal > 0 ? driftMessages / groupMessageTotal : 0,
    firstJoinTime: firstTime,
    lastJoinTime: lastTime,
    meanGapSeconds: meanGap,
    tierNeeds: tiers.map((windowSeconds) => ({ windowSeconds, minCount: needFor(windowSeconds) })),
  };
}
