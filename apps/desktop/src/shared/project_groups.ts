/**
 * 项目交流群列表 —— 会话头部对这几个群显示「反馈 bug」入口。
 * 只在群聊头部渲染（渲染层 + 主进程 IPC 共用）。
 */
export const PROJECT_GROUP_IDS: readonly string[] = ['975790306'];

/**
 * WeQ 交流群的**分享短链**。加群引导弹窗里的二维码就是它，扫码会 302 到
 * `qun.qq.com/universal-share/share`，其中的 `authKey` 既能发入群申请也能拼
 * `tencent://groupwpa/` 深链接（转换见 `@weq/service` 的 qq_group_join）。
 */
export const PROJECT_GROUP_SHARE_URL = 'https://qm.qq.com/q/ZkhkB1xZSg';

/** 交流群的展示名（弹窗标题，不查本地库）。 */
export const PROJECT_GROUP_NAME = 'WeQ 交流群';

/** 交流群群号（十进制串）。 */
export const PROJECT_GROUP_CODE = '975790306';
