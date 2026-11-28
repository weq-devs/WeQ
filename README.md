<p align="center">
  <img src="./resources/brand/banner.png" alt="WeQ" width="860">
</p>

<p align="center">
  <a href="https://github.com/weq-devs/WeQ/releases/latest"><img src="https://img.shields.io/github/v/release/weq-devs/WeQ?style=flat-square&label=%E6%9C%80%E6%96%B0%E7%89%88%E6%9C%AC&color=2563eb&labelColor=1e293b" alt="最新版本"></a>
  <a href="https://github.com/weq-devs/WeQ"><img src="https://img.shields.io/github/stars/weq-devs/WeQ?style=flat-square&label=Stars&color=2563eb&labelColor=1e293b" alt="GitHub Stars"></a>
  <a href="https://weq-devs.github.io/WeqDocs/guide/supported-versions"><img src="https://img.shields.io/badge/%E5%B9%B3%E5%8F%B0-Windows%20%C2%B7%20macOS%20%C2%B7%20Linux-0284c7?style=flat-square&labelColor=1e293b" alt="支持平台"></a>
  <a href="https://weq-devs.github.io/WeqDocs/"><img src="https://img.shields.io/badge/%E6%96%87%E6%A1%A3-WeqDocs-0f766e?style=flat-square&labelColor=1e293b" alt="文档站"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/%E8%AE%B8%E5%8F%AF-CC%20BY--NC--SA%204.0-475569?style=flat-square&labelColor=1e293b" alt="许可协议"></a>
</p>

<h2 align="center">把 QQ 聊天记录留在自己电脑上的浏览、导出与分析工具</h2>

<p align="center">
  直接打开本机 QQ 账号或导入备份，按会话回看历史消息，<br>
  搜索、整理、导出记录，也可以生成聊天分析与年度报告。
</p>

<p align="center">
  <a href="https://github.com/weq-devs/WeQ/releases"><b>下载桌面版</b></a> ·
  <a href="https://weq-devs.github.io/WeqDocs/guide/getting-started">快速上手</a> ·
  <a href="https://weq-devs.github.io/WeqDocs/">文档站</a> ·
  <a href="./CHANGELOG.md">更新日志</a> ·
  <a href="https://qm.qq.com/q/ysMZoAcC1a">QQ 交流群</a>
</p>

<br>

<p align="center">
  <img src="./.github/readme-assets/chat.png" alt="WeQ 聊天界面" width="920">
  <br>
  <sub>桌面端主界面：还原私聊与群聊气泡、字体、挂件、搜索与群资料面板</sub>
</p>

<br>

## 为什么选择 WeQ

<table>
  <tr>
    <td width="33.3%" valign="top">
      <b>本机处理</b><br><br>
      直接读取本机 QQ 数据库或你导入的备份，浏览、搜索、导出与分析全部在自己的电脑上完成。
    </td>
    <td width="33.3%" valign="top">
      <b>一份数据，多种去处</b><br><br>
      浏览、导出与统计共用已打开的账号或备份，不需要重复导入，也不必额外维护多份副本。
    </td>
    <td width="33.3%" valign="top">
      <b>多端可用</b><br><br>
      桌面版内置浏览器入口，同时提供独立 Web 部署与手机端 WeQ Remote，随时查阅本机记录。
    </td>
  </tr>
</table>

## 功能与预览

