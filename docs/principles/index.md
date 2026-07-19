# Native 原理

## 关于闭源

WeQ 的 `native` 部分闭源，**唯一原因是防止倒卖**（本项目为免费开源工具，谢绝二次贩卖）。
这不代表我们想隐藏技术细节 —— 本章节完整公开 native 层的实现原理，供学习与研究。

## 原理章节

- [数据库主密钥提取](./key-extraction.md) — 直接发包 / hook 收包函数
- [数据库解密流程](./db-decrypt.md) — SQLCipher / login.db
- [头像 Hash 定位公式](./avatar-hash.md) — 本地头像文件名如何计算
- [Native / JS 边界与打包](./native-boundary.md) — 原生模块的边界约定与坑

---

[← 返回文档中心](../README.md)
