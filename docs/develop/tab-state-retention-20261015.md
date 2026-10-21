# 页面现场保留

`RetainedTabs` 按需挂载访问过的页并保留 DOM/组件状态；未访问页不提前挂载。隐藏页沿用最后一次活动时的 props，重新激活再更新。缓存通过 React render state 发布，避免中断渲染泄漏未访问页。

- 消息、联系人各自保留选择和侧栏滚动；显式返回/关闭仍清除对应详情，不清除另一页选择。
- 消息阅读锚点仍由 `ChatPane` 管理，不能靠父层重设滚动恢复。隐藏图谱忽略零尺寸，不无故重启布局。
- 隐藏页通过活动性上下文停止键盘、边缘翻页、滚动定位、浮层注册与焦点处理；已读路径也须复核活动页。
- 在 layout effect 中移除文档监听，避免切页提交后到 passive cleanup 之间仍抢键。
- 保留页面不代表暂停后台导出/助手任务，也不保证所有子查询都停止。账号 key 变化或应用重启会丢弃内存现场。

源码：`components/RetainedTabs.tsx`、`WorkspacePages.tsx`、`im-template/template/chatShell.tsx`、`chatPane.tsx`。回归入口：`workspace_surfaces.test.ts`、`chat_read_gestures.test.ts`、`search_return.test.ts`。
