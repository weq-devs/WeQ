/**
 * search_history (nt_msg.db) — 搜索历史 / 最近搜索命中。
 *
 * 表本体只有两列：`[100210]` 自增主键 + `[100211]` BLOB。整个 BLOB 是一个 proto
 * 消息，而它的唯一字段号**就是列号本身**（100211），里面装一条搜索结果：
 *
 *   SearchHistoryBody
 *     100211: SearchHistoryEntry
 *       100212: resultKind (1 = 人, 2 = 群, 4 = 文件)
 *       100214: GroupSearchResult    ← resultKind = 2
 *       100217: PersonSearchResult   ← resultKind = 1
 *         (人再分) 100300: 1 = 好友 → 100301: BuddyHit
 *                  100300: 2 = 群成员 → 100302: GroupMemberHit
 *       100221: FileSearchResult     ← resultKind = 4 → 105209: FileHit
 *
 * 一行 = 一条命中：实体（好友 / 群成员 / 群 / 文件）的资料 + 命中的高亮片段
 * （{@link SearchHighlight}.matchedText）。
 *
 * ⚠️ **这张表没有时间字段**：新旧顺序只能靠自增的 `[100210]` 推（QQ 只留最近
 * 的一批，被淘汰的行会直接从表里消失，所以 rowid 不连续）。也没存用户输入的
 * 完整关键词，只存了「命中的那一段名字」。
 *
 * 逆向依据（2026-09-29，5 行真实数据，逐字段与 `get_user_profile` /
 * `search_buddies` / `get_group_info` 交叉验证）：
 *   - 1000 / 1001 / 1002 = uid / qid / uin，其中 1001 与资料卡的 qid 一字不差
 *     （`estkinn`、`Tanzhiqiao`）；
 *   - 100150.60001 / 60007 = 真实群号 / 群名，100150.60006 = 该群真实成员数；
 *   - 100142 / 100154 / 100161 / 100180 四个「命中块」结构与取值完全同构，只是
 *     分别挂在好友 / 群 / 群成员 / 文件资料下面；
 *   - 25008（"我的好友"）在 `profile/25011` 里是好友分组名，此处取值一致；
 *   - 64003 = 群名片（群友样本里为空，文件样本里是发送者在该群的卡片名）；
 *   - 文件命中（resultKind=4）是拿同一条消息的 40800 文件元素对出来的：
 *     200009 ≡ 那行的 `[40050]`、200015 ≡ `[40001]`、200002/200005/200026/
 *     200021/200011 ≡ 文件元素的 45402/45405/45406/45503/45403。
 *
 * 命名约定：沿用 codec 的全局 tag 字典 —— 同一 tag 在别的表里已有含义的，必须
 * 复用已有名字（uid / uin / nick / name / chatType / groupCode / groupName），
 * 否则 `dictionary.test.ts` 里「歧义 tag 恰好是已知那几个」的断言会失败。
 *
 * 未观测到的字段一律 `optional`：5 个样本里 100900/100901/100908 等在不同大类
 * 下时有时无。
 */

import { ProtoField, ScalarType } from '../../core';

/**
 * 命中高亮块 —— 三种实体共用同一形状（好友挂 100142、群挂 100154、群成员挂
 * 100161）。
 */
export const SearchHighlight = {
  /**
   * 100135 — 疑似命中片段在名称里的起始位置。5 个样本全是前缀命中，恒为 0，
   * 无法与「匹配类型枚举」区分；等一个非前缀命中的样本才能定论。
   */
  matchStart: ProtoField(100135, ScalarType.UINT32, { optional: true }),
  /** 100136 — 命中片段的长度，按**字符**数（不是字节）。 */
  matchLength: ProtoField(100136, ScalarType.UINT32, { optional: true }),
  /** 100338 — 命中片段原文，如「四驱」（群名「四驱小子」的前缀）。 */
  matchedText: ProtoField(100338, ScalarType.STRING, { optional: true }),
};

