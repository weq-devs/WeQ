# 跨端偏好与功能状态

## 所有权与数据流

`@weq/service/client-preferences` 提供共享偏好类型、默认值、既有显示开关映射及旧键映射。全部设置共用同一来源，不提供设备覆盖模式。

省流量行为由 `dataSaverBehaviorDefaults` 定义，与 `dataSaverMode` 一同存入 `client` 组。图片档位为 `dataSaverImageLoading: none | thumbnail | original`；头像、表情、个性装扮、封面、屏幕外预取及链接预览分别使用独立布尔字段。任务使用 `dataSaverPauseBatch`、`dataSaverPauseLarge`、`dataSaverLargeMiB` 和 `dataSaverAutoResume`，阈值为 1–1048576 MiB 的整数。缺失字段沿用默认值，设置关闭时不禁用行为编辑；卡片恢复与页面恢复均覆盖这十二项。共享配置变更立即刷新宿主策略；各下载器、导出队列与媒体入口读取同一份行为策略，资源分类开关不由预取开关代替。关闭自动继续后策略解除仍等待手动操作，不伪装成用户手动暂停。

`dataSaverMode` 为 `auto | always | never`，缺省 `auto`，随 `client` 组同步、备份与重置。网络检测状态独立于偏好：`settings.networkCost` 返回宿主状态并接收可选的本端运行态，HTTP 请求携带稳定的浏览器来源标识以绑定任务，不上传为全局设置。旧 native／手机桥缺能力时返回 unknown。共享策略区分自动预取、小图、主动查看与批量任务；任务保存策略暂停原因，手动继续只放行对应任务。下载续写必须核对强 ETag 或 Last-Modified、Content-Range 与长度；没有可靠身份的分段不续写。
`UserConfigService` 与 `config.json` 是通用偏好的唯一持久来源。已有 AppSettings 字段保留原位置；客户端偏好、AI、邮箱、防撤回模式、装扮、年度报告、联系人排序与助手配置位于 `settings.sharedPreferences` 的相应组。`common/shared_preferences.ts` 集中声明组、对象规则字段、备份归属和完整快照默认值，复用各领域的归一化逻辑。
`ClientStateStore` 只保存业务状态与草稿，账号状态位于 `config/accounts/<configId>/client-state.json`；旧 `client-state/global.json` 只作为一次性迁移输入，不再参与显示、通知或写入。
大草稿正文位于同目录的 `client-state-drafts`，状态文件只保存版本；切换背景、更新已读及重读账号状态不会反复解析或重写所有正文。备份展开正文，导入的内联正文在下一次写入时转为分文件。
电脑随机同步标识单独保存为 `client-state/identity.json`，不随备份恢复，不使用文件路径推断电脑身份。

`clientState` 路由提供 snapshot、patch、seed、changed，以及携带 `expectedAccountUin` 和 `expectedAccountConfigId` 的账号状态和草稿接口。通用字段的旧账号路由转接全局来源；`settings` 提供不依赖账号的意图感知、邮箱、防撤回、助手、装扮和年度报告设置入口。

会话视图的 `allConversationsIncludeHidden`、`allConversationsIncludeDeleted` 是独立的共享布尔偏好，默认均为 `false`。搜索偏好使用版本 2 的来源／类型模型：旧模型首次归一化为全选，新模型保留显式空数组；该筛选不再读取左侧会话视图。当前打开的视图、返回入口、关键词和滚动位置仍是客户端现场，不随其他端导航改变。
Web 禁止自动 seed，主动 patch 不受此限制。桌面旧值仅允许宿主级初始化一次，且只补原始文件中缺失的字段；旧账号排序 seed 不再覆盖全局排序。状态删除标记仍占据对应键，避免旧端迁移复活状态。
成功写配置及恢复后 reload 均发布通知。设置修订号在宿主提交时单调递增，同字段按实际提交顺序生效；字段补丁不会用旧客户端整份快照覆盖其他字段。对象规则请求校验账号与数据源，群关键词和输入状态名单按当前对象合并，保留其他对象的最新规则。

应用只挂一份全局同步组件。订阅开始时补读快照，变化时失效对应查询；无高频全量轮询，也不为每条消息增加查询。
主题先使用本机已保存快照，异步校准不阻塞消息。主题色滑动保留即时预览，120 ms 合并发送；请求失败只保留未保存预览，必须显式重试。
共享快照以电脑标识隔离，账号缓存同时包含 uin 与 configId；深浅模式、隐私模式、截图开关及网页通知也通过共享偏好保存。localStorage 是启动快照和旧值迁移来源，不是另一份可覆盖共享设置的权威配置。

