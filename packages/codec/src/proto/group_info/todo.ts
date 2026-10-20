/**
 * 48902 — Column in `group_todo_top_banner` (group_info.db).
 *
 * 「群待办」顶部横幅的本地缓存：一行一个群（`48901` = 群号），`48902` 是这个群
 * 当前待办的 protobuf。整表由 QQ 维护 —— 设置 / 完成 / 取消待办都只走 0xF90，
 * 本地这张表是服务端下发的投影，WeQ 只读。
 *
 * 实测结构（21 个真实群样本，PC + 安卓备份一致）：
 *
 *   48902 {
 *     1 {                       // banner
 *       1 bizType               // 15 = 群待办
 *       2 bannerType            // 2 = 普通待办；0 = 已失效/占位
 *       3 msgId                 // UTF-8 "{msgSeq}_{msgRandom}"
 *       4 isDisappear           // true = 已消失（占位行，内容字段全空）
 *       8 expireTime            // unix 秒
 *       11/12/13/14 {…}         // 其它 banner 变体，群待办里全空（见下）
 *       20 commonBanner {       // 新式横幅（QQ 9 起的群待办都走这个）
 *         1 ui {
 *           1 iconUrl           // 固定是 p.iqun.qq.com 的「群待办」图标
 *           2 preText           // 前缀，实测恒为 "群待办｜"
 *           3 text              // 正文摘要：[图片] / [文件]名字 / 纯文本 / 链接
 *           4 highText
 *           5 accessoryType     // 2 = 带图标
 *           6 iconColor
 *           7 needTranslation
 *         }
 *         2 jumpInfo {
 *           1 jumpType          // 3 = 跳到消息
 *           2 jumpUrl
 *           3 jumpParam         // JSON `{"seq":<msgSeq>,"random":<msgRandom>}`
 *         }
 *         3 createTime          // unix 秒
 *         4 updateTime          // unix 秒
 *       }
 *       40 {…}
 *       41/42/43/44/45/46      // 群待办里恒为 20002 / 200 / 0 / 0 / 1 / 1
 *     }
 *     2                         // 实测恒为 0
 *     3                         // = msgSeq（与 msgId 前缀一致）
 *   }
 *
 * `12` 是旧式 `todoBanner`（redText/text/url/isExposure/isComplete），`13`/`14`
 * 是另外两种横幅变体 —— 样本里都只是空壳，群待办从未在其中放内容。保留建模是为了
 * 字节往返不丢字段，正文统一优先读 `20.commonBanner.ui.text`，读不到再退回 `12.text`
 * （与 `@weq/protocol` 的 `GetGroupTodoList` 解析口径一致）。
 */

import { ProtoField, ScalarType } from '../../core';

/** `20.1` — 横幅 UI 文案。 */
const TodoBannerUi = {
  /** 1 — 左侧图标（群待办固定是 p.iqun.qq.com 的 png）。 */
  iconUrl: ProtoField(1, ScalarType.STRING, { optional: true }),
  /** 2 — 前缀文案，如「群待办｜」。 */
  preText: ProtoField(2, ScalarType.STRING, { optional: true }),
  /** 3 — 正文摘要：[图片] / [文件]名字 / 原文 / 链接。 */
  text: ProtoField(3, ScalarType.STRING, { optional: true }),
  /** 4 — 高亮文案。 */
  highText: ProtoField(4, ScalarType.STRING, { optional: true }),
  /** 5 — 附件图标类型（2 = 带图标）。 */
  accessoryType: ProtoField(5, ScalarType.UINT32, { optional: true }),
  /** 6 — 图标配色。 */
  iconColor: ProtoField(6, ScalarType.UINT32, { optional: true }),
  /** 7 — 是否需要翻译。 */
  needTranslation: ProtoField(7, ScalarType.BOOL, { optional: true }),
};