| 模块 | 主要能力 | 说明文档 |
| --- | --- | --- |
| **浏览消息** | 会话列表、私聊与群聊、气泡与装扮还原、全文搜索、媒体预览、防撤回与消息详情 | [消息页](https://weq-devs.github.io/WeqDocs/guide/chat-view) |
| **导出记录** | 按会话与时间范围导出 HTML、TXT、XLSX、JSON、CSV 等格式，支持增量归档与媒体随包导出 | [统一导出](https://weq-devs.github.io/WeqDocs/guide/export) |
| **分析与年报** | 私聊与群聊活跃时段、消息趋势、成员互动统计，以及可全屏播放的年度报告 | [聊天分析与年度报告](https://weq-devs.github.io/WeqDocs/guide/analytics) |
| **扩展内容** | 联系人、群资料、QQ 空间、QQ 邮箱、收藏与装扮资源管理 | [功能参考](https://weq-devs.github.io/WeqDocs/guide/features) |

<table>
  <tr>
    <td width="50%" align="center" valign="top">
      <img src="./.github/readme-assets/export.png" alt="选择导出范围、格式和媒体">
      <br>
      <sub><b>统一导出</b>：按时间范围、多格式与媒体选项灵活归档</sub>
    </td>
    <td width="50%" align="center" valign="top">
      <img src="./.github/readme-assets/annual-report.png" alt="WeQ 年度报告封面">
      <br>
      <sub><b>年度报告</b>：全部在本机计算的聊天回忆与互动概览</sub>
    </td>
  </tr>
</table>

> [!TIP]
> 微信聊天记录的导出和分析可使用 [WeChatDataAnalysis](https://github.com/LifeArchiveProject/WeChatDataAnalysis)。

## 快速开始

1. 从 [Releases](https://github.com/weq-devs/WeQ/releases) 下载适合你电脑的安装包并启动 WeQ。
2. 在账号主页选择「添加本机 QQ 账号」或「导入 QQ 备份」。
3. 按提示打开账号，在消息列表里选择一个会话即可开始浏览。

| 平台 | 架构 | 安装包 |
| --- | --- | --- |
| **Windows** | x64 | `weQ-<版本>-setup.exe` |
| **macOS** | Apple 芯片 / Intel | `weQ-<版本>-mac-arm64.dmg` / `weQ-<版本>-mac-x64.dmg` |
| **Linux** | x64 / arm64 | `weQ-<版本>-linux-*.AppImage`、`tar.gz`，或 [AUR](https://weq-devs.github.io/WeqDocs/guide/arch-install) |

> [!NOTE]
> - macOS 首次打开需在「隐私与安全性」中放行，详见 [macOS 安装](https://weq-devs.github.io/WeqDocs/guide/macos-install)。
> - 首次使用、密钥获取和权限问题见[快速上手](https://weq-devs.github.io/WeqDocs/guide/getting-started)，各平台已验证的 QQ 版本见[支持的 QQ 版本](https://weq-devs.github.io/WeqDocs/guide/supported-versions)。

## 在浏览器和手机上使用

| 方式 | 适用场景 | 入口与文档 |
| --- | --- | --- |
| **桌面版内置 Web** | 电脑已运行 WeQ，希望通过本机或局域网浏览器访问同一份数据 | 「设置 → 服务 → 浏览器访问」 · [Web 服务与手机连接](https://weq-devs.github.io/WeqDocs/guide/remote-web) |
| **独立 WeQ Web** | NAS、服务器或 WSL 等无桌面环境 | [独立部署说明](./apps/web/README.md) |
| **WeQ Remote** | 手机与电脑配对，在移动端浏览电脑里的聊天记录 | [WeQ-Remote 仓库](https://github.com/weq-devs/WeQ-Remote) |

内置 Web 与手机配对的跨网连接、HTTPS 入口配置见 [Web 服务与手机连接](https://weq-devs.github.io/WeqDocs/guide/remote-web)。

## 参与开发

```sh
git clone --branch dev --recurse-submodules https://github.com/weq-devs/WeQ.git
cd WeQ
pnpm dev
```

环境要求、启动选项和 native 构建见[开发启动说明](https://weq-devs.github.io/WeqDocs/develop/dev-startup)。提交代码前请阅读[贡献指南](./CONTRIBUTING.md)，分支、Commit 与 PR 目标以其中说明为准。

## 社区与致谢

- **项目链接**：[问题反馈](https://github.com/weq-devs/WeQ/issues) · [QQ 交流群](https://qm.qq.com/q/ysMZoAcC1a) · [更新日志](./CHANGELOG.md) · [免责声明与使用说明](https://weq-devs.github.io/WeqDocs/guide/disclaimer) · [许可协议](./LICENSE)
- **致谢**：感谢 [NapNeko 团队](https://github.com/NapNeko)、[webark-im-template](https://github.com/dogxii/webark-im-template)、[QQBackup](https://github.com/QQBackup) 和所有 [WeQ 贡献者](https://github.com/weq-devs/WeQ/graphs/contributors)提供的实现参考、聊天界面模板和资料。

---

<p align="center">
  <sub>WeQ 为非腾讯官方项目，遵循 <a href="./LICENSE">CC BY-NC-SA 4.0</a> 许可协议发布。</sub>
</p>
