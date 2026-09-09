# login.db — 登录账号列表

`login.db` 是**账号级全局库**（不属于任何单个账号目录）：
QQ 在这台机器上登录过的所有账号的快照列表，是 WeQ 列出本地账号的首要数据源。

对应 WeQ 解析实现：

| 文件 | 职责 |
| ---- | ---- |
| `packages/native`（Rust `nt_helper`） | `decryptLoginDb`：解密 + 解析出行 |
| `packages/service/src/account/db_decrypt.ts` | `LOGIN_DB_KEY` 固定密钥 + `isLoginDb` 判定 |
| `packages/service/src/bootstrap/win32_detect.ts` | 多路径合并的账号列表装配 |

---

## 一、定位与特殊性

和账号库相比，login.db 有三个特殊点：

1. **位置在全局目录，不在账号目录**：
   - Windows：`<TencentFiles>/nt_qq/global/nt_db/login.db`（单处）；
   - Linux / macOS：**两处**且都算数 ——
     `<root>/global/nt_db/login.db`（主，较大）+ `<root>/nt_qq/global/nt_db/login.db`
     （辅，较小），WeQ 按优先级合并去重（`findLoginDbs`）；
2. **SQLCipher 密钥是写死的常量**，不随账号变：
   `LOGIN_DB_KEY = 'BD156D6710D54D8782F4'`（`db_decrypt.ts`）。
   加密参数（pageHmac/kdfHmac 算法）仍需 `testDatabaseKey` 探测；
3. **解析在 native 层**：走 Rust 的 `decryptLoginDb(path, algo)` 直接返回行对象，
   不是像其它库那样拿 SQL 句柄自己查 —— 解析逻辑写在
   `nt_helper/src/detect/login_db.rs`。通用 SQL 工具（`executeSqlWithKey`）也能开它。

解密失败的兜底：WeQ 还有两条不依赖 login.db 的账号发现路径
（ninebird 快速登录列表的缓存 + 端口探测），login.db 挂了账号列表也不至于为空。

## 二、行结构（`LoginAccount`）

每行 = 一个在这台机器登录过的账号：

| 字段 | 类型 | 含义 |
| ---- | ---- | ---- |
| `uin` | string | QQ 号 |
| `uid` | string | 长 uid（协议路由用，即账号目录名派生所用的 uid） |
| `avatarUrl` | string | 缓存的头像 CDN URL（可能已 404） |
| `userName` | string | 账号设置的显示名 |
| `a1Key` | string | A1 凭据缓存（可能为空串） |
| `lastLoginAt` | number | 最后登录时间，unix 秒；从没登录成功过为 0 |

> `a1Key` 只有 native 的 `LoginAccount` 才可能带；ninebird 的快速登录列表
> 没有它，这是两条数据源的主要字段差异。

## 三、WeQ 的用法

- **账号发现**：解出全部行 → 去重合并 → 对每个 uin 推导账号目录
  （`nt_qq_<md5(md5(uid) + "nt_kernel")>` 规则，见静态账号密钥推导）；
- **登录历史**：`lastLoginAt` 用于排序/展示；
- **db_explorer**：`login.db` 也在数据库浏览器可开清单里（`isLoginDb` 命中即用固定密钥），
  密钥不对时明确报「login.db 密钥不正确」；
- **导出解密**：`fastDecryptDatabase` 清单里 login 是独立一类（kind `'login'`）。

表名/表结构 QQ 未公开且 WeQ 走 native 结构化解析，字段级 SQL 文档从略。

---

[← 返回数据库分析](./index.md)
