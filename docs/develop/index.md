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

- [nt_helper.node 接口文档](./nt-helper-interface.md) — 原生模块能力总览，**写代码前先看，别重复造轮子**
- [原生二进制与装扮资源的分发](./native-artifacts.md) — `pnpm native:fetch`、发布链路、历史清洗记录
- [测试约定](./testing.md) — `@weq/testkit`
- [图文 Ark 卡片发送](./ark-send.md) — OIDB 0xdc2_34 的下发结果解析，以及 PC/Linux 端的已知实现缺口
- [推荐联系人 / 推荐群卡片](./contact-ark.md) — 0x12b6_0 / 0x8b7_5 取卡 + PbSendMsg 直接发送（两步合一）
- [AI 声聊](./ai-voice.md) — 声线目录（OIDB 0x929d_0：分组 / 中文名 / 样音）与语音合成（0x929b_0），样音不入库
- [发消息](./send-message.md) — `MessageSvc.PbSendMsg` + 富媒体上传（NTV2/highway）+ 文件（群/私聊，老 OIDB + highway）、元素类型表、MCP 工具与已知缺口
- [贡献指南](../../CONTRIBUTING.md)

---

[← 返回文档中心](../README.md)
