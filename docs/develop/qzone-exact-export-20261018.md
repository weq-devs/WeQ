# 空间精确导出

范围为单个空间的说说；不包括跨作者动态或离散照片。用法见[空间导出](../guide/export.md#4-qq-空间导出)。

## 身份与交接

- 选择归属为 `qzone-posts`，container 是空间 UIN，条目使用真实 tid。列表多选复用账号共享选择和既有键盘契约，后续页不自动扩选。
- 内容导出请求由账号选择上下文持有，复制范围后交给唯一的 `WorkspaceTools` 宿主；不改变正文的多选现场，不使用跨窗口全局事件。旧 `QzoneExportLightbox` 已移除，整空间、格式、互动及媒体能力由统一工具保留。
- 空间选择器改用 UIN 而非普通私聊 UID；非好友空间也能从内容页带入。好友与自己列表按 UIN 去重，消息页的聊天选择不受影响。
- 工具范围编辑器按需单实例，开启精确范围才请求本地查看器已有的空间分页 API；请求取消沿用 `useQzoneRequests`。未加载 tid 明确保留，筛选只针对已加载说说。

## 执行与证据

`startQzoneExport` 接受可选 tid 集合。未传表示原整空间/日期语义，传空集合表示零条，绝不退回整空间。GUI 传入确认时账号 uin 与 configId，服务端复用账号断言拒绝切号、同号不同来源的旧请求。

任务复制 tid、格式及媒体配置，精确任务不持久旧日期。`collectQzone` 对精确集合去重后逐 tid 调用已有 `fetchPostDetail`，验证返回身份，不经过整空间分页；缺失能力、读取失败、已删除/无权内容或身份不匹配均明确失败，不发布少条目的“成功”文件。日期与 `initialRows` 不扩大精确集合。

同一条目的详情只读一次，正文证据、互动和媒体都复用已选行。精确任务不读写账号整空间历史，也不把旧 `qzone-history.json` 混入产物；每种格式的覆盖文件及任务报告记录精确 tid。整空间任务保留原分页捕获、锚点恢复及完整历史文件。

多格式共享一次收集，`current / total` 使用实际条目数，格式副本记入 `formatCounts`。所有文件在 staging 里生成后原子发布，取消和失败丢弃本次半成品。暂停状态不被改成失败或取消，收尾完成后可重新执行；恢复使用原目标和 tid，重新读取服务器，而不是宣称服务器正文不可变。

## 回归入口

- service `qzone_exact_export.test.ts`：不调用整空间分页、日期与缓存隔离、去重/空集合、ID 不匹配、取消、互动范围、真实三格式、历史隔离、计数、持久目标及新管理器恢复。
- desktop `qzone_export_router.test.ts`：精确 tid、空集合、日期分离、账号与同号数据源边界。
- desktop `qzone_selection_ui.test.ts`：正文共享多选、统一请求、独立快照、按需范围读取和未加载身份。
- desktop `unified_export.test.ts`、`workspace_toolbar.test.ts`、`export_scope.test.ts`：非好友空间、确认冻结、统一工具宿主及空集合保护。

实现入口为 `account/export/qzone_export.ts`、`task_manager.ts` 和 `views/export/QzoneScopePicker.tsx`。测试使用合成数据，不证明真实账号全部云端历史均可取得。
