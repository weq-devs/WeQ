# 宿主性能监视

## 结构与生命周期

`@weq/service/performance` 提供宿主唯一的 `PerformanceMonitor`、设置状态机和有界写队列；`performance-node` 提供 Node 采集器。桌面适配器使用 Electron 进程指标与主窗口 preload，独立 Web 服务使用 Node 采集器。共享顶层 `performanceMonitor` tRPC 路由不依赖账号，远程页面也不另起采集器。

设置、样本、事件版本均为 1。默认轻量、七天、128 MiB。完整档截止时间保存为毫秒时间戳；启动及到期时转换为轻量，设置失败也不允许到期完整采集无限延续。关闭会停采样与事件循环探针，但保留分钟级历史维护。旧开发日志运行入口已被替换，独立消息性能测试探针未改。

SQLite 在自包含 Worker 中运行。消息串行处理，避免让步清理期间穿插事务。样本表保存固定数值与分类明细，数值投影表提供按时间、进程和 segment 分桶的 min/max/avg；详情保留原始采样。进程身份包含 PID 与创建时间，segment 在宿主启动、档位切换、长采样缺口时变化。

保持项目 Node 22.12 最低版本：仅在 Node 22.12／23.0–23.3 的 Worker 启动参数中补充 `--experimental-sqlite`，其他版本沿用默认参数；导出使用每批 200 条的时间／ID 游标，不依赖 22.13 新增的 `StatementSync.iterate()`。依据 [Node 22.13 发布记录](https://nodejs.org/en/blog/release/v22.13.0)核验开关移除与迭代 API 的版本，不提高项目最低版本。

## 开销与容量

- 轻量不扫描 DOM、动画、样式和 QueryClient 数据，仅取低成本进程指标及受管缓存计数。
- 完整 DOM 分类按类别与 4ms 预算分批让步，首次及后续批次优先等待浏览器空闲（最长等待 50ms），缺少 idle API 时让出至下一任务；单个浏览器调用不能抢占，中途超预算会计入耗时。详细同步合计超过 16ms 时退避至 120 秒，保持五分钟后再评估。
- 采样不重叠，休眠不补采。主进程记录等待回应耗时，preload 的分批与异步等待不当作同步阻塞；完整进程采样也纳入同步耗时。
- 写队列最多 120 条，每十秒批量提交；满时删除最旧待写条并增加丢弃计数。写入失败丢弃失败批次并标错，至少一分钟后重试，不无限重放。
- 按时间和实际数据库／WAL／SHM 文件大小清理，使用 90% 容量作为维护目标预留写入空间，删除分批并执行 checkpoint 和 incremental vacuum。正常退出最多等待 1.5 秒刷盘；异常退出可能缺少最后一批。
- 请求聚合不记录调用参数、路由明细和账号，排除性能监视自身请求。数据库仅取固定统计摘要，不保存 SQL 或调试 trace。

CPU 使用累计 CPU 时间差除以墙钟差和逻辑核数量；Node 与 Electron 使用相同分母。Electron 无累计时间时不把不明口径的返回值当作统一 CPU。堆统计按 Electron API 的 KB 转成 bytes。参考 [CPUUsage](https://www.electronjs.org/docs/latest/api/structures/cpu-usage/) 与 [ProcessMemoryInfo](https://www.electronjs.org/docs/latest/api/structures/process-memory-info/)。

## 接口与界面

路由提供 `status/configure/history/detail/exportPage/export/clear`。查询边界校验时间范围与分桶数（最多 1200）；分页读取每页最多 200 条。正式文件导出在单条 Worker 命令内逐行读取、写入，与清空和维护串行，不把整份历史装入主进程内存，也不混合清空前后数据。CSV 与当前图表过滤、分桶保持一致。单次图表最多返回 8000 点，超限明确提示缩小范围；CSV 超限拒绝输出残缺文件，JSONL 原始导出不受图表点数限制。文件独占创建，超过 25 秒或失败时清理本次未完成导出，不覆盖不同内容同名文件。

设置页按活动状态与文档可见性启停请求，只在跟随最新时定期更新时间范围；图表使用现有 D3，按容器宽度分桶，加载页面采用独立 lazy chunk。缺测不补零，不跨 segment 连线；单点仍展示峰值范围，详情指向桶内最后一条采样。

## 针对性验证入口

- `pnpm --filter @weq/service exec vitest run test/performance_monitor.test.ts`
- `pnpm --filter @weq/desktop exec vitest run test/performance_sampling.test.ts test/performance_monitor_router.test.ts`
- `node apps/desktop/test/browser/run-performance-monitor.mjs`：浏览器交互与主题断点夹具。
- `node apps/desktop/test/browser/run-performance-electron.mjs`：独立临时 profile，真实 Electron 主进程、Worker、preload 和实际 ChatPane；使用合成消息及已缓存气泡，检查真实消息首帧、滚动与输入的关闭／轻量／完整对照，不加载日常 QQ 数据。测量前预热，每档 40 轮，交错档位顺序；与应用相同地限制 React 开发轨道条目。只在该离线入口开启连续同步区间追踪，用共同时间轴关联长任务，同时保留未归因的原始长任务，不以总等待耗时或不同档位的长任务数量差直接认定采样造成阻塞。

浏览器脚本复用既有 `WEQ_PLAYWRIGHT_IMPORT`、`WEQ_BROWSER_EXECUTABLE`，产物可通过 `WEQ_PERFORMANCE_ARTIFACTS` 指定。脚本正常关闭自身浏览器／Electron，并清理临时 profile。合成性能对照不等于真实业务长测；发布前仍需真实大页面与长时间运行验证。
