# 原理总览

这一组页面只讲**结论**：QQ 的本地数据是怎么加密的、口令从哪来、WeQ 用什么办法绕过去。
够你判断「这块能不能碰、该调哪个接口」，也够你复核一个派生结果对不对。

::: tip 这里不讲什么

- 不贴反汇编、调试器脚本或二进制截图。需要复现时看代码：`packages/native` 和
  `../nt_helper/src/` 里的实现就是最准的说明。
- 不写「我是怎么试出来的」的过程。过程留在 Issue / PR 里，文档只留能长期用的结论。

:::

## 页面

| 页面 | 讲清的结论 |
| --- | --- |
| [数据库解密流程](./db-decrypt.md) | SQLCipher v4 + 1024 字节私有头；三条取密钥路径；页 / KDF HMAC 是两个独立维度；读库与落盘怎么选 |
| [商城表情的解密](./mface-decrypt.md) | 本地缓存是 XOR 混淆（无密钥）；CDN 加密流是 QQTEA；密钥 = `md5(时间戳)` 前 16 位 |
| [头像 Hash 定位公式](./avatar-hash.md) | `md5(md5(md5(uid)+uid)+uid)`，以及大图 / 缩略图不同步的判据 |
| [gpro 频道库密钥](./gpro-database.md) | 频道库是另一套派生，且算法组合与常见消息库不同 |
| [QQ 私有字体 FTF 与 TTF](./ftf2ttf.md) | `FTFH` / `FTFG` 两张私有表，以及还原成合法 TTF 要修什么 |

## 可以自己验算的部分

有两个公式完全离线可复现，文档站里做成了工具：

- [手机数据库密钥计算](/tools/db-key) —— 输入 uid 和 `rand`，直接出 `nt_msg.db` 的口令
- [gpro 频道库密钥计算](/tools/db-key#gpro-频道库) —— 输入 QQ 号和 16 字符盐值
- [商城表情密钥](/tools/marketface) —— 时间戳与 `encryptKey` 的互查

其余的（桌面端 raw key、gpro 的算法组合）都需要真实库才能验证，请用 WeQ 的
[密钥扫描 / 数据库修复](/guide/wonderful-tools)去测。

## 相关

- [nt_helper.node 接口文档](/develop/nt-helper-interface) —— 这些能力对应的原生函数
- [数据库一览](/database/) —— 各库的表结构
