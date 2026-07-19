![banner](./resources/brand/banner_v2.png)

![GitHub Repo stars](https://img.shields.io/github/stars/H3CoF6/WeQ?style=flat-square)![GitHub forks](https://img.shields.io/github/forks/H3CoF6/WeQ?style=flat-square)![GitHub issues](https://img.shields.io/github/issues/H3CoF6/WeQ?style=flat-square)![GitHub pull requests](https://img.shields.io/github/issues-pr/H3CoF6/WeQ?style=flat-square)![GitHub all releases](https://img.shields.io/github/downloads/H3CoF6/WeQ/total?style=flat-square)

**WeQ** 是一个 NTQQ 自主的本地消息数据库解密、解析与导出工具。

---

> [!Warning] 
>
> 本项目通过**直接发包**，或者**hook收包函数**等方式，提取数据库主密钥，注意相关风险
>
> *本项目仅用于个人数据的本地备份与分析，请勿用于任何违法用途。*

---

## ✨ 功能截图

| 高仿QQ聊天页面 | 隐私化展示 |
| -------------- | ---------- |
| ![image-20260719010909884](./docs/images/image-20260719010909884.png) | ![image-20260719011107158](./docs/images/image-20260719011107158.png) |
| **导出为各类格式** | **QQ收藏查看导出** |
| ![image-20260719011244024](./docs/images/image-20260719011244024.png) | ![image-20260719011358310](./docs/images/image-20260719011358310.png) |
| **完整数据库查看** | **本地消息的修改和新增** |
| ![image-20260719011458352](./docs/images/image-20260719011458352.png) | ![image-20260719011603014](./docs/images/image-20260719011603014.png) |
| **防撤回（无需weq运行）** | **查看QQ删除消息** |
| ![image-20260719011718608](./docs/images/image-20260719011718608.png) | ![image-20260719011941578](./docs/images/image-20260719011941578.png) |
| **群相册查看和导出** | **QQ空间查看和导出** |
| ![image-20260719012204330](./docs/images/image-20260719012204330.png) | ![image-20260719012503954](./docs/images/image-20260719012503954.png) |
| **群聊/私聊分析** | **好友亲密度排行** |
| ![image-20260719012335989](./docs/images/image-20260719012335989.png) | ![image-20260719012608790](./docs/images/image-20260719012608790.png) |
| **好友克隆 · 支持导出机器人** | **克隆好友群聊** |
| ![image-20260719012740048](./docs/images/image-20260719012740048.png) | ![image-20260719012944970](./docs/images/image-20260719012944970.png) |
| **完整QQ表情资源查看** | **导出html** |
| ![image-20260719013104790](./docs/images/image-20260719013104790.png) | ![image-20260719013242705](./docs/images/image-20260719013242705.png) |

> 完整功能请查看[使用手册](./docs/guide/index.md)，更多内容见 [文档中心](./docs/README.md)

## 使用方法

1. 前往 [Releases](../../releases) 下载最新版本
2. 按照引导操作获取数据库密钥 (**无需提前打开QQ**)
3. 打开对应账号即可开始使用

#### 开发者指南

> 
>强烈推荐使用 [pnpm](https://pnpm.io/)

```bash
pnpm i
pnpm dev
```

> 贡献代码请先阅读 [贡献指南](./CONTRIBUTING.md)  以及本项目[原理](./docs/principles/index.md) 作为参考

## 开源协议

本项目基于 [**CC BY-NC-SA 4.0**](./LICENSE)（知识共享 署名-非商业性使用-相同方式共享 4.0 国际）协议开源。这意味着你可以自由地使用、分享和修改本项目，但需遵守以下条款：

- **署名（BY）** —— 必须注明原作者及项目来源，并注明是否做了修改。
- **非商业性使用（NC）** —— **禁止用于任何商业用途**，包括但不限于付费贩卖、倒卖本项目或其衍生作品。
- **相同方式共享（SA）** —— 若你修改或基于本项目二次创作，衍生作品必须以**相同的 CC BY-NC-SA 4.0** 协议开源。

> [!Warning]
>
> 本项目为**免费开源**工具，谢绝任何形式的商业用途。若发现有人贩卖本项目，均为侵权行为。

## 致谢

-  [WeFlow](https://github.com/hicccc77/WeFlow)  && [WeChatDataAnalysis](https://github.com/LifeArchiveProject/WeChatDataAnalysis)  && [CipherTalk](https://github.com/ilovebinglu/CipherTalk)

- [NapNeko](https://github.com/NapNeko) —— **大量实现参考**
- [webark-im-template](https://github.com/dogxii/webark-im-template) —— QQ 聊天界面模板
- [QQBackup](https://github.com/QQBackup) —— 整理了大量QQ数据库相关信息

**同时也感谢每一个为WeQ及相关项目做出贡献的开发者**：

<a href="https://github.com/H3CoF6/WeQ/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=H3CoF6/WeQ" />
</a>

> [!important]
>
> 欢迎加入QQ群讨论，代码问题更建议在issue提出哦
>
> [![WeQ交流群](https://img.shields.io/badge/WeQ交流群-Join-blue)](https://qm.qq.com/q/ysMZoAcC1a)
> <img src="./docs/images/image-20260719193253644.png" alt="image-20260719193253644" style="zoom: 50%;" />
>
> > TG群组正在建设中

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=H3CoF6/WeQ&type=Date)](https://star-history.com/#H3CoF6/WeQ&Date)
