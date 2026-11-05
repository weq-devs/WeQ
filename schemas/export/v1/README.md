# WeQ Export v1 Schema

状态：**待实现设计**。这些文件尚未接入业务导出器。格式版本 `1.0` 与 WeQ 应用版本
无关。先读[设计理念](../../../docs/develop/export-format/README.md)。

## 入口

| 文件 | 校验对象 |
| --- | --- |
| archive.schema.json | 完整 JSON 正式归档 |
| stream.schema.json | 单条 JSONL 行，提交链和跨行规则须另外校验 |
| common.schema.json | 共享 Actor/Time/Content/Value/Observation/Resource/Native 等类型 |
| legacy.schema.json | 已登记历史属性名称、类型和解释状态约束 |
| archive-set.schema.json | 多账号/分区归档引用、跨归档关系和共享资源清单，不含正文 |
| message.basic/full.schema.json | 普通消息、数据线、服务号、公众号、频道私聊的单个 Record |
| qzone.basic/full.schema.json | 说说、评论回复、转发、相册和媒体 Record |
| collection.basic/full.schema.json | 八类收藏及未知类型 Record |
| mail.basic/full.schema.json | 每封邮件 Record |
| directory.basic/full.schema.json | 联系人、群、成员和分类 Record |
| generated.basic/full.schema.json | 本地克隆/助手消息 Record |
| resource-directory.basic/full.schema.json | 文件、相册、表情/装扮及现成产物目录 Record |

`basic/full` 表示两个独立文件，不是包含斜线的文件名。basic 文件的 `$defs.data` 是
领域基本字段；full 引用同一 data 定义，再增加 native。闭合对象用 unevaluatedProperties
实现跨 allOf 的写入检查，不能将 full 当作可附任意 raw 字段的宽松外壳。
闭合 writer schema 不等于 reader 遇到未知可选字段就拒绝：两条校验路径见下文。

所有 `$id` 使用 `https://weq.local/schemas/export/v1/` 标识命名空间，**不做网络请求**。
将全部 19 个 schema 一次注册到支持 Draft 2020-12 的校验器，再校验入口。
known attributes 的 Value 类型也由对应 full schema 检查；未知源字段使用 typed Value
保留，字段意义和互斥来源必须结合映射文档核验。

## 合成示例

- [basic.json](examples/basic.json)、[basic.jsonl](examples/basic.jsonl)
- [full.json](examples/full.json)、[full.jsonl](examples/full.jsonl)
- `examples/media/` 只有一个内容为 `abc` 加 LF 的 4 字节合成文本，包含真实 hash/size 回执。

每档 43 个 Record，覆盖 7 个领域及其当前子类型。JSON 与 JSONL 是用户显式同时选择
两种格式的示例，不表示运行时必须保存两份。两个档位使用不同 archiveId。文件中的账号、
地址、正文、模型和资源都为合成数据，example.invalid 不需访问。

新增 `historical-fixtures.mjs` 提供历史全量合成样例（测试同时投影 basic 并往返 JSONL），
含旧排版、未确认状态、日志/留言等新实体、资料快照、收藏关联键、旧 ID 与来源、
未知时间、UTF-16 码元及资源关系。codec/hash 是合成元数据，不是 SILK/WAV 实文件验收。
字段说明和最后要求逐项对照见[历史兼容契约](../../../docs/develop/export-format/historical.md)。

反例集中在 `contract.test.mjs`：每个测试将明确的一项有效输入改成无效输入并断言拒绝，
涵盖缺字段、错误类型、原始残余重复、悬空关系、坏提交等；不是把无效文件混入正例目录。

## 运行校验

在仓库根执行：

```bash
pnpm test:export-schema
pnpm exec biome check package.json schemas/export/v1
```

`conformance.mjs` 是只用于规范测试的参考模型，不由应用引用；实现了 schema 注册、
摘要与跨记录检查、JSONL 合成读写、投影和增量集合合并，**不是生产导出器或生产恢复工具**。
它在内存处理小型合成样本，不验证流式内存上限、原子文件替换或真实来源字段完整性。
根 devDependencies 显式登记已有锁文件中的 Ajv 8 / ajv-formats，未增加业务运行依赖。
Ajv 使用标准 schema 形状约束；关闭其跨 allOf 无法完整推断的 strictTypes 静态提示，
不关闭 strictSchema、实际类型校验、引用校验或反例。

## 兼容校验入口

- `validateArchive(document)` / `checkShape(name, value)`：严格 1.0 写入校验，拒绝未声明字段。
- `readArchive(document)`：兼容读取 1.x，仍检查必填、已知类型/枚举、档位、摘要与引用，
  返回原结构，不删除或修改未知属性。未知主版本拒绝。
- `decodeLog(text)` 默认兼容读取，仍严格检查 JSONL 行外壳、提交摘要、前链与顺序。
- `encodeLog(document, {mode:'read'})` / `appendObjects(base, addition, {mode:'read'})`
  用于参考模型验证无损往返/集合追加，保留版本、header、未知属性与观察/资源顺序；
  不是赋予旧 writer 生成未知版本内容的能力。省略 mode 仍执行严格写入检查。
- `validateArchiveSet(set, documents, {mode:'read'})` 同样保留集合属性并校验成员引用。
- `projectBasic` 只对已知 1.0 执行有损投影；未知小版本不擅自投影。

兼容读取用同一组 schema 派生 reader 校验器，只打开可选属性，不删除数据，不增加依赖。
新内容仍使用严格 writer 校验。时间精度与 base64 padding bits 由各自 schema 检查，
不根据任意未知 JSON 中恰好同名的字段猜类型。正式摘要包含 Record 除 revision 外全部
属性，含未知可选字段；JSONL 摘要包含完整内容行载荷。已有静态示例与摘要保持不变。

未来小版本夹具、数字键/浮点/Unicode 黄金向量、同时间及未知时间观察顺序、未知字段
往返和拒绝降级投影的测试位于 `contract.test.mjs`；不读取个人原件、不访问网络。
