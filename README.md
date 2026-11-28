<p align="center">
  <img src="./resources/brand/banner.png" alt="WeQ" width="860">
</p>

<p align="center">
  <a href="https://github.com/weq-devs/WeQ/releases/latest"><img src="https://img.shields.io/github/v/release/weq-devs/WeQ?label=%E6%9C%80%E6%96%B0%E7%89%88%E6%9C%AC&color=2f6feb" alt="最新版本"></a>
  <a href="https://github.com/weq-devs/WeQ"><img src="https://img.shields.io/github/stars/weq-devs/WeQ?label=GitHub&color=4b5563" alt="GitHub Star"></a>
  <a href="https://weq-devs.github.io/WeqDocs/guide/supported-versions"><img src="https://img.shields.io/badge/%E5%B9%B3%E5%8F%B0-Windows%20%C2%B7%20macOS%20%C2%B7%20Linux-0f766e" alt="支持平台"></a>
  <a href="https://weq-devs.github.io/WeqDocs/"><img src="https://img.shields.io/badge/%E6%96%87%E6%A1%A3-WeqDocs-7c3aed" alt="文档站"></a>
</p>

<h3 align="center">把 QQ 聊天记录留在自己电脑上的浏览、导出与分析工具</h3>

<p align="center">
  直接打开本机 QQ 账号或导入备份，按会话回看历史消息，<br>
  搜索、整理、导出记录，也可以生成聊天分析与年度报告。
</p>

<p align="center">
  <a href="https://github.com/weq-devs/WeQ/releases"><b>下载桌面版</b></a> ·
  <a href="https://weq-devs.github.io/WeqDocs/guide/getting-started">快速上手</a> ·
  <a href="https://weq-devs.github.io/WeqDocs/">文档站</a> ·
  <a href="https://qm.qq.com/q/ysMZoAcC1a">QQ 交流群</a>
</p>

![WeQ 聊天界面](./.github/readme-assets/chat.png)

## 概览

- **本机处理**　聊天记录直接来自本机 QQ 数据库或你导入的备份，浏览、搜索和导出都在自己的电脑上完成。
- **一份数据，多种去处**　浏览、导出和分析共用已打开的账号或备份，不需要重复导入。
- **多端可用**　桌面版内置浏览器入口，另有独立 Web 部署和手机端 WeQ Remote。

## 开始使用

1. 从 [Releases](https://github.com/weq-devs/WeQ/releases) 下载适合你电脑的安装包并启动 WeQ。
2. 在账号主页选择「添加本机 QQ 账号」或「导入 QQ 备份」。
3. 按提示打开账号，在消息列表里选择一个会话。

| 平台 | 架构 | 安装包 |
| --- | --- | --- |
| Windows | x64 | `weQ-<版本>-setup.exe` |
| macOS | Apple 芯片 / Intel | `weQ-<版本>-mac-arm64.dmg` / `-mac-x64.dmg` |
| Linux | x64 / arm64 | `weQ-<版本>-linux-*.AppImage`、`tar.gz`，或 [AUR](https://weq-devs.github.io/WeqDocs/guide/arch-install) |

macOS 首次打开需在「隐私与安全性」中放行，详见 [macOS 安装](https://weq-devs.github.io/WeqDocs/guide/macos-install)。

首次使用、密钥获取和权限问题见[快速上手](https://weq-devs.github.io/WeqDocs/guide/getting-started)，各平台已验证的 QQ 版本见[支持的 QQ 版本](https://weq-devs.github.io/WeqDocs/guide/supported-versions)。

## 浏览、导出与分析

- **浏览消息**　会话列表、私聊与群聊、搜索、媒体预览、防撤回和消息详情，见[消息页](https://weq-devs.github.io/WeqDocs/guide/chat-view)。
- **导出记录**　按会话与时间范围导出 HTML、TXT、XLSX、JSON 等格式，媒体与附加数据可一并归档，见[统一导出](https://weq-devs.github.io/WeqDocs/guide/export)。
- **分析数据**　活跃时段、消息趋势、成员互动与年度报告，见[聊天分析与年度报告](https://weq-devs.github.io/WeqDocs/guide/analytics)。
- **其他内容**　联系人、群资料、空间、邮箱、收藏与装扮资源，见[功能参考](https://weq-devs.github.io/WeqDocs/guide/features)。

| 聊天记录导出 | 年度报告 |
| --- | --- |
| ![选择导出范围、格式和媒体](./.github/readme-assets/export.png) | ![WeQ 年度报告封面](./.github/readme-assets/annual-report.png) |

微信聊天记录的导出和分析可使用 [WeChatDataAnalysis](https://github.com/LifeArchiveProject/WeChatDataAnalysis)。

## 在浏览器和手机上使用

- **桌面版内置 Web**　电脑上已运行 WeQ 时，从「设置 → 服务 → 浏览器访问」打开本机浏览器入口，手机也能访问这份数据。
- **独立 WeQ Web**　适合 NAS、服务器或 WSL 等无桌面环境，见[独立部署说明](./apps/web/README.md)。
- **WeQ Remote**　用手机与电脑配对，浏览电脑里的记录，见[手机端仓库](https://github.com/weq-devs/WeQ-Remote)。

内置 Web 与手机配对的跨网连接、HTTPS 入口见 [Web 服务与手机连接](https://weq-devs.github.io/WeqDocs/guide/remote-web)。

## 参与开发

```sh
git clone --branch dev --recurse-submodules https://github.com/weq-devs/WeQ.git
cd WeQ
pnpm dev
```

环境要求、启动选项和 native 构建见[开发启动说明](https://weq-devs.github.io/WeqDocs/develop/dev-startup)。提交代码前请阅读[贡献指南](./CONTRIBUTING.md)，分支、Commit 与 PR 目标以其中说明为准。

## 社区与项目说明

[问题反馈](https://github.com/weq-devs/WeQ/issues) · [QQ 交流群](https://qm.qq.com/q/ysMZoAcC1a) · [更新日志](./CHANGELOG.md) · [免责声明与使用说明](https://weq-devs.github.io/WeqDocs/guide/disclaimer) · [许可协议](./LICENSE)

感谢 [NapNeko 团队](https://github.com/NapNeko)、[webark-im-template](https://github.com/dogxii/webark-im-template)、[QQBackup](https://github.com/QQBackup) 和所有 [WeQ 贡献者](https://github.com/weq-devs/WeQ/graphs/contributors)提供的实现参考、聊天界面模板和资料。
