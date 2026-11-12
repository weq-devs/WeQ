# 未读计数来源与 WeQ 阅读状态

## 统一结果

`UnreadInfoService.getUnreadInfos()` 是桌面、Web 和 Remote 的统一结果入口。前端只显示
`unreadCount`，不根据 QQ 基数、数据库水位或本地操作另算数量。`countPending` 与 `readError`
都不能作为零未读应用。

逻辑模型为 `max(0, QQ 最新基数 - 仍在 QQ 未读范围内的 WeQ 已读消息)`。扣减依据消息边界和
阅读范围去重，不按阅读次数累计，也不保存一个永久的数字差。自动阅读与手动已读共用有效阅读位置。
手动未读只维持标记：有实际剩余时显示实际数量，没有实际剩余时维持既有最小未读标记，不再额外叠加一条。

## 当前计数接口

`createQqUnreadCountSource()` 仅为 macOS arm64、QQNT `7.0.3-54395` 的已验证布局启用。
原生能力、布局或导出缺失，以及其他平台，继续使用数据库路径。原生层负责进程、持库账号与实际加载模块校验；
WeQ 只消费正式 API，不扫描或修改 QQ 内存。实际构建须包含 `getQqUnreadCapability`、
`readQqUnreadCounts` 与 `clearQqUnreadCache` 三个可选导出。

当前原生快照只有计数、来源 generation、覆盖范围与缺失目标，**没有同批的 QQ 有效阅读位置**。
因此当前实现遵循：

- 无 WeQ 阅读差异、来源可信且数据库边界一致时，直接使用内存计数，完整查询不再扫描该会话的自己发言。
- 存在 WeQ 自动或手动阅读记录时，不能从数量变化推测 QQ 确认了哪些消息；继续使用现有按有效水位排除自己发言的精确统计。
- 缺失对象不等于零；数据库边界变化、读取失败或来源失效时回到数据库，不沿用错位的内存数。
- 内存数量与数据库结果不同不代表差异全部已读。未对齐的数量不生成跳转水位，也不写入本地已读记录。

只有未来取得可验证的同边界 QQ 阅读范围，才可仅校准其与 WeQ 阅读记录的交集、缩小未确认范围。
数据库 `41002` 可能由 WeQ 自己写入；写库成功、上报应答或 QQ 数量下降都不能代替这种证据。
当前不清除本地阅读记录来冒充 QQ 确认，也不根据数字差推导 QQ 阅读位置。

## 后台就绪与失效

启动请求先使用数据库计算与持久化 WeQ 阅读状态，冷定位不进入请求等待链。定位期间数据库刷新照常继续。
原生就绪后重新读取数据库水位，再取一次短内存快照并复读数据库；只接纳前后数据库边界未变、
generation 一致的目标，不使用启动时数字与十几秒后的计数建立差值。

后台每 1.5 秒校准已实例化普通私聊与群聊，失败有界退避。数量或消息／阅读边界发生变化都会通知现有目标刷新订阅，
所以 QQ 读旧消息同时收到同数量新消息时不会因总数不变而跳过刷新。缓存有时效上限，关闭账号停止定时器并清理定位；
换源或旧请求迟到时不发布旧结果。设备会话与缺失目标继续沿用现有逻辑。

## 持久化与操作

本地记录分别保存数据库观察水位与 WeQ 阅读水位。旧格式无法判断来源时保守保留其阅读记录；
旧版手动 `unreadCount` 只迁移为操作类型，不继续冻结数量或复制旧高亮。

所有写入采用捕获时的固定阅读位置，重试不追随新消息。手动操作记录包含前态和操作代；
后续阅读／标记使旧撤销失效。撤销只恢复该操作的阅读范围，并合并边界之后到达的新消息。

## 定向回归

```sh
pnpm --filter @weq/service exec vitest run test/local_unread.test.ts test/unread_count_source.test.ts test/unread_scheduling.test.ts test/read_report.test.ts
pnpm --filter @weq/desktop exec vitest run test/unread_router.test.ts test/unread_refresh.test.ts test/local_unread_ui.test.ts
WEQ_PLAYWRIGHT_IMPORT=/absolute/path/to/playwright/index.mjs pnpm exec tsx apps/desktop/test/browser/run-unread-counts.mts
```

浏览器回归使用真实 `ConversationList` 组件和合成 `UnreadInfoService` 服务，覆盖深浅主题、桌面与窄屏。
这不等于安装运行版已切换来源，也不替代原生读取端的真 QQ 验收。
