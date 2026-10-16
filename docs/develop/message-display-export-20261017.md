# 消息显示、补全与导出更新

日期：2026-10-17（北京时间）。本记录描述源码行为与离线验收，不代表已安装、发布或真实账号验收。

## 行为与边界

| 请求 | 当前实现 | 对应证据 |
| --- | --- | --- |
| seq 紧凑显示、系统消息不重复 | 普通消息与昵称同排；系统灰条不输出 seq | `MessageProvenance`、`messageRow`、`message_display.test.ts` 与真实组件截图 |
| 秒级时间独立设置 | `showMessageSeq` / `showMessageTime` 分别持久化，默认关闭；时间固定北京时间 | `roaming_timeline_cache.test.ts`、`message_display.test.ts` |
| 隐私遮罩不完整 | 补齐草稿、联系人、账号、签名、搜索、资料、空间、收藏、导出目标与媒体；移除悬停揭示 | 当前 `privacy.css` 与合成敏感元素的 computed-style / 悬停检查 |
| 列表、红包、空间图标 | `ListX` / `ListRestart`、现有图标库的红包和带 Z 的 QQ 空间图标 | `chatPane.tsx`、`rail.tsx`，无新增图标依赖 |
| 会话预览表情 | 数据库保留有序 `previewElements`，渲染复用 `FaceEmoji`；保留空格和 face 0，Markdown 兼容正文不重复 | SQLite 实际路径 `recent_contact_preview.test.ts`、`conversation_preview.test.ts` |
| 补全取消预算和会话限制 | 移除前端 / IPC / manager 限制；旧预算字段只保留 hash 兼容，不执行预算 | `roaming_backfill.test.ts`、`sso_history_window.test.ts` |
| 大列表性能 | 计数每批 500 个绑定参数；选择用 Set；补全与导出列表仅渲染可视区域 | 1,050 条 SQLite 夹具；UI 1,500 个补全目标、5,000 个导出选择；10,000 行组件单测 |
| 任务与回执展示 | 连续展示任务，回执和在途窗口优先使用会话友好名称 | 两任务真实面板合成检查 |
| 深色导出标题 | 标题 / 副标题使用语义 token；同时修正窄屏弹窗边界 | 深浅色截图和元素边界检查 |
| 共享消息日历 | 导出范围、搜索范围、日期跳转均用 `MessageCalendar`，七级对数密度；多会话导出按日合计 | `message_display.test.ts`、真实搜索范围 / 跳转合成联测 |
| 搜索日历位置 | 与范围选择一起移至搜索框下方；嵌套日历关闭不连带关闭搜索 | `ChatRecordsModal.tsx` 与合成操作 |
| 空间导出 | 原生空间页顶部新增入口；列表明确截断或缺图时调用已有 R02/R04，保留原始补读响应；HTML / TXT 保留转发原文与媒体、已知转发数 | `qzone_export_completion.test.ts`、既有空间导出测试、原生页面合成入口 |
| 收藏导出 | 查看弹窗可导出全部 / 当前筛选 / 单条 CID；复用详情与附件获取链，涵盖图片、音频、文件与视频；筛选导出不夹带整账号原始响应 | `collection_export_details.test.ts`、`collection_original_pipeline.test.ts` 与收藏弹窗合成入口 |

隐私模式仍是视觉滤镜，不是数据访问控制、加密或不可逆匿名化；导出文件与 DOM 数据不因此改写。

SSO 仍逐物理小窗执行共享 FIFO 和至少 500ms 请求间隔；取消预算不取消暂停、取消、账号隔离、错误保留窗口和精确覆盖核验。已退役通道及旧缓存不删除或重新启用。

说说正文补读没有完整标记时不声明全文；附图扩充不宣称原件质量。转发名单未恢复上线。收藏来源字段、二进制正文、附件原件 / 预览身份及失败回执沿用现有缓存和覆盖报告，不将“已列出 URL”当作“已取得原件”。

## 验证

- `pnpm ci:local`：最终四项门禁全部通过；Rust 检查由脚本因缺少 Cargo 自动跳过。
- `pnpm --filter @weq/desktop exec electron-vite build`：通过；保留既有 dynamic-import 提示。
- 转发附图归属助手已从原生页面抽至无 Node 依赖的 `@weq/service/qzone-media`，页面与导出共同复用；新增测试确认借用素材只补入准确原帖。最终桌面构建与 Web Electron-free 源码守卫均通过。
- `pnpm ci:local --full`：非 Rust 门禁、Web 构建守卫和打包后服务冒烟通过；额外的 daemon 构建因没有 Cargo 失败，不冒称 full 全绿，也未放宽门禁或安装 Rust。
- Playwright 使用真实组件和合成传输，覆盖 1280 / 390 宽度、深浅色、浅深主题色及两种背景，共 28 组场景；检查元信息同行、系统消息无 seq、隐私悬停不揭示、列表窗口化、大批量选择、连续任务、友好回执、弹窗边界、共享日历和导出入口。截图已人工检查。
- 私有夹具与回执复用既有工作目录中的 `display-export-qa*`，没有把私人聊天数据写入仓库。浏览器和一次性夹具均已关闭或清理，截图仅作为有界验收证据保留。

未联网执行单测，未操作真实 QQ、未替换安装包、未重启用户应用。主进程、服务和配置均有变化，需重启开发版 WeQ 才能完整加载；QQ 无需重启。