阅读交互、图片内存预算及其他 AppSettings 继续经原有 IPC／HTTP 路由写电脑，不在客户端截留保存。设置恢复预览标明全局范围，前端管理的共享主题和隐私项同样等待持久化结果再确认恢复成功。
网页通知的保存开关与操作系统授权结果分别处理；授权拒绝只反馈当前浏览器状态，不把共享开关改回关闭。

## 迁移、恢复与草稿

桌面从启用前的 localStorage 快照补充缺失共享字段；Web 直接采用共享值，忽略旧外观差异和旧覆盖记录，不把启动后回填的默认值误当用户设置。
账号通用偏好首次迁移保留显式全局字段，以当前账号初始化其余字段；判断原始键是否存在，不使用读回默认值判断。安装清单跨账号去重合并，自定义背景按内容标识保存到 `config/appearance`。旧偏好及来源写入 `config/migrations/shared-preferences-v1-<hash>.json`，不复制账号票据、密钥和业务内容；全局配置与完成标记在同一次原子提交中保存，失败不标记完成。回执按内容命名，重试不覆盖不同旧值的记录；原迁移输入不在此阶段删除。同号旧置顶及草稿恢复快照只分配给首个实际配置，不复制到后续同号数据源。
新共享设置备份位于 `settings/app.json`，助手配置与外部 MCP 位于 `api/settings.json` 的 `sharedAssistant`，背景资产位于 `settings/background`；账号包只保存对象规则、数据源配置与业务状态，不重复保存通用偏好。继续读取旧 `settings/shared.json`，但恢复写入全局配置而非恢复旧存储；仅恢复账号不会导入旧账号的通用偏好。显式恢复和恢复默认推进设置修订号，默认操作也阻止旧端再次 seed。
旧主题备份通过恢复回执接入共享字段，不重新建立独立主题来源。

草稿保存使用预期版本；成功、清稿和删除均产生新版本。助手与合成记录复用既有业务存储，列表变化经同一订阅通知。
聊天保存先重读实际 QQ 草稿，与共享版本比较；同一份草稿的 WeQ 保存请求串行，QQ 写入失败不确认恢复快照。
实际写行再以原 BLOB 为 SQL 条件，更新／删除只命中未变化的原行，原本不存在时使用条件插入，不用整行无条件覆盖。SQL 通过真实明文 SQLite 夹具验证；与 QQ 原生进程的长期竞争及列表时间镜像仍需真机验证。
相同内容的重复保存直接确认当前版本，不重复写入或发布事件。同一客户端、账号与草稿的保存串行接续版本；聊天、助手与合成记录草稿发生真实内容冲突时，以读到的版本重试本机稿，不另存副本或弹出选稿确认。持续竞争时退避继续，不要求用户协调版本；账号切换时不继续覆盖。
渲染层自动保存位于 `lib/draftPersistence.ts`，保留保存排队、版本协调及账号绑定检查。草稿副本界面、状态及查询接口已移除，服务端拒绝写入旧 `copy:` 键；读取账号状态时幂等清理旧键、容量记录与对应分文件，兼容内联存储及旧备份恢复，不扫描其他文件或修改本机恢复快照。
内联图片共享复用 pickedFile 分段接收，转存到账号 `draft-media` 内容寻址目录后才写 QQ 草稿；重读时只为当前账号目录中的持久路径恢复资源登记。退出阶段无法等待上传的图片保留本机恢复快照，不写一份丢素材的共享稿。

## 针对性验证

- service 的 client_state、settings_changes、backup_accounts、backup_client、backup_restore 测试覆盖持久化、失败通知、外部草稿变化、并发版本、旧备份和恢复事务。
- desktop 的 client_preferences_sync、client_state_router 及 composer_draft_recovery 测试覆盖独立存储共用设置、桌面补缺、手机旧差异不生效、账号隔离、离线显式重试及旧快照迁移。
- `node apps/desktop/test/browser/run-client-sync.mjs` 使用真实 Electron 渲染器与两个独立浏览器上下文，复用产品路由、HTTP／WebSocket 与合成账号，不访问真实 QQ。Electron 场景使用测试 HTTP 适配，不将它冒称 IPC 全链路验收。
- 浏览器依赖可通过 `WEQ_PLAYWRIGHT_IMPORT`、`WEQ_BROWSER_EXECUTABLE` 复用；截图位置由 `WEQ_SYNC_ARTIFACTS` 指定。测试关闭自己创建的进程和浏览器。

合成测试、类型检查与截图不等于已安装版本、真机 QQ、手机素材上传或长期性能验收。
