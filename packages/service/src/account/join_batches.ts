/**
 * 「入群批次」分析 —— 纯函数，不带任何 IO（IO 在 GroupInfoService.getGroupJoinBatches）。
 *
 * 口径只有一句话：**三个小时内挤进来的人够多，就算一个批次。**
 *
 *   ① 窗口固定 3 小时：从某个人入群那一刻起，往后 3 小时内进来的人都算同批；
 *   ② 达标人数 = max(3, 群总人数 ÷ 20)：大群里 1/20 就是几十人，小群里至少也要 3 个；
 *   ③ 批次之间不重叠：一批的人用完，就从下一批继续往后找，同一个人不会进两个批次；
 *   ④ 入群时间为 0 的行不参与，只计进 `unknownJoinCount`。
 *
 * 注意：这只说明「谁跟谁前后脚进来」，是**入群批次**，不是人际关系意义上的小团体。
 * 真正按聊天会话算的小团体见 {@link ./conversation_graph}。
 */

/** 参与批次统计的成员（入群时间 + 后来的发言量）。 */
export interface GroupJoinBatchMember {
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

/** 一个入群批次：3 小时窗口里挤够人的一波。 */
export interface GroupJoinBatch {
  /** 按时间先后编号，从 1 开始。 */
  index: number;
  startTime: number;
  endTime: number;
  /** 这一批的入群跨度（秒）—— 原始精度，别四舍五入（分钟级也会被抹掉）。 */
  spanSeconds: number;
  members: GroupJoinBatchMember[];
  messageCount: number;
  /** 全团里的头号话痨（全团潜水时为 null）。 */
  topSpeaker: GroupJoinBatchMember | null;
}

/** 入群批次分析结果。 */
export interface GroupJoinBatchReport {
  /** 群总人数（含入群时间缺失的人）—— 门槛的分母。 */
  memberTotal: number;
  /** 有入群时间、参与批次统计的成员数。 */
  datedMemberCount: number;
  /** 入群时间为 0、无法参与统计的成员数。 */
  unknownJoinCount: number;
  /** 达标人数门槛 = max(3, ceil(memberTotal / 20))。 */
  threshold: number;
  /** 窗口（秒），固定 3 小时。 */
  windowSeconds: number;
  batches: GroupJoinBatch[];
  /** 落在批次里的成员数。 */
  batchMemberCount: number;
  /** 全群历史消息总数（用于算每批的发言占比）。 */
  groupMessageTotal: number;
  firstJoinTime: number;
  lastJoinTime: number;
}

/** 固定窗口：三小时。 */
export const JOIN_BATCH_WINDOW_SECONDS = 3 * 3600;
/** 门槛分母：群总人数的 1/20。 */
export const JOIN_BATCH_DIVISOR = 20;
/** 人数下限：再小的群，三个小时里也得挤进 3 个人才算一批。 */
export const JOIN_BATCH_MIN_COUNT = 3;

/**
 * 达标人数：群总人数 ÷ 20，向上取整，且不低于 {@link JOIN_BATCH_MIN_COUNT}。
 *
 * 例：100 人的群 → 5 人；40 人的群 → 3 人（1/20 = 2 被下限抬到 3）；1000 人的群 → 50 人。
 */
export function joinBatchThreshold(memberTotal: number): number {
  const share = Math.ceil(Math.max(memberTotal, 0) / JOIN_BATCH_DIVISOR);
  return Math.max(JOIN_BATCH_MIN_COUNT, share);
}

function buildBatch(index: number, raw: GroupJoinBatchMember[]): GroupJoinBatch {
  const startTime = raw[0]!.joinTime;
  const endTime = raw[raw.length - 1]!.joinTime;
  const messageCount = raw.reduce((sum, m) => sum + m.messageCount, 0);
  const topSpeaker = raw.reduce<GroupJoinBatchMember | null>(
    (best, m) => (m.messageCount > 0 && (!best || m.messageCount > best.messageCount) ? m : best),
    null,
  );
  return {
    index,
    startTime,
    endTime,
    spanSeconds: endTime - startTime,
    members: raw,
    messageCount,
    topSpeaker,
  };
}

/**
 * 把成员列表切成若干入群批次。
 *
 * `memberTotal` 传**群总人数**（含入群时间缺失的人）—— 门槛的分母；拿不到群人数时
 * 传 `dated.length` 也行，此时门槛退化成「最多 1/20 的人同时进来」，仍然成立。
 */
export function buildJoinBatchReport(
  members: readonly GroupJoinBatchMember[],
  groupMessageTotal: number,
  memberTotal: number = members.length,
  windowSeconds: number = JOIN_BATCH_WINDOW_SECONDS,
): GroupJoinBatchReport {
  const dated = members.filter((m) => m.joinTime > 0).sort((a, b) => a.joinTime - b.joinTime);
  const threshold = joinBatchThreshold(memberTotal);

  const base: GroupJoinBatchReport = {
    memberTotal: Math.max(memberTotal, members.length),
    datedMemberCount: dated.length,
    unknownJoinCount: members.length - dated.length,
    threshold,
    windowSeconds,
    batches: [],
    batchMemberCount: 0,
    groupMessageTotal,
    firstJoinTime: 0,
    lastJoinTime: 0,
  };
  if (dated.length === 0) return base;

  const batches: GroupJoinBatch[] = [];
  let batchMemberCount = 0;
  for (let i = 0; i < dated.length; ) {
    // 从 i 起往后 3 小时能装下多少人。
    let end = i;
    while (
      end + 1 < dated.length &&
      dated[end + 1]!.joinTime - dated[i]!.joinTime <= windowSeconds
    ) {
      end += 1;
    }
    const size = end - i + 1;
    if (size >= threshold) {
      batches.push(buildBatch(batches.length + 1, dated.slice(i, end + 1)));
      batchMemberCount += size;
      i = end + 1; // 这一批的人用完，从下一位继续
    } else {
      i += 1; // 窗口里的人不够多，往后挪一位再试
    }
  }

  return {
    ...base,
    batches,
    batchMemberCount,
    firstJoinTime: dated[0]!.joinTime,
    lastJoinTime: dated[dated.length - 1]!.joinTime,
  };
}