/** 命中的好友（100301 / resultKind=1, personKind=1）。 */
export const BuddyHit = {
  uid: ProtoField(1000, ScalarType.STRING, { optional: true }),
  /** 1001 — 自定义 QQ 号（qid），与资料卡上的 qid 同源。 */
  qid: ProtoField(1001, ScalarType.STRING, { optional: true }),
  uin: ProtoField(1002, ScalarType.UINT64, { optional: true }),
  nick: ProtoField(20002, ScalarType.STRING, { optional: true }),
  /** 20009 — 恒为空串，语义未明。 */
  flag20009: ProtoField(20009, ScalarType.STRING, { optional: true }),
  /** 25008 — 好友分组名（默认分组「我的好友」），同 `profile/25011` 的 name。 */
  name: ProtoField(25008, ScalarType.STRING, { optional: true }),
  /** 40010 — 会话类型：1 = 私聊（群里恒为 2）。 */
  chatType: ProtoField(40010, ScalarType.UINT32, { optional: true }),
  highlight: ProtoField(100142, () => SearchHighlight, { optional: true }),
  flag100908: ProtoField(100908, ScalarType.UINT32, { optional: true }),
};

/** 命中的群成员（100302 / resultKind=1, personKind=2）。 */
export const GroupMemberHit = {
  uid: ProtoField(1000, ScalarType.STRING, { optional: true }),
  uin: ProtoField(1002, ScalarType.UINT64, { optional: true }),
  nick: ProtoField(20002, ScalarType.STRING, { optional: true }),
  /** 20009 — 恒为空串，语义未明。 */
  flag20009: ProtoField(20009, ScalarType.STRING, { optional: true }),
  /** 60001 — 该成员所在群号。 */
  groupCode: ProtoField(60001, ScalarType.INT64, { optional: true }),
  /** 60007 — 该成员所在群名。 */
  groupName: ProtoField(60007, ScalarType.STRING, { optional: true }),
  /** 60026 — 恒为空串（群资料里也有同 tag）。 */
  flag60026: ProtoField(60026, ScalarType.STRING, { optional: true }),
  /** 64003 — 群名片（该成员在这个群里的昵称）。 */
  groupCard: ProtoField(64003, ScalarType.STRING, { optional: true }),
  highlight: ProtoField(100161, () => SearchHighlight, { optional: true }),
  flag100164: ProtoField(100164, ScalarType.UINT32, { optional: true }),
  flag100908: ProtoField(100908, ScalarType.UINT32, { optional: true }),
};

/** 命中的人的容器（100217 / resultKind=1）。 */
export const PersonSearchResult = {
  /**
   * 100127 — 搜索场景字符串。样本：人 = `""`，群 = `"normal"`。语义未明，
   * 先按观测值原样保留。
   */
  scene: ProtoField(100127, ScalarType.STRING, { optional: true }),
  /** 100300 — 人的子类：1 = 好友（→ 100301），2 = 群成员（→ 100302）。 */
  personKind: ProtoField(100300, ScalarType.UINT32, { optional: true }),
  buddy: ProtoField(100301, () => BuddyHit, { optional: true }),
  groupMember: ProtoField(100302, () => GroupMemberHit, { optional: true }),
  /** 100900 — 命中所在的本地检索索引描述串，人的样本恒为空。 */
  indexDescriptor: ProtoField(100900, ScalarType.STRING, { optional: true }),
  flag100901: ProtoField(100901, ScalarType.UINT32, { optional: true }),
};

/** 命中群的群资料（100150）。 */
export const GroupHit = {
  groupCode: ProtoField(60001, ScalarType.INT64, { optional: true }),
  /** 60006 — 群成员数，与该群真实 memberCount 一致。 */
  memberCount: ProtoField(60006, ScalarType.UINT32, { optional: true }),
  groupName: ProtoField(60007, ScalarType.STRING, { optional: true }),
  flag60018: ProtoField(60018, ScalarType.UINT32, { optional: true }),
  flag60020: ProtoField(60020, ScalarType.UINT32, { optional: true }),
  /** 60026 — 恒为空串（群成员资料里也有同 tag）。 */
  flag60026: ProtoField(60026, ScalarType.STRING, { optional: true }),
  flag60279: ProtoField(60279, ScalarType.UINT32, { optional: true }),
  flag60280: ProtoField(60280, ScalarType.UINT32, { optional: true }),
  flag60281: ProtoField(60281, ScalarType.UINT32, { optional: true }),
  flag60283: ProtoField(60283, ScalarType.UINT32, { optional: true }),
  highlight: ProtoField(100154, () => SearchHighlight, { optional: true }),
  flag100908: ProtoField(100908, ScalarType.UINT32, { optional: true }),
};

