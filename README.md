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

## ✨ 功能

| 高仿QQ聊天页面            | ![image-20260719010909884](./docs/images/image-20260719010909884.png) | 隐私化展示               | ![image-20260719011107158](./docs/images/image-20260719011107158.png) |
| ------------------------- | ------------------------------------------------------------ | ------------------------ | ------------------------------------------------------------ |
| **导出为各类格式**        | ![image-20260719011244024](./docs/images/image-20260719011244024.png) | **QQ收藏查看导出**       | ![image-20260719011358310](./docs/images/image-20260719011358310.png) |
| **完整数据库查看**        | ![image-20260719011458352](./docs/images/image-20260719011458352.png) | **本地消息的修改和新增** | ![image-20260719011603014](./docs/images/image-20260719011603014.png) |
| **防撤回（无需weq运行）** | ![image-20260719011718608](./docs/images/image-20260719011718608.png) | **查看QQ删除消息**       | ![image-20260719011941578](./docs/images/image-20260719011941578.png) |
| **群相册查看和导出**      | ![image-20260719012204330](./docs/images/image-20260719012204330.png) | **QQ空间查看和导出**     | ![image-20260719012503954](./docs/images/image-20260719012503954.png) |
| **群聊/私聊分析**         | ![image-20260719012335989](./docs/images/image-20260719012335989.png) | **好友亲密度排行**       | ![image-20260719012608790](./docs/images/image-20260719012608790.png) |
| **好友克隆          支持导出机器人** | ![image-20260719012740048](./docs/images/image-20260719012740048.png) |**克隆好友群聊**|![image-20260719012944970](./docs/images/image-20260719012944970.png)|
| **完整QQ表情资源查看** | ![image-20260719013104790](./docs/images/image-20260719013104790.png) |**导出html**|![image-20260719013242705](./docs/images/image-20260719013242705.png)|

> 完整功能请查看[使用手册](./docs/usage.md)

## 使用方法

1. 前往 [Releases](../../releases) 下载最新版本
2. 按照引导操作获取数据库密钥 (**无需提前打开QQ**)
3. 打开对应账号即可开始使用

#### 开发者指南

> [!important]
>
>
> 强烈推荐使用 [pnpm](https://pnpm.io/)

```bash
pnpm i
pnpm dev
```

> 贡献代码请先阅读 [贡献指南](./contribution.md)  以及本项目[原理](./docs/develop.md) 作为参考

## 致谢

- **微信高仿 & 数据分析：** [WeChatDataAnalysis](https://github.com/LifeArchiveProject/WeChatDataAnalysis)

- **[NapNeko](https://github.com/NapNeko)** —— **大量实现参考**
- **[webark-im-template](https://github.com/dogxii/webark-im-template)** —— QQ 聊天界面模板
- **[QQBackup](https://github.com/QQBackup)** —— 整理了大量QQ数据库相关信息

**同时也感谢每一个为WeQ及相关项目做出贡献的开发者**：

<a href="https://github.com/H3CoF6/WeQ/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=H3CoF6/WeQ" />
</a>

> [!important]
>
> 欢迎加入QQ群讨论，代码问题更建议在issue提出哦
>
> [![WeQ交流群](https://img.shields.io/badge/WeQ交流群-Join-blue)](https://qm.qq.com/q/ysMZoAcC1a)
> <img src="./docs/images/image-20260719014708246.png" alt="image-20260719014708246" style="zoom:25%;" />
>
> > TG群组真正建设中

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=H3CoF6/WeQ&type=Date)](https://star-history.com/#H3CoF6/WeQ&Date)
