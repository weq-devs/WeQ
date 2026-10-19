# 空间分页限流

- 默认滚动 10 秒窗口最多启动 5 次分页请求；一个进程级 FIFO 由空间浏览、导出、评论页和账号会话共享，切页或改设置不清零使用历史。
- 首屏、刷新及 HTTP 重试均计数；单项详情、统计、昵称、发布/上传和媒体文件不属于分页。路径分类集中在 `common/qzone_pagination.ts`，新增分页接口需登记。
- 超额在 fetch 前等待，排队取消不消耗次数；使用单调时钟和有界历史。队列等待不占网络超时或桌面操作 watchdog。
- 设置位于「账号与消息 → QQ 空间设置」，按 `settings.qzonePagination` 保存窗口秒数与页数；数值范围、默认值和校验以类型定义为准。
- 保存同时更新活跃队列，不抹除历史；启动加载既有设置。缺失/损坏值回落默认，局部内部更新保留另一字段。

源码：`packages/service/src/common/qzone_pagination.ts`、HTTP 传输和 `account/web/`；回归：`qzone_pagination_limit.test.ts`，覆盖边界、FIFO、取消、重试计数、动态设置及超时排除。

前后端不匹配时应先核启动方式：`electron-vite dev --rendererOnly` 复用已有主进程产物，刷新 renderer 不会加载新 RPC。普通 `pnpm dev` 会构建 main/preload；涉及后端更新需加载新主进程，不需要因此重启 QQ。
