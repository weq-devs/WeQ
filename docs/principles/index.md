# Native 原理

## 关于闭源

WeQ 的 `native` 部分闭源，**唯一原因是防止倒卖**（本项目为免费开源工具，谢绝二次贩卖）。
这不代表我们想隐藏技术细节 —— 本章节完整公开 native 层的实现原理，供学习与研究。

## 原理章节

- [商城表情的解密](./mface-decrypt.md) — 本地 XOR 混淆、QQTEA、密钥派生与爆破
- [数据库解密流程](./db-decrypt.md) — SQLCipher / login.db
- [头像 Hash 定位公式](./avatar-hash.md) — 本地头像文件名如何计算
- [QQ 私有字体 FTF 分析与转换](./ftf2ttf.md) — `FTFH`/`FTFG` 表、坐标压缩、还原成合法 TTF
- [Native / JS 边界与打包](./native-boundary.md) — 原生模块的边界约定与坑
- [macOS NineBird 安装](./ninebird-macos.md) — 入口补丁 + 进程内 hook + 提权设计
- [gpro 频道库密钥](./gpro-database.md) — 频道数据库的独立密钥派生

> 数据库**主密钥提取**的两条路线（nt_helper / ninebird）不再单独成篇；
> 相关接口见 [nt-helper.node 接口文档](../develop/nt-helper-interface.md)。
> 防撤回 / 删除消息的原理也不再写。

---

[← 返回文档中心](../README.md)
