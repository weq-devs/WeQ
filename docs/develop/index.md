# 开发者入口

面向想参与 WeQ 开发的贡献者。

## 快速开始

```bash
pnpm dev           # 自动补齐依赖、native 和必要构建后启动
```

仅使用根 `package.json` 的 `packageManager` 所锁定的 pnpm；环境与门禁按[贡献指南](https://github.com/weq-devs/WeQ/blob/dev/CONTRIBUTING.md)。发布版模式不预下载大装扮索引，应用按需获取；本地源码模式准备自己的配套资源。配置见[一行命令开发启动](dev-startup.md)。以下按主题查阅，不必先读全部专题。

本文按当前分支提供导航，不将待办或历史测试回执当成当前发布状态。用户操作路径以
[使用手册](../guide/index.md)和[设置总览](../guide/settings.md)为准。

## 章节

### 先看这几个

- [nt_helper.node 接口文档](nt-helper-interface.md) — 原生模块能力总览，**写代码前先看，别重复造轮子**
- [原理总览](principles/index.md) — 数据库 / 表情 / 字体加解密与派生的结论（不含逆向过程）
- [长期授权集成](long-term-authorization.md) — 权限助手的状态机、接口版本与发布通道
- [工具箱](/tools/) — 文档站里可直接算的派生公式

### 内容与工具

- [群资料页与成员预览](group-profile-workspace.md) — 共用资料页目录、有界成员预览、来源隔离与页内功能宿主。

- [跨端偏好与功能状态](client-state-sync.md)：共享与设备归属、迁移、变更通知、备份及草稿冲突。

- [统一联系人名片与资料页](contact-profile.md)：全局内容偏好、共享查询、按需统计与页内详情。

- [统一媒体预览](media-preview.md)：共用浮层、图片／视频混排、聊天连续浏览、离线分页与原生控件回归。

- [统一导出格式与内容范围](export-format/README.md)：待实现设计；basic/full 作为同格式的导出选项，包含未知残余及无独立正文基线的增量契约。
- [联系人与群资料历史](contact-history.md)：共享读取入口、紧凑版本存储、旧缓存迁移和历史查询。

### QQ 空间

- [未接入项](qzone-todo.md)
- [分页限流](qzone-pagination-rate-limit.md)

### 基础能力与贡献

- [开发控制台日志](development-console-logging.md)：终端开关、模块过滤、关联 ID、媒体汇总与慢等待诊断。

- [原生二进制与装扮资源的分发](native-artifacts.md) — `pnpm native:fetch`、发布链路、历史清洗记录
- [一行命令开发启动](dev-startup.md) — 自动补依赖、构建与启动，发布版／本地 native 来源配置
- [测试约定](testing.md) — `@weq/testkit`
- [WeQ 存储管理](storage-management.md)：统计范围、嵌套目录去重、只读数据与缓存清理白名单。
- [图文 Ark 卡片发送](ark-send.md) — OIDB 0xdc2_34 的下发结果解析，以及 PC/Linux 端的已知实现缺口
- [推荐联系人 / 推荐群卡片](contact-ark.md) — 0x12b6_0 / 0x8b7_5 取卡 + PbSendMsg 直接发送（两步合一）
- [AI 声聊](ai-voice.md) — 声线目录（OIDB 0x929d_0：分组 / 中文名 / 样音）与语音合成（0x929b_0），样音不入库
- [群报名 / 群收集表](group-signup.md) — OIDB 0x921b_0 的字段布局、图片直链处理与已知缺口
- [发消息](send-message.md) — `MessageSvc.PbSendMsg` + 富媒体上传（NTV2/highway）+ 文件（群/私聊，老 OIDB + highway）、元素类型表、MCP 工具与已知缺口
- [本地文字识别模型](ocr-models.md)：模型选型背景；当前识别与筛图配置见[设置](../guide/settings.md#ai-功能)。
- [群扩展资料读取](group-profile-extensions.md) — 服务端 grade、活跃成员数、冻结状态及头像元数据，按账号缓存与按需读取。
- [群内单成员消息提醒研究（暂未提供功能）](group-member-notify.md) — Android 三态协议、实际读取失败及暂时撤下结论，非当前可用接口。
- [贡献指南](https://github.com/weq-devs/WeQ/blob/dev/CONTRIBUTING.md)

---

[← 返回文档中心](../index.md)
