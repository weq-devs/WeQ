# 源码覆盖矩阵

状态：设计输入核对，2026-11-05。下表“已有”仅指当前源码中有读取/导出字段，**不是新
schema 已接入**。未读取真实 QQ 数据库、未发业务网络请求；外部返回的当前完整字段集
仍要由后续来源夹具与真机抽查核验，不能从 TypeScript 接口反推来源没有其他字段。

| 内容 | 当前源码入口（仓库相对路径） | 已有来源可读取/导出 | 新格式尚需补接 | 来源本身未提供/未核实 |
| --- | --- | --- | --- | --- |
| 普通消息 | packages/service/src/account/export/{types,message_source,json_meta_exporter}.ts | 身份、发送者、时间、渲染元素 | 全列枚举、codec前提取、已消费映射与未知残余；不只扩 ExportedMessage | 已丢数据库行、服务端已失效历史不可凭空恢复 |
| 消息原生属性 | packages/db/src/msg/{types,c2c,group}.ts；packages/codec/src/domain/msg/row_to_message.ts | msgRandom、clientSeq、类型等部分属性 | SELECT之外的列；sanitize移除字段、错误wire、尾字节 | 其他平台/QQ版本列需实际schema枚举，不假定固定 |
| 合并转发/漫游 | packages/service/src/account/export/{message_source,task_manager,forward_expand}.ts；account/forward.ts | 本地40900、在线转发、展开节点与漫游 | 递归原生属性、重复资源引用、来源版本关联 | 过期/不可访问卡片正文不保证取得 |
| 数据线/服务号/公众号 | packages/service/src/account/export/message_source.ts | 专用迭代来源 | 原生行属性及来源身份映射 | 不套普通私聊SQL或宣称全历史 |
| 频道私聊 | packages/db/src/guild/types.ts；packages/service/src/account/export/guild_source.ts | nodeId、tinyId、guildId、消息及装扮 | 频道全列和资料缓存残余、增量协议 | 非本地频道群聊不在当前读取范围 |
| 空间说说/互动 | packages/service/src/account/web/{qzone,qzone_interaction,qzone_detail}.ts；account/export/{qzone_export,qzone_history}.ts | 正文、原转发、评论回复、赞及原响应历史 | 解析前字段清单、按对象拆分页残余、JSONL、新版去重 | 日志/日记/留言板未接；缺失评论不能以计数补造 |
| 空间相册 | packages/service/src/account/web/qzone_album.ts；account/export/{qzone_albums,qzone_media_store}.ts | 相册、照片、视频及内容hash复用 | 相册/照片全字段、不同变体及父子schema | 视频可能只有封面，Live Photo分类不靠URL猜 |
| 收藏本地 | packages/db/src/collection/{collection,assemble}.ts | Author/PicInfo/FileInfo与八类summary | 全列、非schema字段、padding/未消费尾部；不经拍平行 | 本地只有摘要不证明全文可得 |
| 收藏网络与详情缓存 | packages/service/src/account/{collection_detail_store,collection_history,collection_media}.ts；account/export/collection_export.ts | 原始批次、详情、原件/预览回执 | 按CID切分、已知字段去重、全文正文与残余分离、JSONL | 未解析二进制详情中的附件尚不能证明枚举完整 |
| 邮箱 | packages/service/src/account/mail/{types,wire,client,export,attachments}.ts | 地址、主题、HTML、会话、目录、状态、附件 | wire转换前残余、原HTML/CID、结构化JSONL、目录/状态映射 | 原始完整头、MIME/EML未核实，不能承诺已有 |
| 联系人/群/成员 | packages/service/src/account/export/contacts_export.ts | FriendRow、MemberRow、GroupDirectoryRow字段 | 底层完整资料、未读列与blob、格式化字段逆映射禁止 | 目录不证明在线在群，未缓存资料不猜 |
| 本地生成对话 | packages/service/src/account/{generated_content,generated_search}.ts；account/export/{generated_export,generated_resources}.ts | 持久ID、角色、正文、steps/actions/mentions及已知资源 | 双档封装、模型等实际持久属性、未知步骤拆分 | 未持久流式消息、未保存模型过程不可重建 |
| 群文件/群相册 | apps/desktop/src/main/ipc/routers；packages/service/src/account/export/task_manager.ts | 目录/相册下载、resource-results与失败回执 | 冻结原目录字段、双档正式清单、资源来源观察 | 过期/无权限原件不保证取得 |
| 表情与装扮 | packages/service/src/account/export/{emoji_export,sysface_export,dress_export}.ts；account/favorite_emoji_export.ts | 本地/商城/收藏资源与分类 | 所有目录属性、variant、unknown字段及新schema | 商城目录不是已拥有/已下载清单 |
| 报告/机器人与生成附件 | packages/service/src/account/export/generated_resources.ts；apps/desktop/src/shared/analytics_export.ts；packages/service/src/account/agentlab_export.ts | 现成文件、导出元数据、附件句柄 | 复用resource-directory的文件及回执映射 | 不新增生成器/部署恢复，不把截图当原统计数据 |
| 当前增量/查看器 | packages/service/src/account/export/{message_journal,baseline,task_manager}.ts；apps/desktop/src/main/export_viewer.ts | 旧隐藏journal、基线目录扫描、各格式重建 | 正式JSON/JSONL直接读取、原位更新、批次链、旧格式导入、丢索引恢复 | 本轮未修运行实现、未验证真实断电/掉盘 |

## 全量覆盖的后续验收方法

1. 在来源提取层枚举所选记录的全部 SQL 列、protobuf 片段、JSON 叶字段及缓存附件变体，
   保留类型、出现次数和未消费区间的清单。不能只枚举“当前接口声明了哪些属性”。
2. 每个来源片段对账到规范化字段或残余；已知值有可核对的转换规则，未知片段字节相同。
   相同字段不得在两处重复保存；不同源值分版本。声明无信息的包装须给出具体规则。
3. 以含未知tag、重复tag、错误wire、损坏尾部、旧列和新列的合成来源做反例；黄金预期
   不复制当前渲染器输出，避免提取器与测试共享同一个“来源只有这些字段”的假设。
4. 确认精确范围不夹带未选对象；按字段、正文、附件分别结算。来源核验未完成时写
   unknown/partial，不将 schema 校验通过写成业务数据已经完整。
