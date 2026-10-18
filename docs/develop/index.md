# 开发者入口

面向想参与 WeQ 开发的贡献者。

## 快速开始

```bash
pnpm i
pnpm native:fetch   # 取 nt_helper 原生产物（不入库，新克隆里没有）
pnpm dev
```

> 强烈推荐使用 [pnpm](https://pnpm.io/)。

## 章节

- [UX 重构讨论整理](./ux-discussion-20261017.md) — 已确认决策、撤回建议与待核实边界；附[原始问答](./ux-discussion-20261017-raw.md)，当前实施状态见下条
- [UX 重构施工与验收](./ux-implementation-20261017.md) — 独立分支、逐项覆盖、已执行门禁与剩余工作；施工中，不是完整交付
- [内容与工具完整交付清单](./content-tools-completion-matrix-20261018.md)：功能、美化与远程推送的完整目标、当前证据和未完成项。
- [全局搜索与统一导出完善](./search-export-hardening-20261018.md)：请求隔离、精确选择交接、批量列表、居中及本地收藏检索。
- [联系人精确导出](./contacts-exact-export-20261018.md)：好友/群多选交接、精确 UID、完整目录与任务快照。
- [生成内容精确导出](./generated-content-export-20261018.md)：克隆与助手的持久身份、独立快照、原始结构及账号边界。
- [空间精确导出](./qzone-exact-export-20261018.md)：离散 tid、正文/互动/媒体范围、统一入口及历史隔离。
- [全局搜索新增来源](./content-search-sources-20261018.md)：来源覆盖、账号缓存、频道全库与稳定条目跳转。
- [现有内容能力盘点](./content-capability-census-20261018.md)：按正文、资源与配置层级区分已接入能力及剩余缺口。
- [统一分析与报告](./analysis-report-20261018.md)：统计范围、统一配置、独立结果标签与账号边界，以及移动年度报告和任务整合的剩余工作。
- [非模态内容与工具](./nonmodal-surfaces-20261018.md)：内容页、并行侧栏、轻量浮层、焦点与快捷键边界及验证记录。
- [原生 QQ 邮箱](./qqmail-native-20261017.md)：账号级认证、邮件协议、附件、正文隔离与提醒生命周期

- [引用、提及与 +1](./message-mentions-repeat-20261017.md)：唯一身份剪贴板、当前账号名称解析与相同消息重发
- [多选修饰键与键盘契约](./multi-selection-keyboard-20261017.md)：选择组、范围锚点、键盘隔离与现有入口接入盘点。
- [合成工作窗口与归档](./compose-workspace-20261017.md)：素材与历史快照、独立媒体及账号绑定；窗口与界面仍在施工。
- [SSO 历史路径统一](./unified-sso-history-20261017.md) — 单窗读取、物理请求计数、旧任务及缓存兼容
- [消息显示、补全与导出更新](./message-display-export-20261017.md) — 紧凑元信息、隐私、共享日历、大列表与空间/收藏导出

- [nt_helper.node 接口文档](./nt-helper-interface.md) — 原生模块能力总览，**写代码前先看，别重复造轮子**
- [原生二进制与装扮资源的分发](./native-artifacts.md) — `pnpm native:fetch`、发布链路、历史清洗记录
- [测试约定](./testing.md) — `@weq/testkit`
- [图文 Ark 卡片发送](./ark-send.md) — OIDB 0xdc2_34 的下发结果解析，以及 PC/Linux 端的已知实现缺口
- [推荐联系人 / 推荐群卡片](./contact-ark.md) — 0x12b6_0 / 0x8b7_5 取卡 + PbSendMsg 直接发送（两步合一）
- [AI 声聊](./ai-voice.md) — 声线目录（OIDB 0x929d_0：分组 / 中文名 / 样音）与语音合成（0x929b_0），样音不入库
- [群报名 / 群收集表](./group-signup.md) — OIDB 0x921b_0 的字段布局、图片直链处理与已知缺口
- [发消息](./send-message.md) — `MessageSvc.PbSendMsg` + 富媒体上传（NTV2/highway）+ 文件（群/私聊，老 OIDB + highway）、元素类型表、MCP 工具与已知缺口
- [本地文字识别模型](./ocr-models.md) — PP-OCR 的 ONNX 模型选型（识别 + 筛图）、下载与存储，以及接推理那一轮要做的
- [图片文字识别结果缓存（规划）](./ocr-cache-plan-20261016.md) — 按图片 md5 落盘的结果缓存：灯箱与导出共用，命中就省掉整条识别流水线
- [词云 / 常用语的中文分词](./jieba-word-segmentation-20261017.md) — 接入 QQ 自带结巴词典，技术词不再被切碎；ICU 兜底
- [贡献指南](../../CONTRIBUTING.md)

---

[← 返回文档中心](../README.md)