/** `20.2` — 点击横幅的跳转目标。 */
const TodoBannerJumpInfo = {
  /** 1 — 跳转类型（3 = 跳到原消息）。 */
  jumpType: ProtoField(1, ScalarType.UINT32, { optional: true }),
  /** 2 — 跳转 URL（群待办为空）。 */
  jumpUrl: ProtoField(2, ScalarType.STRING, { optional: true }),
  /** 3 — 跳转参数，JSON `{"seq":<msgSeq>,"random":<msgRandom>}`。 */
  jumpParam: ProtoField(3, ScalarType.STRING, { optional: true }),
};

/** `20` — 新式横幅（QQ 9 起群待办都走这里）。 */
const TodoBannerCommon = {
  /** 1 — UI 文案。 */
  ui: ProtoField(1, () => TodoBannerUi, { optional: true }),
  /** 2 — 跳转信息。 */
  jumpInfo: ProtoField(2, () => TodoBannerJumpInfo, { optional: true }),
  /** 3 — 创建时间（unix 秒）。 */
  createTime: ProtoField(3, ScalarType.UINT64, { optional: true }),
  /** 4 — 更新时间（unix 秒）。 */
  updateTime: ProtoField(4, ScalarType.UINT64, { optional: true }),
};

/** `12` — 旧式 `todoBanner`（样本里恒为空壳，群待办从不写这里）。 */
const TodoBannerLegacy = {
  /** 1 — 红色提示文案。 */
  redText: ProtoField(1, ScalarType.STRING, { optional: true }),
  /** 2 — 正文。 */
  text: ProtoField(2, ScalarType.STRING, { optional: true }),
  /** 3 — 跳转 URL。 */
  url: ProtoField(3, ScalarType.STRING, { optional: true }),
  /** 4 — 是否曝光过。 */
  isExposure: ProtoField(4, ScalarType.BOOL, { optional: true }),
  /** 5 — 是否已完成。 */
  isComplete: ProtoField(5, ScalarType.BOOL, { optional: true }),
};

/** `1` — 一个横幅。 */
const TodoBanner = {
  /** 1 — 业务类型（15 = 群待办）。 */
  bizType: ProtoField(1, ScalarType.UINT32, { optional: true }),
  /** 2 — 横幅类型（2 = 待办，0 = 占位）。 */
  bannerType: ProtoField(2, ScalarType.UINT32, { optional: true }),
  /** 3 — 消息标识，UTF-8 `"{msgSeq}_{msgRandom}"`。 */
  msgId: ProtoField(3, ScalarType.STRING, { optional: true }),
  /** 4 — 已消失（占位行），内容字段全空。 */
  isDisappear: ProtoField(4, ScalarType.BOOL, { optional: true }),
  /** 8 — 过期时间（unix 秒）。 */
  expireTime: ProtoField(8, ScalarType.UINT64, { optional: true }),
  /** 12 — 旧式 todoBanner。 */
  todoBanner: ProtoField(12, () => TodoBannerLegacy, { optional: true }),
  /** 20 — 新式横幅。 */
  commonBanner: ProtoField(20, () => TodoBannerCommon, { optional: true }),
};

/** `48902` 的内层：横幅 + 两个恒定的尾巴字段。 */
const TodoTopBannerInner = {
  /** 1 — 当前横幅。 */
  banner: ProtoField(1, () => TodoBanner, { optional: true }),
  /** 2 — 实测恒为 0。 */
  unknown2: ProtoField(2, ScalarType.UINT32, { optional: true }),
  /** 3 — msgSeq（与 msgId 前缀一致）。 */
  msgSeq: ProtoField(3, ScalarType.UINT64, { optional: true }),
};

/** 根 schema：`ProtoMsg(GroupTodoTopBannerColumn).decode(48902 blob)`。 */
export const GroupTodoTopBannerColumn = {
  /** 48902 — 待办横幅。 */
  info: ProtoField(48902, () => TodoTopBannerInner, { optional: true }),
};
