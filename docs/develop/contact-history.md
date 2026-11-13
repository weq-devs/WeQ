# 联系人与群资料历史

## 接入方式

`ContactDirectoryRuntime` 为账号创建一个 `ContactHistoryService`，安装共享 service 实例的只读方法包装。桌面、Web、Remote 和 MCP 复用这些实例，不在各路由重复保存。接入清单以 `packages/service/src/account/contact_history_capture.ts` 的 `CONTACT_HISTORY_CAPTURE` 为准，增加资料读取方法时同步补清单及回归用例。

| 入口 | 保存内容 | 回读与测试 |
| --- | --- | --- |
| ProfileService | 本地资料、好友、昵称、机器人、分类及申请的实际返回字段 | 普通资料缺失或离线读取失败可回退；批量结果另按实体保存；清单逐入口测试 |
| PeerStats / ProfileExtras | 等级、获赞、QQ 秀、详情、能量、学校、历史签名、标签、照片和问答及其分页字段 | 按相同目标、来源及请求范围读取；未返回或不适用的获赞不回填历史数值 |
| AccountWrite 的读取方法 | 云端名称、共同关系、好友来源、普通备注名、通知偏好、本人资料与展示设置、好友目录 | 不包装写方法，不把 accepted 或 unconfirmed 当作资料；内部确认回读同样留存 |
| GroupInfo | 群资料、扩展资料、名单、群名片、等级、通知偏好、成员检索、公告与精华资料 | 在线名单完整翻页结束才标记完整；局部名单和分页不会代表成员退出 |
| WebQuery | 群公告与荣誉、精华列表、装扮、互动标识、空间资料统计、昵称及群相册元数据 | 不下载媒体；不接入完整空间动态库 |
| ChatQqShow 的实际获取回调 | 在线读取的完整 QQ 秀结果，而非裁剪后的聊天展示字段 | 缓存命中不重新观察；嵌套回调通过同一清单接入 |
| GroupFile / GroupAlbumMedia / GroupGift | 已读取的群文件目录与容量、相册条目引用、礼物面板 | 只保存业务结构及媒体引用，不复制文件本体 |
| OnlineStatus / GroupNotify | 已读取的状态、通知与申请 | 状态只留存，不以旧在线状态代替当前空结果或错误 |
| ContactMetrics | 各指标成功取得的值、当前状态与时间 | 原快照接口不变；当前投影移除某项不删除历史 |

包装保持原函数属性，内部 `this.method()` 也经过同一路径。正常返回使用有界异步缓冲，后台合批写入；缓冲满时背压。数据在接受观察时固定，调用方随后修改返回对象不会改变已观察内容。保存失败在状态中报告并保留待重试批次，刷盘时重试；不会把保存失败伪装成查询失败。

群扩展资料读取会另外保存同次已解码的完整入群资料；群消息策略查询会保存同次返回的全部群策略，不只保存当前页面选中的一条。原有内部读取回调可能在返回前裁剪数据，这类入口须在裁剪前留存。

在线读取失败继续报告原错误，不用旧缓存冒充刷新成功。账号离线时，已保存的同目标／同范围业务资料可回退。缓存回读和群成员 60 秒内存命中不新增观察。会话名称仍以本地为准，历史接口不修改 QQ 原库或会话名称缓存。

## 存储格式

账号路径保持 `contacts/<configId>/<uin>/`，新增 `history.sqlite`。SQLite 在独立 worker 运行，使用 Node 自带模块；无需安装额外数据库原生扩展或重编 nt_helper。

兼容最低 Node 22.12 时，仅为该 worker 启用 `--experimental-sqlite`，且不使用当时尚不存在的 `StatementSync.iterate()`；读取采用有界 SQL 分页。依据为 [Node 22.12 SQLite 官方接口](https://nodejs.org/download/release/v22.12.0/docs/api/sqlite.html)。

- `content` 保存按规范化内容计算 SHA-256 的数据。数组条目分别去重，根内容保存顺序引用；Brotli 压缩仅在更小时采用，压缩和数据库操作不占主线程。
- `versions` 保存实体、类别、来源、分页范围、完整性、首次与最近观察时间、原始内容和有效资料的引用。部分字段在有效资料中按字段补全，明确 `null` 仍表示清空；原始部分回包单独保留。
- 相同连续内容更新最近观察时间，不新增版本；A → B → A 保留三段观察，但 A 内容只保存一次。迟到观察按其时间进入历史，并重建必要的后继资料，不覆盖较新的状态。
- `aliases` 仅在返回资料中取得 UID／QQ 号对应关系后关联身份。群名片保留群上下文，不替换全局昵称。
- `projections` 保存现有指标接口需要的当前状态；只更新内容变化的行，不反复重写全量 JSON 文件。历史不再受旧的两万条裁剪限制。
- BigInt、二进制、Map、Set、Date、undefined 采用可逆类型封装；普通业务字段名与类型标记冲突时进行转义。列表顺序默认有意义，完整群名单按身份规范化后去重。

历史查询按观察时间及版本 ID 倒序游标分页。时间是 WeQ 实际观察时间，不代表远端真正修改时间。WAL 定期检查点，写入空闲后截断，关闭时增量回收空闲页；不按年龄或条数删除有效历史。

## 迁移与查询

迁入原有 `metrics.json`、`group-profiles/*.json`、`group-members/*.json`，保留已有字段、状态与时间。逐项回读校验、记录文件内容指纹后移除对应旧文件；中断后可重试。异常文件、校验失败文件及迁移期间更新的文件保留原件并报告。旧格式原本已经覆盖掉的数据无法从当前缓存恢复。

`account.contactMetrics.history` 提供账号绑定的 `list`、`categories`、`version`、`diff`、`status`。版本查询同时校验实体归属；`value` 是该次观察对应的有效资料，部分回包有差异时另带 `observedValue`。历史记录查询只读本地存储，不刷新 QQ 资料；历史图片复用现有媒体缓存与下载链路，链接失效时保留引用并提示不可用。历史目录在空间统计中单列，不属于普通可再生缓存。

针对性测试：`pnpm --filter @weq/service exec vitest run test/contact_history.test.ts test/contact_metrics.test.ts test/group_profile.test.ts`。浏览器夹具为 `apps/desktop/test/browser/run-contact-history.mjs`；可通过 `WEQ_PLAYWRIGHT_IMPORT`、`WEQ_BROWSER_EXECUTABLE` 和 `WEQ_CONTACT_HISTORY_ARTIFACTS` 复用本机 Playwright、浏览器及截图目录。
