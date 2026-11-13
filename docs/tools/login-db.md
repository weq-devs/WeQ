# login.db 在线检查

`login.db` 是 QQ 的账号列表库，WeQ 打开启动页时读的就是它。它比消息库小得多，但**布局和
密钥来源跟消息库不一样**，也是「为什么我的号没出现在启动页」这类问题的第一现场。

<LoginDbInspector />

## 这两个值决定一切

| 值 | Android / iOS | 桌面端 |
| --- | --- | --- |
| 文件布局 | 页前有 1024 字节私有头 | 同样有 |
| 密钥 | `md5(md5(uid) + rand)`，可从文件头推 | 由 QQ 进程内存里的会话物料得到 |
| 算法组合 | 与消息库一致 | 页 / KDF HMAC 都要探测 |

## 在 WeQ 里读

针对本机的 `login.db`，直接走原生模块就行，不用自己解密：

```ts
// nt_helper 导出，返回值就是账号列表，不落临时明文文件
const algo = await nt.testDatabaseKey(loginDbPath, key); // 先探测算法组合
if (algo.success) {
  const accounts = nt.decryptLoginDb(loginDbPath, {
    pageHmacAlgorithm: algo.pageHmacAlgorithm,
    kdfHmacAlgorithm: algo.kdfHmacAlgorithm,
  });
  // accounts: uin / uid / avatarUrl / userName / a1Key / lastLoginAt
}
```

`decryptLoginDb` 走的是 offset VFS：**不产出明文文件**，读出来的就是 `login_table` 的行。
需要固定布局的明文库时，才用 `fastDecryptDatabase` / `safeDecryptDatabase`。

::: info

Linux / macOS 上的 `login.db` 有两份：

- `<数据根>/global/nt_db/login.db`（主，较大）
- `<数据根>/nt_qq/global/nt_db/login.db`（备，较小）

WeQ 两份都读，合并时优先主库。只读一份会出现「号少了几个」的现象。

:::

## 相关

- [login.db 表结构](/database/login) —— `login_table` 的列
- [凭据管理](/guide/wonderful-tools) —— 密钥扫描、其它设备密钥
- [数据库解密流程](/develop/principles/db-decrypt)
