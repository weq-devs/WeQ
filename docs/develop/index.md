# 开发者入口

面向想参与 WeQ 开发的贡献者。

## 快速开始

```bash
pnpm i
pnpm native:fetch   # 取 nt_helper 原生产物（不入库，新克隆里没有）
pnpm dev
```

仅使用根 `package.json` 的 `packageManager` 所锁定的 pnpm；环境与门禁按[贡献指南](https://github.com/weq-devs/WeQ/blob/dev/CONTRIBUTING.md)。以下按主题查阅，不必先读全部专题。

本文按当前分支提供导航，不将待办或历史测试回执当成当前发布状态。用户操作路径以
[使用手册](../guide/index.md)和[设置总览](../guide/settings.md)为准。

## 章节

### 内容与工具

- [统一导出格式与内容范围](./export-format/README.md)：待实现设计；basic/full 作为同格式的导出选项，包含未知残余及无独立正文基线的增量契约。
- [联系人与群资料历史](./contact-history.md)：共享读取入口、紧凑版本存储、旧缓存迁移和历史查询。

### QQ 空间

- [未接入项](./qzone-todo.md)
- [分页限流](./qzone-pagination-rate-limit.md)

### 基础能力与贡献

- [开发控制台日志](./development-console-logging.md)：终端开关、模块过滤、关联 ID、媒体汇总与慢等待诊断。

- [nt_helper.node 接口文档](./nt-helper-interface.md) — 原生模块能力总览，**写代码前先看，别重复造轮子**
- [原生二进制与装扮资源的分发](./native-artifacts.md) — `pnpm native:fetch`、发布链路、历史清洗记录
- [测试约定](./testing.md) — `@weq/testkit`
- [WeQ 存储管理](./storage-management.md)：统计范围、嵌套目录去重、只读数据与缓存清理白名单。
- [图文 Ark 卡片发送](./ark-send.md) — OIDB 0xdc2_34 的下发结果解析，以及 PC/Linux 端的已知实现缺口
- [推荐联系人 / 推荐群卡片](./contact-ark.md) — 0x12b6_0 / 0x8b7_5 取卡 + PbSendMsg 直接发送（两步合一）
- [AI 声聊](./ai-voice.md) — 声线目录（OIDB 0x929d_0：分组 / 中文名 / 样音）与语音合成（0x929b_0），样音不入库
- [群报名 / 群收集表](./group-signup.md) — OIDB 0x921b_0 的字段布局、图片直链处理与已知缺口
- [发消息](./send-message.md) — `MessageSvc.PbSendMsg` + 富媒体上传（NTV2/highway）+ 文件（群/私聊，老 OIDB + highway）、元素类型表、MCP 工具与已知缺口
- [本地文字识别模型](./ocr-models.md)：模型选型背景；当前识别与筛图配置见[设置](../guide/settings.md#ai-功能)。
- [群扩展资料读取](./group-profile-extensions.md) — 服务端 grade、活跃成员数、冻结状态及头像元数据，按账号缓存与按需读取。
- [群内单成员消息提醒研究（暂未提供功能）](./group-member-notify.md) — Android 三态协议、实际读取失败及暂时撤下结论，非当前可用接口。
- [贡献指南](https://github.com/weq-devs/WeQ/blob/dev/CONTRIBUTING.md)

---

[← 返回文档中心](../index.md)
