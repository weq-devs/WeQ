# WeQ 文档中心

> WeQ 是一个 NTQQ 自主的本地消息数据库解密、解析与导出工具。
> 本页是全部文档的导航入口，直接点击链接即可阅读。

使用手册与开发入口以当前分支源码为准，不表示已安装或发布。带日期的开发笔记保留当时的
方案、测量和验收结果；需要了解现状时，先查使用手册、主题入口及笔记中的后续说明。
已发布内容以 [CHANGELOG.md](../CHANGELOG.md) 对应版本为准。

## 使用手册

面向使用者，介绍每一项功能怎么用。

- [功能总览与快速上手](./guide/index.md)
- [macOS QQ 数据读取授权](./guide/macos-data-access.md)
- [性能监视与历史保存](./guide/performance-monitor.md)

## Native 原理

Native 部分闭源，但是原理完全公开。

- [原理总览](./principles/index.md)

## 数据库分析

NTQQ 各数据库的表结构与字段解析，全部依据 WeQ 自己的解析实现手写维护。

- [数据库分析入口](./database/index.md)

## 开发与贡献

面向贡献者，介绍项目架构、构建发版与贡献流程。

- [开发者入口](./develop/index.md)
- [性能监视采集、存储与验证](./develop/performance-monitor.md)
- [统一导出格式与内容范围（待实现）](./develop/export-format/README.md)
- [Web 服务与手机连接](./guide/remote-web.md)
- [本机浏览器与 Remote 入口解耦](./develop/web-remote-entry-decoupling-20261109.md)
- [OneBot / cc-connect](./guide/onebot-cc-connect.md)
- [后台服务与关闭/退出行为](./develop/background-services-close-behavior-20261030.md)
- [WeQ Remote 仓库边界](./develop/remote-repository-split-20261023.md)
- [贡献指南](../CONTRIBUTING.md)

---

> 欢迎在 [Issue](../../issues) 或 [交流群](https://qm.qq.com/q/ysMZoAcC1a) 反馈。
