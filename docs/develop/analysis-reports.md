# 持久分析报告

好友、群聊、群成员分析由账号级 `AnalysisReportsService` 执行。结果存放在宿主数据目录
`analysis-reports/<账号配置与账号的哈希>/reports.sqlite`，SQLite 读写和结果压缩在 worker
内执行，不属于普通临时缓存，不复制 QQ 数据库。

存储 Worker 使用独立 ESM 入口 `packages/service/src/account/analysis_reports_worker.mjs`，
桌面与 Web 构建均输出 `analysisReportsWorker.mjs`。桌面安装包将其放入真实的
`resources/out/main`，调用方通过 `resolveChildWorkerPath` 定位后传入服务，源码单测可直接加载源入口。
不要以函数 `toString()` 创建 eval Worker：打包器生成的依赖 helper 属于外层模块，无法随函数文本转移。
`apps/desktop/test/analysis_reports_worker.test.ts` 使用实际 Vite 打包后执行存取、重开与删除回归，
与直接运行源码的服务单测共同验证。

群报告按消息统计、入群批次、关系图三阶段保存，其他报告保存其统计阶段。失败或停止后保留
已完成阶段；新进程把运行中的记录恢复为待继续，打开报告或点击继续才接续。原生单次读取不能
抢占时，等待读取结束后丢弃迟到结果，不再启动后续阶段。

刷新或调整范围产生新的结果版本，计算成功前保留上一份成功结果。成功版本独立保存到
`result_versions`，可从报告的版本选择器读取，不随后续刷新覆盖。任务列表使用持久身份和
保存时间投影，已读结果不会因重启换 ID 而重复提醒。删除任务只隐藏任务；报告仍可从分析工具
的历史列表打开。删除报告独立确认，不删除聊天记录。报告没有自动淘汰期限。

`account.analysisReports` 提供 create、list、get、versions、version、resume、retry、revise、
cancel、remove、position、onChange。请求绑定 `expectedAccountConfigId + expectedAccountUin`。旧即时分析接口仍保留给
原有调用者，年度报告保持独立入口；图片导出继续使用可见报告已经取得的数据。