/** 群结果里多出来的一小块（100159），单样本里 6 个字段全是 0 / 空串。 */
export const GroupSearchExtra = {
  flag103500: ProtoField(103500, ScalarType.UINT32, { optional: true }),
  flag103501: ProtoField(103501, ScalarType.UINT32, { optional: true }),
  flag103502: ProtoField(103502, ScalarType.STRING, { optional: true }),
  flag103503: ProtoField(103503, ScalarType.STRING, { optional: true }),
  flag103504: ProtoField(103504, ScalarType.UINT32, { optional: true }),
  flag103505: ProtoField(103505, ScalarType.UINT32, { optional: true }),
};

/** 命中群的容器（100214 / resultKind=2）。 */
export const GroupSearchResult = {
  /** 40010 — 会话类型，群里恒为 2。 */
  chatType: ProtoField(40010, ScalarType.UINT32, { optional: true }),
  /** 100127 — 搜索场景字符串，群样本里是 `"normal"`（人的样本是空串）。 */
  scene: ProtoField(100127, ScalarType.STRING, { optional: true }),
  group: ProtoField(100150, () => GroupHit, { optional: true }),
  extra: ProtoField(100159, () => GroupSearchExtra, { optional: true }),
  /**
   * 100900 — 命中所在的本地检索索引描述串，形如
   * `group_info[p=82 h=1],group_member_info[p=81 h=0],last_msg_time[...]`；
   * 这是 QQ 自己的分段索引（字段名 + 优先级 p + 标志 h）调试输出，人的样本恒为空。
   */
  indexDescriptor: ProtoField(100900, ScalarType.STRING, { optional: true }),
  flag100901: ProtoField(100901, ScalarType.UINT32, { optional: true }),
};

/**
 * 命中的文件（100221 → 105209 / resultKind=4）。
 *
 * 字段名带 `file` / `msgId` / `sendTime` 前缀的都是拿同一条消息的 40800 文件元素
 * 对出来的（见文件头注释）；其余未证实的照例 `flagXXXXX`。
 */
