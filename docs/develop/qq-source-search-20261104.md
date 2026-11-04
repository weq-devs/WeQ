# 复用 QQ 搜索索引

统一搜索使用 `SourceMsgSearchDb` 直接读取 `buddy_msg_fts.db` 与
`group_msg_fts.db`，不再实例化 `MsgSearchIndexDb`。没有整库解密、INSERT SELECT
建库或每会话水位写入。原类暂时保留以兼容旧工具，不是新业务入口。

## 查询

- 解析实际 FTS5 声明，验证内容表、列、整数主键、分词器及 docsize 键覆盖。
  `trigram` 与 `pinyin_letter 0` 分别处理，不按平台或库名推断分词器。
- native 只读连接注册 pinyin0 查询适配及 trigram 字面匹配函数。写连接不注册，
  查询分词器拒绝建文档索引。
- 对可用索引先取候选，再检查原文；正文/文件名范围保持各业务调用原有口径。
  不兼容的声明或缺失索引行使用原内容表，不启动另一份完整索引构建。
- external-content 的列读取交给 SQLite 解析，不把虚表 rowid 手工当成消息主键。
  虚表整数列没有普通表的类型亲和性，会话参数必须 `CAST(? AS INTEGER)`，
  否则跨 worker 的 bigint 字符串会造成空结果。
- 计数与分页使用同一 SQL 快照；相同时间以 41700 排序。schema_version 与文件
  身份变化会使在途响应失效，不把旧来源结果回写到新来源。
- 三字符及以上的精确回退采用 native 内置 trigram 折叠；短词沿用 LIKE 字面规则。
  标准 trigram 无法给单、双字符提供加速；这类查询仍可能扫描内容表。

## 运行

桌面与共享 Web 后端均从 app_context 注入独立 `sourceSearchWorker.mjs`。
读取基于现有 `runOwnedChild`：路径、密钥和参数经 stdin，bigint 经十进制字符串，
进程关闭后才释放请求。交互查询 10 秒、校验 120 秒上限，最多四个读取进程。
账号关闭会取消本来源拥有的进程；不会终止 QQ 或其它任务的进程。

`ensureIndexes()` 保留原调用接口，含义改为校验源能力。初次覆盖校验可能较慢，
后台运行；同一文件和 schema 不重复全量校验。不再要求 dataDir 存在才启用读取。
旧 native 没有这些函数时不创建新缓存，保留原 LIKE 回退并记录不可用原因。

native 变动需要重建 nt_helper；主进程/worker 变动需要重启 WeQ，不能只刷新渲染层。
QQ 不需要退出。版本号只按用户明确指令修改。

## 验证与状态

回归测试使用明文夹具和真实 SQL，覆盖大整数、跨 JSON 参数、文件范围、末页之外、
结构变化和未被索引的消息；service 与 worker 单独验证。
旧搜索缓存的退役以及实际空间释放单独验收，不将不再创建缓存冒称已删除旧文件。
