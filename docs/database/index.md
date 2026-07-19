# 数据库分析

NTQQ 各数据库的**表结构与字段解析**主要维护在文档站项目 **[QQBackup/QQDecrypt](https://github.com/QQBackup/QQDecrypt)**（在线阅读：<https://qqbackup.github.io/QQDecrypt/>）。

WeQ 文档**不重复**收录通用表结构，仅维护与本项目实现强相关、且文档站尚未系统化的深度解析部分。

## 通用表结构（指向文档站）

各数据库已解密后的表结构、列含义，请前往文档站的「数据库解析」栏目查阅：

| 数据库             | 文档站链接                                                                              |
| ------------------ | --------------------------------------------------------------------------------------- |
| `nt_msg.db`        | <https://qqbackup.github.io/QQDecrypt/view/db_file_analysis/nt_msg.db>                   |
| `profile_info.db`  | <https://qqbackup.github.io/QQDecrypt/view/db_file_analysis/profile_info.db>             |
| `group_info.db`    | <https://qqbackup.github.io/QQDecrypt/view/db_file_analysis/group_info.db>               |
| `collection.db`    | <https://qqbackup.github.io/QQDecrypt/view/db_file_analysis/collection.db>               |
| `emoji.db`         | <https://qqbackup.github.io/QQDecrypt/view/db_file_analysis/emoji.db>                    |
| `login.db`         | <https://qqbackup.github.io/QQDecrypt/view/db_file_analysis/login.db>                    |
| 其它               | <https://qqbackup.github.io/QQDecrypt/view/db_file_analysis/>                            |

> 📌 数据库解密（取密钥、去文件头、SQLCipher 参数）同样见文档站的「数据库解密」栏目。

## WeQ 单独维护的深度解析

以下内容结构复杂、文档站仅有零散引用，由 WeQ 依据实际解析实现单独维护：

- [`nt_msg.db` 消息体解析（40800 / 40900）](./nt_msg/index.md)

---

[← 返回文档中心](../README.md)