export const FileHit = {
  /** 1000 — 文件发送者 uid。 */
  uid: ProtoField(1000, ScalarType.STRING, { optional: true }),
  nick: ProtoField(20002, ScalarType.STRING, { optional: true }),
  /** 20009 — 恒为空串，语义未明。 */
  flag20009: ProtoField(20009, ScalarType.STRING, { optional: true }),
  /** 40010 — 会话类型：2 = 群（文件样本均来自群文件）。 */
  chatType: ProtoField(40010, ScalarType.UINT32, { optional: true }),
  /** 40021 — 对端 uid；群里就是群号的字符串形式。 */
  peerUid: ProtoField(40021, ScalarType.STRING, { optional: true }),
  /** 60001 — 文件所在群号。 */
  groupCode: ProtoField(60001, ScalarType.INT64, { optional: true }),
  /** 60007 — 文件所在群名。 */
  groupName: ProtoField(60007, ScalarType.STRING, { optional: true }),
  /** 60026 — 恒为空串。 */
  flag60026: ProtoField(60026, ScalarType.STRING, { optional: true }),
  /** 64003 — 发送者在该群的群名片。 */
  groupCard: ProtoField(64003, ScalarType.STRING, { optional: true }),
  /** 100180 — 命中高亮（命中的是文件名，样本命中「习题」前缀）。 */
  highlight: ProtoField(100180, () => SearchHighlight, { optional: true }),

  /** 200001 — 32 位 hex，疑似文件自己的 uuid（与元素的 45424 不是同一个）。 */
  flag200001: ProtoField(200001, ScalarType.STRING, { optional: true }),
  /** 200002 — 文件名，≡ 文件元素的 45402。 */
  fileName: ProtoField(200002, ScalarType.STRING, { optional: true }),
  flag200003: ProtoField(200003, ScalarType.UINT32, { optional: true }),
  flag200004: ProtoField(200004, ScalarType.UINT32, { optional: true }),
  /** 200005 — 文件大小（字节），≡ 文件元素的 45405。 */
  fileSize: ProtoField(200005, ScalarType.UINT32, { optional: true }),
  flag200006: ProtoField(200006, ScalarType.UINT32, { optional: true }),
  flag200007: ProtoField(200007, ScalarType.UINT32, { optional: true }),
  /** 200008 — 疑似文件类型（样本 2）。 */
  flag200008: ProtoField(200008, ScalarType.UINT32, { optional: true }),
  /** 200009 — 文件消息的发送时间（unix 秒），≡ 那行的 `[40050]`。 */
  sendTime: ProtoField(200009, ScalarType.UINT32, { optional: true }),
  /** 200010 — 疑似来源枚举（样本 12），与 200018 同值。 */
  flag200010: ProtoField(200010, ScalarType.UINT32, { optional: true }),
  /** 200011 — 路径根标记，≡ 文件元素 45403 的 `::NTOSFull::` 前缀。 */
  pathRoot: ProtoField(200011, ScalarType.STRING, { optional: true }),
  flag200013: ProtoField(200013, ScalarType.UINT32, { optional: true }),
  /** 200014 — 同 200011（元素的 45403 里两处都出现这个前缀）。 */
  pathRoot2: ProtoField(200014, ScalarType.STRING, { optional: true }),
  /** 200015 — 源消息的 msgId，≡ 那行的 `[40001]`（所以能直接跳回原消息）。 */
  msgId: ProtoField(200015, ScalarType.STRING, { optional: true }),
  /** 200016 — 与 200015 只差 1，疑似文件自身的 id（200037/200039 重复同一值）。 */
  flag200016: ProtoField(200016, ScalarType.STRING, { optional: true }),
  flag200017: ProtoField(200017, ScalarType.UINT32, { optional: true }),
  /** 200018 — 与 200010 同值（样本 12）。 */
  flag200018: ProtoField(200018, ScalarType.UINT32, { optional: true }),
  flag200019: ProtoField(200019, ScalarType.UINT32, { optional: true }),
  /** 200020 — 文件所在群号（200021 的数值形式）。 */
  flag200020: ProtoField(200020, ScalarType.UINT64, { optional: true }),
  /** 200021 — 文件下载 token，≡ 文件元素的 45503。 */
  fileToken: ProtoField(200021, ScalarType.STRING, { optional: true }),
  flag200022: ProtoField(200022, ScalarType.STRING, { optional: true }),
  flag200023: ProtoField(200023, ScalarType.STRING, { optional: true }),
  flag200024: ProtoField(200024, ScalarType.UINT32, { optional: true }),
  flag200025: ProtoField(200025, ScalarType.UINT32, { optional: true }),
  /** 200026 — 文件 md5（hex），≡ 文件元素 45406 的字节值。 */
  fileMd5: ProtoField(200026, ScalarType.STRING, { optional: true }),
  flag200027: ProtoField(200027, ScalarType.STRING, { optional: true }),
  flag200028: ProtoField(200028, ScalarType.STRING, { optional: true }),
  flag200029: ProtoField(200029, ScalarType.UINT32, { optional: true }),
  /**
   * 200030/200031（以及 200037/200039）— 超过 int64 显示范围的大整数，
   * 疑似文件的 fileId / batchId。wire 上是 VARINT，所以必须用 UINT64 而不是
   * 字符串（schema-free 工具会把这种大数打印成字符串，容易看错）。
   */
  flag200030: ProtoField(200030, ScalarType.UINT64, { optional: true }),
  flag200031: ProtoField(200031, ScalarType.UINT64, { optional: true }),
  flag200032: ProtoField(200032, ScalarType.UINT32, { optional: true }),
  flag200033: ProtoField(200033, ScalarType.UINT32, { optional: true }),
  flag200034: ProtoField(200034, ScalarType.UINT32, { optional: true }),
  flag200035: ProtoField(200035, ScalarType.UINT32, { optional: true }),
  flag200036: ProtoField(200036, ScalarType.UINT32, { optional: true }),
  flag200037: ProtoField(200037, ScalarType.UINT64, { optional: true }),
  flag200039: ProtoField(200039, ScalarType.UINT64, { optional: true }),
  flag200040: ProtoField(200040, ScalarType.STRING, { optional: true }),
  flag200041: ProtoField(200041, ScalarType.STRING, { optional: true }),
  flag200042: ProtoField(200042, ScalarType.STRING, { optional: true }),
  /** 200043 — 卡片副标题，形如「来自群:<群名>」。 */
  sourceLabel: ProtoField(200043, ScalarType.STRING, { optional: true }),
  flag200044: ProtoField(200044, ScalarType.STRING, { optional: true }),
  flag200045: ProtoField(200045, ScalarType.UINT32, { optional: true }),
  flag200046: ProtoField(200046, ScalarType.UINT32, { optional: true }),
  flag200047: ProtoField(200047, ScalarType.STRING, { optional: true }),
  flag200048: ProtoField(200048, ScalarType.STRING, { optional: true }),
  flag200049: ProtoField(200049, ScalarType.UINT32, { optional: true }),
  flag200050: ProtoField(200050, ScalarType.UINT32, { optional: true }),
  flag200051: ProtoField(200051, ScalarType.STRING, { optional: true }),
  flag200054: ProtoField(200054, ScalarType.STRING, { optional: true }),
  flag200055: ProtoField(200055, ScalarType.STRING, { optional: true }),
  flag200058: ProtoField(200058, ScalarType.STRING, { optional: true }),
  flag200059: ProtoField(200059, ScalarType.UINT32, { optional: true }),
  flag200060: ProtoField(200060, ScalarType.UINT32, { optional: true }),
  flag200061: ProtoField(200061, ScalarType.UINT32, { optional: true }),
  flag200062: ProtoField(200062, ScalarType.UINT32, { optional: true }),
  /** 200063 — 与 200009 同值（发送时间的第二份拷贝）。 */
  sendTimeCopy: ProtoField(200063, ScalarType.UINT32, { optional: true }),
  flag200064: ProtoField(200064, ScalarType.UINT32, { optional: true }),
  flag200201: ProtoField(200201, ScalarType.UINT32, { optional: true }),
  flag200205: ProtoField(200205, ScalarType.STRING, { optional: true }),
  flag200206: ProtoField(200206, ScalarType.STRING, { optional: true }),
  flag200208: ProtoField(200208, ScalarType.STRING, { optional: true }),
  flag200209: ProtoField(200209, ScalarType.STRING, { optional: true }),
  flag200210: ProtoField(200210, ScalarType.STRING, { optional: true }),
};

