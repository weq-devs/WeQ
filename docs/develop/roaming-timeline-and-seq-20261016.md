# 漫游时间线与消息序号

- 普通读取只合并本地库和已有漫游缓存，不隐式联网。缺口拉取的可信记录原位插入当前范围，不把历史阅读窗口拖到最新。
- 按页方向、边界与上限混排，支持纯缓存页；本地记录优先，保留同 seq 的本地灰条。QQ 后续同步后本地行替代对应漫游行。
- 漫游 UI 身份独立于本地 msgId，媒体回查仍保留原始 msgId；不能将 random/零值当原库消息 ID。
- 私聊只有确认过的 NT seq 才混排；旧 client seq 记录独立查看，不按时间或正文猜位置。
- 漫游行不提供原库修改、删除、撤回；多选包含漫游行时禁用原库删除。
- 消息序号与秒级时间是两个独立配置，默认关闭；时间使用北京时间，系统灰条不显示 seq。

源码：`apps/desktop/src/shared/roaming_timeline.ts`、`renderer/src/views/MainView.tsx`；缓存读取和回归分别见 `packages/service/src/account/roam_msg_cache.ts`、`roaming_timeline_cache.test.ts` 及桌面 `roaming_timeline.test.ts`。传输与覆盖规则见 [SSO 历史读取](unified-sso-history-20261017.md)。
