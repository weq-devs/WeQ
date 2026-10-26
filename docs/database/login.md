# login.db — 登录账号列表

`login.db` 是**账号级全局库**（不属于任何单个账号目录）：
QQ 在这台机器上登录过的所有账号的快照列表，是 WeQ 列出本地账号的首要数据源。

对应 WeQ 解析实现：

| 文件 | 职责 |
| ---- | ---- |
| `packages/native`（Rust `nt_helper`） | `decryptLoginDb`：解密 + 解析出行 |
| `packages/service/src/bootstrap/login_db.ts` | `LOGIN_DB_KEY` 固定密钥、逐库探测和按 uin 合并 |
| `packages/service/src/account/db_decrypt.ts` | `isLoginDb` 判定与解密导出 |
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
   `LOGIN_DB_KEY` 定义在 `bootstrap/login_db.ts`，解密导出复用该常量。
   加密参数（pageHmac/kdfHmac 算法）仍需 `testDatabaseKey` 探测；
3. **解析在 native 层**：走 Rust 的 `decryptLoginDb(path, algo)` 直接返回行对象，
   不是像其它库那样拿 SQL 句柄自己查 —— 解析逻辑写在
   `nt_helper/src/detect/login_db.rs`。通用 SQL 工具（`executeSqlWithKey`）也能开它。

自动发现只读取 `login.db`，没有 NineBird 快速登录列表或端口探测兜底。
各候选库按优先级解密并合并；全部缺失或解密失败时返回空列表，不会为了枚举账号启动 QQ。
这不表示已保存的 WeQ 账号配置或手动导入的静态来源会被删除。

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

> `a1Key` 可能为空或过期；读到账号行不等于快速登录凭据可用，不在日志或反馈中附上它。

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