/** 文件结果的容器（100221 / resultKind=4）。 */
export const FileSearchResult = {
  file: ProtoField(105209, () => FileHit, { optional: true }),
  flag105210: ProtoField(105210, ScalarType.UINT32, { optional: true }),
  flag105211: ProtoField(105211, ScalarType.UINT32, { optional: true }),
};

/** 一条搜索命中记录（100211 列 BLOB 的载荷）。 */
export const SearchHistoryEntry = {
  /** 100212 — 结果大类：1 = 人，2 = 群聊，4 = 文件。 */
  resultKind: ProtoField(100212, ScalarType.UINT32, { optional: true }),
  /** 100214 — 群聊结果容器（resultKind = 2）。 */
  group: ProtoField(100214, () => GroupSearchResult, { optional: true }),
  /** 100217 — 人结果容器（resultKind = 1）。 */
  person: ProtoField(100217, () => PersonSearchResult, { optional: true }),
  /** 100221 — 文件结果容器（resultKind = 4）。 */
  file: ProtoField(100221, () => FileSearchResult, { optional: true }),
};

/** search_history.100211 的根 schema：`new ProtoMsg(SearchHistoryBody).decode(blob)`。 */
export const SearchHistoryBody = {
  entry: ProtoField(100211, () => SearchHistoryEntry, { optional: true }),
};
