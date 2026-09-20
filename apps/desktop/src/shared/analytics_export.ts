/**
 * 「分析卡片存长图」的跨进程契约（main ⇄ preload ⇄ renderer 共用）。
 *
 * 只放类型：`export type` / `interface` 编译后全部擦除，所以主进程与渲染端都能引，
 * 不会把任何一侧的实现拖进另一侧的包里（和 `shared/router.ts` 同一个套路）。
 *
 * 为什么要有载荷：卡片**不在用户窗口里渲染**了。点击导出时，可见窗口把自己的数据
 * （排行榜、词云、会话力图……）随载荷递给主进程；主进程开一个隐藏窗口，把同一份
 * 卡片渲染出来拍图 —— 用户窗口全程不参与，自然就没有「闪一下」。
 */

/** 三类分析卡片。 */
export type AnalyticsExportKind = 'group' | 'buddy' | 'member';

/** 成员分析需要的人在群里的身份。 */
export interface AnalyticsExportMember {
  uid: string;
  name: string;
  uin?: string | null;
  avatarUrl?: string | null;
}

/**
 * 隐藏窗口渲染这张卡片所需的全部输入。
 *
 * `data` 是各卡片自己的初始数据（群聊是 `{ report, batches, graph }`，私聊/成员是各自
 * 那一个对象）。形状对不上时隐藏窗口会退回自己重新查询，所以这里刻意松。
 */
export interface AnalyticsExportPayload {
  kind: AnalyticsExportKind;
  /** 文件名主体，如群名 / 好友名 / 成员名。 */
  title: string;
  /** 文件名前缀，如「群聊分析」。 */
  label: string;
  groupCode?: string;
  groupName?: string;
  /** 私聊分析：对方的 uid。 */
  peerUid?: string;
  memberCount?: number;
  avatarUrl?: string | null;
  member?: AnalyticsExportMember;
  data?: unknown;
}

/** 导出结果：与「保存对话框」的语义一致。 */
export interface AnalyticsExportResult {
  saved: boolean;
  canceled?: boolean;
  path?: string;
  error?: string;
}
